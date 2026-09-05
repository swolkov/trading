import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { krakenConfigured, krakenOpenOrders, krakenCancelOrder, krakenPrivate, krakenPublic, getPairMeta } from "@/lib/kraken";
import {
  getKrakenMarginHealth,
  getKrakenMarginPositions,
  getKrakenOHLC,
  liquidationEstimate,
  syncKrakenTrades,
} from "@/lib/kraken-margin";
import { pairBase, publicPairFor } from "@/lib/kraken-pairs";
import { macroEventWindows } from "@/lib/macro-events";
import { MARGIN_USERREF, acquireCloseLock, botOwnership, releaseCloseLock } from "@/lib/margin-executor";
import { LIVE_MAX_HOLD_H, LIVE_STOP_DEFAULT_PCT, clampLiveStopFrac, failClosedOnEmptyPositions, fifoWouldHitManual, groupPositionsByOrder, managedStopTarget } from "@/lib/margin-live-risk";
import { applyReconcile, planReconcile } from "@/lib/margin-book";

// The margin guardian — runs every 5 minutes (vercel.json), 24/7.
//
// Spencer margin-trades by hand at up to 20x, where the liquidation line sits 3% away.
// This cron watches that line while he sleeps: it reads state and alerts, tracks the
// account drawdown circuit breaker, and reconciles the executor's OWN orders (cancels
// orphaned stops and stale unfilled entries — scoped strictly to MARGIN_USERREF, so it
// never touches a manual order). Kraken margin-calls at margin level 80%, liquidates at 40%.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Alert throttling: each alert key re-fires at most once per hour, EXCEPT "urgent"
// margin-level alerts which re-fire every run — you want to be nagged at 3am when a
// position is about to liquidate.
const REALERT_MS = 60 * 60 * 1000;
const STATE_KEY = "margin_watch_state";

type WatchState = {
  alerts: Record<string, string>;
  // txid → consecutive runs seen orphaned. A stop is only cancelled after TWO consecutive
  // sightings, so a single bad positions read can never strip protection off a live position.
  orphans?: Record<string, number>;
  // Last run's equity, to spot a capital flow (deposit/withdrawal) vs a trading drawdown.
  lastEquity?: number;
  // ordertxid → consecutive runs a naked position has been seen PAST its stop level. The
  // rescue stop goes on immediately; the market flatten waits for two sightings, so a
  // degraded read cannot realize a loss on a position that was actually fine.
  nakedBreached?: Record<string, number>;
  // ordertxid → the paper container's state for a bot position: 1R fixed at entry, the
  // best price reached (from completed 1-min bars), and the last bar scored — exactly the
  // shadow_peak / shadow_stop / shadow_seen_t trio the paper record persists.
  managed?: Record<string, { oneR: number; peak: number; seenT: number }>;
  // consecutive runs the order book read back EMPTY while bot positions existed. A rescue
  // stop on an empty read is placed only on the SECOND such run: a false-empty read with
  // the real attached stop resting at the same level would otherwise pair a reduce-only
  // stop with a non-reduce-only one that fire on the same tick.
  emptyOrdersStreak?: number;
};

async function cfg(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null);
  return row?.value ?? null;
}
async function cfgNum(key: string, fallback: number): Promise<number> {
  const raw = await cfg(key);
  if (raw == null || raw.trim() === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

// STRICT: a DB read failure must not read as "fresh state" — that state would then be
// SAVED, erasing the orphan counters, the managed-exit 1R/peak and the throttle memory.
// On a failure the run degrades to alerts-only (no reconciliation, no exit management,
// no save) and says so.
async function loadState(): Promise<{ state: WatchState; unreliable: boolean; corrupt: boolean }> {
  let row: { value: string } | null = null;
  try {
    row = await prisma.agentConfig.findUnique({ where: { key: STATE_KEY } });
  } catch {
    return { state: { alerts: {} }, unreliable: true, corrupt: false };
  }
  if (!row?.value) return { state: { alerts: {} }, unreliable: false, corrupt: false };
  try {
    const parsed = JSON.parse(row.value) as WatchState;
    if (!parsed || typeof parsed !== "object" || typeof parsed.alerts !== "object") throw new Error("bad shape");
    // Counters and managed values must be finite numbers — a corrupt "bad1" strike counter
    // would silently disable the breached-stop close forever.
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const nakedBreached: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed.nakedBreached ?? {})) { const n = num(v); if (n != null && n >= 0) nakedBreached[k] = Math.floor(n); }
    const orphans: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed.orphans ?? {})) { const n = num(v); if (n != null && n >= 0) orphans[k] = Math.floor(n); }
    const managed: NonNullable<WatchState["managed"]> = {};
    for (const [k, v] of Object.entries(parsed.managed ?? {})) {
      const m = v as { oneR?: unknown; peak?: unknown; seenT?: unknown };
      const oneR = num(m?.oneR), peak = num(m?.peak), seenT = num(m?.seenT);
      if (oneR != null && oneR > 0 && peak != null && peak > 0 && seenT != null) managed[k] = { oneR, peak, seenT };
    }
    return {
      state: { ...parsed, alerts: parsed.alerts ?? {}, nakedBreached, orphans, managed, emptyOrdersStreak: num(parsed.emptyOrdersStreak) ?? 0, lastEquity: num(parsed.lastEquity) ?? undefined },
      unreliable: false, corrupt: false,
    };
  } catch {
    // Corrupt JSON is NOT an outage: treating it as one would disable reconciliation and
    // the managed exit forever. Back the raw value up, start fresh, and shout.
    await prisma.agentConfig.upsert({
      where: { key: `${STATE_KEY}_corrupt_backup` },
      update: { value: row.value }, create: { key: `${STATE_KEY}_corrupt_backup`, value: row.value },
    }).catch(() => {});
    return { state: { alerts: {} }, unreliable: false, corrupt: true };
  }
}

async function saveState(state: WatchState): Promise<void> {
  // Prune throttle entries older than 7 days so per-position keys don't accumulate
  // forever inside one AgentConfig row.
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  for (const [k, v] of Object.entries(state.alerts)) {
    if (new Date(v).getTime() < cutoff) delete state.alerts[k];
  }
  const value = JSON.stringify(state);
  await prisma.agentConfig.upsert({
    where: { key: STATE_KEY },
    update: { value },
    create: { key: STATE_KEY, value },
  }).catch(() => {});
}

function shouldFire(state: WatchState, key: string, always = false): boolean {
  if (always) return true;
  const last = state.alerts[key];
  return !last || Date.now() - new Date(last).getTime() > REALERT_MS;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stamp = (key: string) =>
    prisma.agentConfig.upsert({
      where: { key },
      update: { value: new Date().toISOString() },
      create: { key, value: new Date().toISOString() },
    }).catch(() => {});

  await stamp("margin_watch_last_run");

  if (!krakenConfigured()) {
    return Response.json({ ok: true, note: "kraken not configured" });
  }

  const sent: string[] = [];
  const errors: string[] = [];
  const { state, unreliable: stateUnreliable, corrupt: stateCorrupt } = await loadState();
  if (stateUnreliable) errors.push("guardian state unreadable — alerts only this run (no reconciliation, no managed exit, no save)");
  if (stateCorrupt) {
    await sendNotification("🚨 margin_watch_state was CORRUPT and has been reset (raw value saved to margin_watch_state_corrupt_backup). Orphan counters and managed-exit 1R/peak restart from the resting stops.", "margin_urgent").catch(() => {});
    errors.push("guardian state was corrupt — reset");
  }

  // 1) Keep the trade history topped up (incremental — stops at the first fully-known page).
  try {
    await syncKrakenTrades(false);
    await stamp("margin_trades_synced_at");
  } catch (e) {
    errors.push(`trade sync: ${e}`);
  }

  // 2) Margin level vs the call/liquidation lines, + the account drawdown circuit breaker.
  let flat = true;
  let marginUsedNow: number | null = null;   // hoisted so 3b can sanity-check an empty positions read
  try {
    const health = await getKrakenMarginHealth();
    // marginUsedRaw, not marginUsed: null means Kraken omitted the field (a degraded 200),
    // which must NOT read as "flat" — see the reconciler's unreliable-read guard below.
    marginUsedNow = health.marginUsedRaw;

    // Drawdown circuit breaker: track peak equity; if equity falls more than
    // kraken_margin_max_drawdown_pct from the peak, DISARM new entries (the executor
    // reads kraken_margin_disarmed_dd). Re-arm automatically once equity recovers to
    // within half the threshold. This is the account-level stop that prevents a bad run
    // from compounding — the single most important "not lose" guard.
    try { if (health.equity > 0) {
      const ddPct = Math.max(1, await cfgNum("kraken_margin_max_drawdown_pct", 15)) / 100;
      // STRICT read: a transient DB error here used to read as peak=0, and the next line
      // then overwrote the real peak with CURRENT equity — erasing the drawdown memory by
      // exactly the size of the drawdown. A read failure now skips the breaker for one run.
      const peakRow = await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_equity_peak" } });
      let peak = peakRow?.value ? parseFloat(peakRow.value) : 0;
      if (!Number.isFinite(peak) || peak < 0) throw new Error(`equity peak unreadable: ${peakRow?.value}`);
      // Capital-flow guard: a deposit/withdrawal moves equity without any trading P&L. Without
      // this, a withdrawal reads as a huge "drawdown" and disarms the breaker permanently (the
      // peak still includes the withdrawn cash, so it can never recover). REBASELINE the peak on
      // a >30% single-run equity swing — but ONLY when FLAT (marginUsed≈0). While holding a
      // position a swing that large is trading P&L, not a flow (1.5% adverse at 20x = 30% equity
      // in one run); masking THAT would defeat the breaker mid-crash and could even re-arm it.
      // marginUsedNow == null (health unreadable) → don't rebaseline, can't tell.
      const flatNow = marginUsedNow != null && marginUsedNow < 1;
      if (flatNow && state.lastEquity && state.lastEquity > 0) {
        const jump = (health.equity - state.lastEquity) / state.lastEquity;
        if (jump > 0.30) {
          // A large UPWARD step while flat is a deposit: SHIFT the peak by the same dollars so
          // the breaker keeps measuring trading, not cash flow — and never forgets an
          // existing drawdown (a deposit under the peak does not make the loss go away).
          peak = Math.max(peak + (health.equity - state.lastEquity), health.equity);
          await prisma.agentConfig.upsert({
            where: { key: "kraken_margin_equity_peak" },
            update: { value: String(peak) }, create: { key: "kraken_margin_equity_peak", value: String(peak) },
          }).catch(() => {});
          sent.push("dd-peak-rebaselined (deposit)");
        } else if (jump < -0.30 && shouldFire(state, "dd-drop-while-flat")) {
          // A large DOWNWARD step while flat could be a withdrawal — or positions that were
          // liquidated between two runs. "Flat now" does not prove which. Never erase a loss:
          // the breaker is allowed to trip; a withdrawal is cleared by hand.
          await sendNotification(`🟡 Equity fell ${(Math.abs(jump) * 100).toFixed(0)}% between runs while flat ($${state.lastEquity.toFixed(0)} → $${health.equity.toFixed(0)}). If this was a WITHDRAWAL, set kraken_margin_equity_peak=${health.equity.toFixed(0)} and kraken_margin_disarmed_dd=false by hand; otherwise the drawdown breaker stands.`, "margin_urgent").catch(() => {});
          state.alerts["dd-drop-while-flat"] = new Date().toISOString();
        }
      }
      state.lastEquity = health.equity;
      if (health.equity > peak) {
        peak = health.equity;
        await prisma.agentConfig.upsert({
          where: { key: "kraken_margin_equity_peak" },
          update: { value: String(peak) },
          create: { key: "kraken_margin_equity_peak", value: String(peak) },
        }).catch(() => {});
      }
      const dd = peak > 0 ? (peak - health.equity) / peak : 0;
      const disarmed = (await cfg("kraken_margin_disarmed_dd")) === "true";
      if (!disarmed && dd >= ddPct) {
        await prisma.agentConfig.upsert({
          where: { key: "kraken_margin_disarmed_dd" }, update: { value: "true" }, create: { key: "kraken_margin_disarmed_dd", value: "true" },
        }).catch(() => {});
        await sendNotification(
          `🛑 DRAWDOWN CIRCUIT BREAKER — equity $${health.equity.toFixed(0)} is ${(dd * 100).toFixed(1)}% below peak $${peak.toFixed(0)} (limit ${(ddPct * 100).toFixed(0)}%). Auto-entries HALTED. Closes still allowed. Re-arms when recovered.`,
          "margin_urgent",
        );
        sent.push("dd-breaker-tripped");
      } else if (disarmed && dd < ddPct / 2) {
        // AUTO-RE-ARM IS OPT-IN. A breaker trip means the account lost 15% — the one moment
        // that most deserves a human asking "why". Silently resuming once equity drifts
        // back to −7.5% resumes trading a strategy that may simply be broken, with no one
        // having looked. Default is to stay disarmed and tell Spencer it is his call.
        const autoRearm = (await cfg("kraken_margin_dd_auto_rearm")) === "true";
        if (autoRearm) {
          await prisma.agentConfig.upsert({
            where: { key: "kraken_margin_disarmed_dd" }, update: { value: "false" }, create: { key: "kraken_margin_disarmed_dd", value: "false" },
          }).catch(() => {});
          await sendNotification(`✅ Drawdown recovered — equity $${health.equity.toFixed(0)}, ${(dd * 100).toFixed(1)}% below peak. Auto-entries RE-ARMED (auto_rearm on).`, "margin_urgent");
          sent.push("dd-breaker-rearmed");
        } else if (shouldFire(state, "dd-rearm-ready")) {
          await sendNotification(
            `🟡 Drawdown recovered — equity $${health.equity.toFixed(0)}, ${(dd * 100).toFixed(1)}% below peak. Entries stay HALTED pending your review: work out why the breaker tripped, then set kraken_margin_disarmed_dd=false to resume.`,
            "margin_urgent",
          );
          state.alerts["dd-rearm-ready"] = new Date().toISOString();
          sent.push("dd-rearm-ready-notified");
        }
      }
    }

    } catch (e) { errors.push(`dd breaker: ${e}`); }

    if (health.marginLevel != null) {
      flat = false;
      const ml = health.marginLevel;
      if (ml < 100) {
        // Below 100% the account is losing posted margin; 80% is Kraken's margin call.
        const key = "ml-urgent";
        if (shouldFire(state, key, true)) {
          await sendNotification(
            `🚨 MARGIN URGENT — margin level ${ml.toFixed(0)}% (Kraken calls at 80%, LIQUIDATES at 40%). ` +
            `Equity $${health.equity.toFixed(0)}, margin used $${health.marginUsed.toFixed(0)}. Reduce now.`,
            "margin_urgent",
          );
          state.alerts[key] = new Date().toISOString();
          sent.push(key);
        }
      } else if (ml < 150) {
        const key = "ml-warn";
        if (shouldFire(state, key)) {
          await sendNotification(
            `⚠️ Margin level ${ml.toFixed(0)}% — getting close to the 80% margin-call line. ` +
            `Equity $${health.equity.toFixed(0)}, free margin $${health.freeMargin.toFixed(0)}.`,
            "margin_urgent",
          );
          state.alerts[key] = new Date().toISOString();
          sent.push(key);
        }
      }
    }
  } catch (e) {
    errors.push(`health: ${e}`);
  }

  // 3) Per-position liquidation distance (an ESTIMATE — account margin level above is
  //    the authoritative trigger). Warns hourly at half the cushion gone and again at
  //    three quarters; a position we cannot price is an ERROR, not a silent skip.
  try {
    const positions = await getKrakenMarginPositions();
    flat = flat && positions.length === 0;
    if (positions.length) {
      const { krakenPublic } = await import("@/lib/kraken");
      const { publicPairFor } = await import("@/lib/kraken-pairs");
      let tick: Record<string, unknown> = {};
      // Venue-suffixed position pairs (XBTUSD:BTNL) must be priced via public pairs.
      try { tick = await krakenPublic("Ticker", { pair: [...new Set(positions.map((p) => publicPairFor(p.pair)))].join(",") }); } catch { tick = {}; }
      for (const p of positions) {
        const t = Object.entries(tick).find(([k]) => k === p.pair || pairBase(k) === pairBase(p.pair))?.[1] as { c?: string[] } | undefined;
        const px = t?.c?.[0] ? parseFloat(t.c[0]) : null;
        if (!px) { errors.push(`unable to price position ${p.pair} (${p.id})`); continue; }
        const { liqPrice, pctAway } = liquidationEstimate(p, px);
        const cushion = 0.6 / Math.max(1, p.leverage);   // full cushion at entry
        const used = 1 - pctAway / cushion;              // fraction of cushion consumed
        if (used >= 0.75) {
          const key = `liq-urgent-${p.id}`;
          if (shouldFire(state, key)) {
            await sendNotification(
              `🚨 ${p.pair} ${p.side.toUpperCase()} ${p.leverage.toFixed(0)}x — est. ${(pctAway * 100).toFixed(1)}% from liquidation (~$${liqPrice.toFixed(2)}, now $${px.toFixed(2)}). Account margin level is the hard number — check the cockpit.`,
              "margin_urgent",
            );
            state.alerts[key] = new Date().toISOString();
            sent.push(key);
          }
        } else if (used >= 0.5) {
          const key = `liq-warn-${p.id}`;
          if (shouldFire(state, key)) {
            await sendNotification(
              `⚠️ ${p.pair} ${p.side.toUpperCase()} ${p.leverage.toFixed(0)}x has used ${(used * 100).toFixed(0)}% of its cushion — liquidation $${liqPrice.toFixed(2)}, price $${px.toFixed(2)} (${(pctAway * 100).toFixed(1)}% away).`,
              "margin_urgent",
            );
            state.alerts[key] = new Date().toISOString();
            sent.push(key);
          }
        }
      }
    }
  } catch (e) {
    errors.push(`positions: ${e}`);
  }

  // 3b) Reconcile the EXECUTOR's own orders (scoped strictly to MARGIN_USERREF — manual
  //     orders are never touched). Two hazards this closes:
  //       • ORPHAN STOP — Spencer closes a position by hand; its attached stop lingers as
  //         a live order that could OPEN a fresh opposite position when triggered. Cancel
  //         any of our stop orders with no matching open position.
  //       • STALE ENTRY — a post-only limit entry that never filled. Cancel ours older
  //         than kraken_margin_stale_entry_min so cash/intent isn't left dangling.
  try {
    if (stateUnreliable) throw new Error("skip: state unreadable");
    const orders = await krakenOpenOrders();
    const mine = orders.filter((o) => o.userref === MARGIN_USERREF);
    if (mine.length) {
      const positions = await getKrakenMarginPositions();
      // SAFETY: getKrakenMarginPositions returns [] for an empty result, and Kraken can return
      // an empty OpenPositions during degradation — indistinguishable from a genuinely flat
      // account. If we treated that as flat, EVERY stop would look orphaned and get cancelled,
      // leaving a live 20x position naked ~3% from liquidation. So if positions came back empty
      // but we still hold margin (marginUsed > 0), the read is unreliable — skip STOP
      // reconciliation entirely this run (stale-entry cleanup keys off order age, not positions,
      // so it's still safe). Belt-and-suspenders below: a stop is only cancelled after being
      // seen orphaned on TWO consecutive runs.
      // If margin health couldn't be read at all (marginUsedNow == null — a correlated Kraken
      // outage that empties OpenPositions will often also break TradeBalance), don't trust an
      // empty positions read either: fail closed. A genuinely-flat account just waits one run.
      const positionsUnreliable = positions.length === 0 && (marginUsedNow == null || marginUsedNow > 0);
      if (positionsUnreliable) errors.push("orphan reconcile: positions empty but margin in use — skipping stop cleanup (unreliable read)");
      // A protective stop is only valid if it CLOSES a live position: a sell-stop
      // protects a long, a buy-stop protects a short. Matching on pair alone would keep
      // an old long's sell-stop alive after a manual close even when a NEW short exists —
      // and that stray sell-stop would then ADD to the short if it triggered.
      const stopProtectsLive = (o: { pair: string; side: string }) => positions.some((p) =>
        pairBase(p.pair) === pairBase(o.pair) &&
        ((o.side === "sell" && p.side === "long") || (o.side === "buy" && p.side === "short")));
      const staleMin = Math.max(5, await cfgNum("kraken_margin_stale_entry_min", 30));
      const nowSec = Date.now() / 1000;
      const priorOrphans = state.orphans ?? {};
      const nextOrphans: Record<string, number> = {};
      // Pair+sides that carried a bot book on the LAST run: a stop of ours resting there with
      // no position now is a book that just flattened — its attached close[] stop is not
      // reduce-only and must not wait two sightings. (Positions read is reliable here.)
      const hadBookLastRun = new Set(Object.keys(state.managed ?? {}).map((k) => k.split("|").slice(0, 2).join("|")));
      for (const o of mine) {
        const isStop = o.ordertype.includes("stop");
        const isEntry = o.ordertype === "limit" || o.ordertype === "market";
        if (isStop) {
          if (positionsUnreliable) continue;              // never touch stops on a bad read
          if (!stopProtectsLive(o)) {
            const seen = (priorOrphans[o.txid] ?? 0) + 1;  // this run's sighting
            const justFlattened = hadBookLastRun.has(`${pairBase(o.pair)}|${o.side === "sell" ? "long" : "short"}`);
            if (seen >= 2 || justFlattened) {
              try { await krakenCancelOrder(o.txid); sent.push(`orphan-stop-cancelled-${o.pair}`); } catch { /* already gone */ }
            } else {
              nextOrphans[o.txid] = seen;                  // first sighting — wait for confirmation next run
            }
          }
          // a stop that protects a live position is not orphaned → its count resets (dropped from nextOrphans)
        } else if (isEntry && (nowSec - o.opentm) > staleMin * 60) {
          try { await krakenCancelOrder(o.txid); sent.push(`stale-entry-cancelled-${o.pair}`); } catch { /* already gone */ }
        }
      }
      state.orphans = nextOrphans;
    } else {
      state.orphans = {};   // no orders of ours → nothing pending
    }
  } catch (e) {
    if (!String(e).includes("skip: state unreadable")) errors.push(`order reconcile: ${e}`);
  }

  // 3c) PROTECT + MANAGED EXIT — position → stop, the direction that actually protects
  // money, applied to every position WE opened (ledger ∪ adopted; Spencer's hand-opened
  // positions are never touched). Kraken attaches stops to a PAIR and SIDE, nets closes
  // FIFO, can partially fill a market close, and its attached close[] stop is NOT
  // reduce-only — so every decision here is made from what is actually OPEN and RESTING,
  // through one tested primitive (margin-book.ts planReconcile/applyReconcile) whose
  // invariant is: exactly one full-volume reduce-only stop at the managed level, nothing
  // else of ours on the pair+side; zero exposure → nothing of ours resting at all.
  // All bot exposure on a pair+side is ONE BOOK. Per book, each run:
  //   1. TIME STOP — paper's 48h rule on the oldest tranche: reduce-only market close, then
  //      RECONCILE from the remaining exposure (a partial fill keeps exact cover).
  //   2. PAST THE MANAGED STOP — price beyond paper's exit: close on two consecutive
  //      sightings; meanwhile cover at a guard level just beyond the market.
  //   3. RECONCILE — the managed level (paper's ratchet: once +1R breakeven, then 1R behind
  //      the peak; single-order books only — a stacked book keeps its best resting level).
  // FIFO: an OLDER manual position on the same pair+side means a close would reduce it
  // first — closes are refused and paged; protective stops are still kept (the account is
  // protected; the page says Kraken would reduce the manual position first).
  // State (1R, peak, strikes) is keyed by the book's exact ORDER SET, so a new trade on the
  // same pair can never inherit the previous trade's peak or strikes.
  let protectOk = false;
  try {
    if (stateUnreliable) throw new Error("skip: state unreadable");
    const ownership = await botOwnership();
    if (ownership.ledgerCorrupt && shouldFire(state, "ledger-corrupt")) {
      await sendNotification(`🚨 kraken_margin_bot_txids is CORRUPT (unparseable). Positions recorded only there are NOT being protected or managed. Repair it, or adopt them via kraken_margin_adopt_txids.`, "margin_urgent").catch(() => {});
      state.alerts["ledger-corrupt"] = new Date().toISOString();
    }
    const positionsAll = await getKrakenMarginPositions();
    const positionsUnreliable = positionsAll.length === 0 && (marginUsedNow == null || marginUsedNow > 0);
    const managedPrev = state.managed ?? {};
    const managedNext: NonNullable<WatchState["managed"]> = {};
    const priorBreached = state.nakedBreached ?? {};
    const nextBreached: Record<string, number> = {};
    if (positionsUnreliable) {
      Object.assign(managedNext, managedPrev);
      Object.assign(nextBreached, priorBreached);
      errors.push("protect/exit: positions empty but margin in use — skipping (unreliable read)");
    } else {
      const isOursLoose = (p: { pair: string; side: string; openedAt: string }) => ownership.isOurs(p as unknown as { ordertxid: string; id: string });
      const samePair = (a: string, b: string) => pairBase(a) === pairBase(b);
      const orderGroups = groupPositionsByOrder(positionsAll.filter(ownership.isOurs));
      const books = new Map<string, typeof orderGroups>();
      for (const g of orderGroups) { const k = `${pairBase(g.pair)}|${g.side}`; (books.get(k) ?? books.set(k, []).get(k)!).push(g); }
      let orders = books.size ? await krakenOpenOrders() : [];
      // An account with no resting orders is this account's NORMAL state, and a bot position
      // that lost its stop is exactly what produces "positions, no orders" — so an empty read
      // never skips protection. It withholds the actions a BAD read must never trigger
      // (market closes, and a rescue beside a possibly-hidden attached stop) until a
      // SECOND consecutive empty read confirms the book really is empty.
      const ordersUnreliable = books.size > 0 && orders.length === 0;
      state.emptyOrdersStreak = ordersUnreliable ? (state.emptyOrdersStreak ?? 0) + 1 : 0;
      const bookConfirmedEmpty = ordersUnreliable && (state.emptyOrdersStreak ?? 0) >= 2;
      const withhold = ordersUnreliable && !bookConfirmedEmpty;
      if (ordersUnreliable) errors.push(`protect/exit: zero open orders while holding bot positions (streak ${state.emptyOrdersStreak}) — ${bookConfirmedEmpty ? "book confirmed empty, protecting" : "withholding orders until confirmed"}`);
      const stopCfgPct = await cfgNum("kraken_margin_stop_pct", LIVE_STOP_DEFAULT_PCT);
      const maxHoldH = Math.max(1, await cfgNum("kraken_margin_max_hold_h", LIVE_MAX_HOLD_H));
      let allCovered = !withhold;

      for (const [bookKey, grp] of books) {
        const stateKey = `${bookKey}|${grp.map((g) => g.ordertxid).sort().join("+")}`;
        try {
        const side = grp[0].side;
        const pairRaw = grp[0].pair;
        const vol = grp.reduce((s, g) => s + g.vol, 0);
        const entryPrice = vol > 0 ? grp.reduce((s, g) => s + g.entryPrice * g.vol, 0) / vol : grp[0].entryPrice;
        const leverage = Math.max(...grp.map((g) => g.leverage));
        const stacked = grp.length > 1;
        const openedTimes = grp.map((g) => new Date(g.openedAt).getTime());
        const oldestMs = openedTimes.every(Number.isFinite) ? Math.min(...openedTimes) : NaN;
        const newestOpenedAt = grp.every((g) => g.newestOpenedAt) ? grp.map((g) => g.newestOpenedAt).sort()[grp.length - 1] : "";
        const ageMs = Number.isFinite(oldestMs) ? Date.now() - oldestMs : Infinity;
        const youngestAgeMs = openedTimes.every(Number.isFinite) ? Date.now() - Math.max(...openedTimes) : Infinity;
        // GRACE: Kraken submits the attached close[] only after the fill.
        if (youngestAgeMs < 6 * 60_000) {
          if (managedPrev[stateKey]) managedNext[stateKey] = managedPrev[stateKey];
          if (priorBreached[stateKey]) nextBreached[stateKey] = priorBreached[stateKey];
          continue;
        }
        const publicPair = publicPairFor(pairRaw);
        const meta = await getPairMeta(publicPair);
        const closeSide = side === "long" ? "sell" : "buy";
        const lev = String(Math.max(2, Math.round(leverage)));
        const ourStopsOnBook = () => orders.filter((o) => o.userref === MARGIN_USERREF && o.ordertype.includes("stop") && samePair(o.pair, pairRaw) && o.side === closeSide);
        const fifoBlocked = fifoWouldHitManual({ pair: pairRaw, side, openedAt: newestOpenedAt }, positionsAll, isOursLoose, samePair);
        const fifoNote = fifoBlocked ? " ⚠️ an OLDER manual position sits on this pair+side: Kraken reduces it FIRST when any of these orders fire — close it by hand." : "";

        // Price + peak from COMPLETED 1-minute bars since the last scored bar (paper's walk).
        const prev = managedPrev[stateKey];
        const sinceS = Math.max(prev?.seenT ?? 0, Number.isFinite(oldestMs) ? Math.floor(oldestMs / 1000) : 0);
        let bars: { t: number; h: number; l: number; c: number }[] = [];
        try {
          let cursor = sinceS - 60;
          for (let i = 0; i < 6; i++) {
            const page = await getKrakenOHLC(publicPair, 1, cursor);
            bars.push(...page);
            if (page.length < 700) break;
            cursor = page[page.length - 1].t;
          }
        } catch { bars = []; }
        bars = bars.filter((b) => b.t >= sinceS).sort((a, b) => a.t - b.t);
        bars = bars.filter((b, i) => i === bars.length - 1 || bars[i + 1].t !== b.t);
        if (bars.length && sinceS > 0 && bars[0].t > sinceS + 180) errors.push(`${pairRaw}: 1-min history gap ${((bars[0].t - sinceS) / 3600).toFixed(1)}h — peak may be under-counted`);
        const done = bars.slice(0, -1);
        let peak = prev?.peak ?? entryPrice;
        for (const b of done) peak = side === "long" ? Math.max(peak, b.h) : Math.min(peak, b.l);
        const seenT = done.length ? done[done.length - 1].t : (prev?.seenT ?? sinceS);
        let px = bars.length ? bars[bars.length - 1].c : 0;
        if (!(px > 0)) {
          try {
            const tick = await krakenPublic("Ticker", { pair: publicPair });
            px = parseFloat(((Object.values(tick)[0] as { c?: string[] })?.c?.[0]) ?? "0");
          } catch { px = 0; }
        }
        // 1R: the ledger's authorised stop distance per order (cannot have been ratcheted),
        // else the signed resting distance (single-order books), else the shared clamp.
        let oneR = prev?.oneR ?? 0;
        if (!(oneR > 0)) {
          const perOrder = grp.map((g) => { const f = ownership.stopFracOf(g.ordertxid); return f && f > 0 ? g.entryPrice * f : 0; }).filter((x) => x > 0);
          if (perOrder.length === grp.length) oneR = Math.min(...perOrder);
        }
        const fixedNow = ourStopsOnBook().filter((o) => o.ordertype === "stop-loss" && o.price > 0);
        if (!(oneR > 0) && !stacked && fixedNow.length) {
          const restingDist = side === "long" ? entryPrice - Math.min(...fixedNow.map((o) => o.price)) : Math.max(...fixedNow.map((o) => o.price)) - entryPrice;
          if (restingDist > 0 && restingDist / entryPrice >= 0.001 && restingDist / entryPrice <= 0.5) oneR = restingDist;
        }
        if (!(oneR > 0)) oneR = entryPrice * clampLiveStopFrac(stopCfgPct, leverage);
        managedNext[stateKey] = { oneR, peak, seenT };
        const initialStop = side === "long" ? entryPrice - oneR : entryPrice + oneR;
        const bestResting = fixedNow.length ? (side === "long" ? Math.max(...fixedNow.map((o) => o.price)) : Math.min(...fixedNow.map((o) => o.price))) : null;
        // The managed level is computed from the AUTHORISED stop and the peak — never from
        // whatever stop happens to be resting (a temporary breach guard must not become the
        // permanent target). The planner keeps a resting stop that is already better.
        const target = stacked ? initialStop : managedStopTarget(side, entryPrice, peak, initialStop, oneR);
        if (stacked && shouldFire(state, `stacked-${bookKey}`)) {
          await sendNotification(`⚠️ ${pairRaw} ${side}: ${grp.length} bot orders stacked on one pair+side — protected and time-stopped as one book, but NOT ratcheted (no single 1R). Avoid adopting or stacking on a pair the bot holds.`, "margin_urgent").catch(() => {});
          state.alerts[`stacked-${bookKey}`] = new Date().toISOString();
        }

        const io = {
          placeStop: async (level: string, volStr: string) => {
            const res = await krakenPrivate("AddOrder", { pair: publicPair, type: closeSide, ordertype: "stop-loss", price: level, volume: volStr, leverage: lev, reduce_only: "true", userref: String(MARGIN_USERREF) });
            return (res.txid as string[] | undefined)?.[0];
          },
          cancel: async (txid: string) => { await krakenCancelOrder(txid); orders = orders.filter((o) => o.txid !== txid); },
        };
        // Reconcile this book's cover to `wantVol` at `level`. Returns true when covered.
        const reconcile = async (wantVol: number, level: number, why: string): Promise<boolean> => {
          let plan = planReconcile({ side, vol: wantVol, targetLevel: level, px, priceDecimals: meta.priceDecimals, lotDecimals: meta.lotDecimals }, ourStopsOnBook());
          if (plan.blocked) {
            errors.push(`${pairRaw} (${why}): not acting — ${plan.blocked}`);
            if (/trailing/.test(plan.blocked) && shouldFire(state, `trail-${bookKey}`)) { await sendNotification(`🚨 ${pairRaw} ${side}: ${plan.blocked}. Fix the resting trailing stop(s) on Kraken by hand.`, "margin_urgent").catch(() => {}); state.alerts[`trail-${bookKey}`] = new Date().toISOString(); }
            return false;
          }
          if (withhold && (plan.place || plan.cancel.length)) { errors.push(`${pairRaw} (${why}): withholding stop changes on an unconfirmed empty book`); return false; }
          if (!plan.place && !plan.cancel.length) return plan.covered;
          // THE MANUAL-BOOK BOUNDARY: with an OLDER manual position on this pair+side, any exit
          // order of ours — a stop included — would reduce Spencer's position first when it
          // fires. No order is placed or moved; existing cover stays; page every run.
          if (fifoBlocked) {
            await sendNotification(`🚨 ${pairRaw} ${side}: bot position's cover NOT changed (${plan.reason}) — an OLDER manual position on the same side means any stop of ours would reduce YOUR position first (Kraken nets FIFO). Close the manual position by hand, or manage this one yourself.`, "margin_urgent").catch(() => {});
            errors.push(`${pairRaw}: fifo-blocked, cover left as is`);
            return false;
          }
          // Act on a FRESH volume, under the close lock: the snapshot is minutes old and a
          // webhook close may have flattened this book meanwhile.
          const lock = await acquireCloseLock(30_000);
          if (!lock) { errors.push(`${pairRaw} (${why}): close lock busy — retry next run`); return false; }
          let out;
          try {
            const fresh = await remainingVol();
            if (fresh == null) { errors.push(`${pairRaw} (${why}): could not confirm remaining exposure — not acting`); return false; }
            if (Math.abs(fresh - wantVol) > wantVol * 0.01) {
              plan = planReconcile({ side, vol: fresh, targetLevel: level, px, priceDecimals: meta.priceDecimals, lotDecimals: meta.lotDecimals }, ourStopsOnBook());
              if (plan.blocked) { errors.push(`${pairRaw} (${why}): not acting after re-read — ${plan.blocked}`); return false; }
            }
            out = await applyReconcile(plan, io);
          } finally { await releaseCloseLock(lock); }
          if (out.placed) { sent.push(`stop-${plan.reason.replace(/[^a-z]+/gi, "-").toLowerCase()}-${pairRaw}`); }
          if (out.placeFailed) {
            await sendNotification(`🚨🚨 COULD NOT PLACE PROTECTIVE STOP on ${pairRaw} ${side} (${why}): ${out.placeFailed}. Existing cover left as is — act manually on Kraken now.${fifoNote}`, "margin_urgent").catch(() => {});
            errors.push(`stop placement failed ${pairRaw}: ${out.placeFailed}`);
          }
          if (out.failedCancels.length) {
            await sendNotification(`🚨 ${pairRaw}: could NOT cancel stop(s) ${out.failedCancels.join(", ")} after ${why} (the attached close[] stop is not reduce-only — if two fire, the extra volume OPENS a position). Cancel them on Kraken now; the guardian retries in 5 min.`, "margin_urgent").catch(() => {});
          }
          if (plan.reason.startsWith("naked") || plan.reason.startsWith("replace") || plan.reason.startsWith("cover")) {
            await sendNotification(`🛡 ${pairRaw} ${side}: ${plan.reason} — ${plan.place ? `stop ${plan.place.vol} at $${plan.place.level}` : "cover adjusted"}${out.cancelled.length ? `, cancelled ${out.cancelled.length} other(s)` : ""}.${fifoNote}`, "margin_urgent").catch(() => {});
          }
          return out.covered && out.failedCancels.length === 0;
        };
        // Reliable remaining exposure for this book (null = cannot tell).
        // Reliable remaining exposure for this book (null = cannot tell). Retried: right
        // after a fill, OpenPositions and TradeBalance can disagree for a call or two.
        const remainingVol = async (): Promise<number | null> => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const health = await getKrakenMarginHealth().catch(() => null);
            const after = await getKrakenMarginPositions().catch(() => null);
            if (after != null && !failClosedOnEmptyPositions(after.length, health?.marginUsedRaw ?? null)) {
              return after.filter((p) => grp.some((g) => g.ordertxid === p.ordertxid) && p.side === side).reduce((s, p) => s + p.vol, 0);
            }
            await new Promise((r) => setTimeout(r, 2000));
          }
          return null;
        };
        // "closed" | "partial" (remainder re-covered here) | "refused" | "unconfirmed"
        const closeBook = async (why: string): Promise<"closed" | "partial" | "refused" | "unconfirmed"> => {
          if (fifoBlocked) {
            if (shouldFire(state, `fifo-${bookKey}`)) {
              await sendNotification(`🚨 ${why} on ${pairRaw} ${side} NOT executed — an OLDER manual position on the same side would be reduced first (Kraken nets FIFO). Close it by hand, or close the bot's ${vol.toFixed(meta.lotDecimals)} yourself.${fifoNote}`, "margin_urgent").catch(() => {});
              state.alerts[`fifo-${bookKey}`] = new Date().toISOString();
            }
            return "refused";
          }
          const lock = await acquireCloseLock(30_000);
          if (!lock) { errors.push(`${why} ${pairRaw}: close lock busy — retry next run`); return "unconfirmed"; }
          let sendErr: unknown = null;
          let sentVol = vol;
          try {
          // Fresh volume under the lock — a webhook close may have flattened this book since
          // the snapshot; a reduce-only order for a gone book would reduce the NEXT position.
          const freshVol = await remainingVol();
          if (freshVol == null) { errors.push(`${why} ${pairRaw}: could not confirm exposure before closing — not sent`); return "unconfirmed"; }
          if (freshVol <= 0) { delete managedNext[stateKey]; delete nextBreached[stateKey]; return "closed"; }
          sentVol = freshVol;
          try {
            await krakenPrivate("AddOrder", { pair: publicPair, type: closeSide, ordertype: "market", volume: sentVol.toFixed(meta.lotDecimals), leverage: lev, reduce_only: "true", userref: String(MARGIN_USERREF) });
          } catch (err) { sendErr = err; }
          // Whatever the response said, the truth is the remaining exposure. A partial fill
          // keeps exact cover; zero sweeps every stop of ours; an unreadable state leaves
          // everything as it was and pages.
          const left = await remainingVol();
          if (left == null) {
            await sendNotification(`🚨 ${why} on ${pairRaw}: close ${sendErr ? "errored" : "sent"} but the remaining position could not be confirmed — stops LEFT IN PLACE. Check Kraken now.${sendErr ? ` ${String(sendErr).slice(0, 120)}` : ""}`, "margin_urgent").catch(() => {});
            errors.push(`${why} ${pairRaw}: unconfirmed`);
            return "unconfirmed";
          }
          orders = await krakenOpenOrders().catch(() => orders);
          // Re-cover the remainder DIRECTLY (not via reconcile(): the lock is already held).
          const plan = planReconcile({ side, vol: left, targetLevel: bestResting ?? initialStop, px, priceDecimals: meta.priceDecimals, lotDecimals: meta.lotDecimals }, ourStopsOnBook());
          let covered = false;
          if (plan.blocked) errors.push(`${why} ${pairRaw}: remainder not re-covered — ${plan.blocked}`);
          else if (!plan.place && !plan.cancel.length) covered = plan.covered;
          else {
            const out = await applyReconcile(plan, io);
            covered = out.covered && out.failedCancels.length === 0;
            if (out.failedCancels.length) await sendNotification(`🚨 ${pairRaw}: could NOT cancel stop(s) ${out.failedCancels.join(", ")} after ${why}. Cancel them on Kraken now.`, "margin_urgent").catch(() => {});
          }
          if (left > 0) {
            await sendNotification(`⚠️ ${why} on ${pairRaw}: ${sentVol.toFixed(meta.lotDecimals)} sent, ${left} still open (partial fill${sendErr ? " / lost response" : ""}) — cover ${covered ? "re-set for the remainder" : "NOT confirmed"}. Retrying next run.`, "margin_urgent").catch(() => {});
            return "partial";
          }
          delete managedNext[stateKey];
          delete nextBreached[stateKey];
          await sendNotification(`⏱ ${why} — closed ${pairRaw} ${side} ${vol.toFixed(meta.lotDecimals)} (entry $${entryPrice.toFixed(meta.priceDecimals)}, now $${px > 0 ? px.toFixed(meta.priceDecimals) : "?"}, held ${Number.isFinite(ageMs) ? (ageMs / 3600_000).toFixed(0) : "?"}h).`, "margin_results").catch(() => {});
          sent.push(`${why.toLowerCase().replace(/[^a-z]+/g, "-")}-${pairRaw}`);
          return "closed";
          } finally { await releaseCloseLock(lock); }
        };
        const guardLevel = (): number => (side === "long" ? px * (1 - 0.002) : px * (1 + 0.002));

        // 1) TIME STOP (oldest tranche; only with a known open time).
        if (Number.isFinite(oldestMs) && ageMs >= maxHoldH * 3600_000) {
          if (withhold) { errors.push(`time stop due on ${pairRaw} but orders read empty — confirming next run`); allCovered = false; continue; }
          const r = await closeBook("Time stop");
          if (r === "closed") continue;
          if (r === "refused") { if (!(await reconcile(vol, target, "keep cover (close refused)"))) allCovered = false; }
          else allCovered = false;   // partial (remainder re-covered inside) or unconfirmed: not a clean run
          continue;
        }
        // 2) PAST THE MANAGED STOP — the exit paper would already have taken. Two sightings.
        const beyond = px > 0 && (side === "long" ? px <= target : px >= target);
        if (beyond) {
          const strikes = (priorBreached[stateKey] ?? 0) + 1;
          nextBreached[stateKey] = strikes;
          if (strikes >= 2 && !withhold) {
            const r = await closeBook("Managed stop breached");
            if (r === "closed") continue;
            if (r !== "refused") { allCovered = false; continue; }
          }
          // Cover at a guard level just beyond the market while confirming (or after a refusal).
          if (!(await reconcile(vol, guardLevel(), "guard cover while breached"))) allCovered = false;
          continue;
        }
        // 3) RECONCILE to the managed level (this IS the ratchet for single-order books).
        if (!(await reconcile(vol, target, "managed cover"))) allCovered = false;
        } catch (err) {
          allCovered = false;
          errors.push(`protect/exit ${bookKey}: ${String(err).slice(0, 120)}`);
          if (managedPrev[stateKey] && !managedNext[stateKey]) managedNext[stateKey] = managedPrev[stateKey];
          if (priorBreached[stateKey] && !nextBreached[stateKey]) nextBreached[stateKey] = priorBreached[stateKey];
        }
      }
      protectOk = allCovered;
    }
    state.nakedBreached = nextBreached;
    state.managed = managedNext;
  } catch (e) {
    if (!String(e).includes("skip: state unreadable")) errors.push(`protect/exit: ${e}`);
  }
  // The executor gates NEW entries on this stamp — proof that every bot book was verified
  // COVERED this run, not merely that the route was invoked.
  if (protectOk) await stamp("margin_watch_protect_ok");

  // 4) Fast-move heads-up on the majors (±3% in an hour) — only worth checking when
  //    positions are open or Spencer is actively trading; cheap either way (public data).
  try {
    for (const symbol of ["BTC/USD", "ETH/USD", "SOL/USD"]) {
      const bars = await getKrakenOHLC(symbol, 5);
      if (bars.length < 13) continue;
      const now = bars[bars.length - 1].c;
      const hourAgo = bars[bars.length - 13].c;   // 12 × 5m = 1h
      const move = (now - hourAgo) / hourAgo;
      if (Math.abs(move) >= 0.03) {
        const dir = move > 0 ? "up" : "down";
        const key = `move-${symbol}-${dir}`;
        if (shouldFire(state, key)) {
          await sendNotification(
            `${move > 0 ? "📈" : "📉"} ${symbol} ${dir} ${(move * 100).toFixed(1)}% in the last hour ($${now.toLocaleString()}).`,
            "margin_signals",
          );
          state.alerts[key] = new Date().toISOString();
          sent.push(key);
        }
      }
    }
  } catch (e) {
    errors.push(`fast-move: ${e}`);
  }

  // 5) Event guardrail: levered into a high-impact macro print within 24h → one warning.
  //    Imported directly — an HTTP round-trip to our own API would be rejected by the
  //    auth proxy and fail silently forever.
  if (!flat) {
    try {
      const { imminent } = macroEventWindows(new Date());
      for (const e of imminent) {
        const key = `event-${e.name}-${e.date}`;
        if (shouldFire(state, key)) {
          await sendNotification(
            `📅 Heads up: ${e.name} lands ${e.date} ${e.time} and you have margin positions open. That print can move more than a 20x cushion.`,
            "margin_urgent",
          );
          state.alerts[key] = new Date().toISOString();
          sent.push(key);
        }
      }
    } catch (e) {
      errors.push(`event guardrail: ${e}`);
    }
  }

  if (!stateUnreliable) await saveState(state);

  // Fail loudly: an unhealthy guardian is worse than none, because it feels like cover.
  if (errors.length) {
    console.error("[/api/cron/margin-watch]", errors);
    const key = "watch-errors";
    if (shouldFire(state, key)) {
      await sendNotification(`⚠️ margin-watch errors: ${errors.join(" | ").slice(0, 400)}`, "margin_urgent");
      state.alerts[key] = new Date().toISOString();
      if (!stateUnreliable) await saveState(state);
    }
  }

  return Response.json({ ok: errors.length === 0, flat, sent, errors });
}
