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
import { MARGIN_USERREF, botOwnership } from "@/lib/margin-executor";
import { LIVE_MAX_HOLD_H, LIVE_STOP_DEFAULT_PCT, clampLiveStopFrac, fifoWouldHitManual, groupPositionsByOrder, managedStopTarget, roundedStopIsSafe, stopNeedsRatchet } from "@/lib/margin-live-risk";

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
    return { state: JSON.parse(row.value) as WatchState, unreliable: false, corrupt: false };
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
          // A large UPWARD step while flat is a deposit: rebaseline so the breaker measures
          // trading, not cash flow.
          peak = health.equity;
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
      for (const o of mine) {
        const isStop = o.ordertype.includes("stop");
        const isEntry = o.ordertype === "limit" || o.ordertype === "market";
        if (isStop) {
          if (positionsUnreliable) continue;              // never touch stops on a bad read
          if (!stopProtectsLive(o)) {
            const seen = (priorOrphans[o.txid] ?? 0) + 1;  // this run's sighting
            if (seen >= 2) {
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
  // positions are never touched). Per ORDER (one order can fill in several tranches that
  // Kraken lists as separate positions sharing one ordertxid — treated as one), each run:
  //   0. DEDUPE — more than one of our stops covering the order: keep the best-priced (tie →
  //      newest), cancel the rest. The attached close[] stop is NOT reduce-only; left beside a
  //      reduce-only one it can fire second and OPEN a reverse position.
  //   1. TIME STOP — paper's 48h rule: reduce-only market close, then sweep its stops.
  //   2. PAST THE MANAGED STOP — price is beyond where paper's exit would sit: the trade is
  //      over; close it on two consecutive sightings (a bad read can never realize a loss),
  //      covered by a stop just beyond the market while confirming.
  //   3. NAKED — no resting stop covers the volume: place a reduce-only rescue stop at the
  //      managed level, checked after rounding so it can never fire on acceptance.
  //   4. RATCHET — paper's exit: once +1R the stop is at least breakeven and trails 1R
  //      behind the peak (from COMPLETED 1-minute bars). New reduce-only stop first, old
  //      cancelled after (one retry); if the cancel still fails the NEW stop is withdrawn
  //      so the book returns to exactly its prior state.
  // Every close order is refused when an OLDER manual position sits on the same pair and
  // side — Kraken nets FIFO and the order would hit Spencer's book, not the bot's.
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
      const groups = groupPositionsByOrder(positionsAll.filter(ownership.isOurs));
      const orders = groups.length ? await krakenOpenOrders() : [];
      // An account with no resting orders is this account's NORMAL state, and a bot
      // position that lost its stop is exactly what produces "positions, no orders" — so
      // an empty read never skips protection (it did until Sep 5 2026). It withholds the
      // actions a BAD read must never trigger (market closes), and places the rescue stop
      // only on the SECOND consecutive empty read (see emptyOrdersStreak).
      const ordersUnreliable = groups.length > 0 && orders.length === 0;
      state.emptyOrdersStreak = ordersUnreliable ? (state.emptyOrdersStreak ?? 0) + 1 : 0;
      if (ordersUnreliable) errors.push(`protect/exit: zero open orders while holding bot positions (streak ${state.emptyOrdersStreak}) — withholding closes${state.emptyOrdersStreak < 2 ? " and rescue stops until confirmed" : ""}`);
      const stopCfgPct = await cfgNum("kraken_margin_stop_pct", LIVE_STOP_DEFAULT_PCT);
      const maxHoldH = Math.max(1, await cfgNum("kraken_margin_max_hold_h", LIVE_MAX_HOLD_H));
      const samePair = (a: string, b: string) => pairBase(a) === pairBase(b);
      const isOursLoose = (p: { pair: string; side: string; openedAt: string }) => ownership.isOurs(p as unknown as { ordertxid: string; id: string });
      for (const g of groups) {
        const openedMs = g.openedAt ? new Date(g.openedAt).getTime() : NaN;
        // Unknown open time: past the grace period (protect it), but never time-stopped.
        const ageMs = Number.isFinite(openedMs) ? Date.now() - openedMs : Infinity;
        // GRACE: Kraken submits the attached close[] only after the fill; a position opened
        // seconds ago legitimately has no visible stop yet.
        if (ageMs < 6 * 60_000) { if (managedPrev[g.ordertxid]) managedNext[g.ordertxid] = managedPrev[g.ordertxid]; continue; }
        try {
        // g.pair is VENUE-SUFFIXED on real margin fills ("XBTUSD:BTNL"); market data and
        // orders go through the public pair.
        const publicPair = publicPairFor(g.pair);
        const meta = await getPairMeta(publicPair);
        const closeSide = g.side === "long" ? "sell" : "buy";
        const lev = String(Math.max(2, Math.round(g.leverage)));
        const closeVol = g.vol.toFixed(meta.lotDecimals);
        const coveringAll0 = orders.filter((o) => o.userref === MARGIN_USERREF && o.ordertype.includes("stop") && samePair(o.pair, g.pair) && o.side === closeSide);
        // A Kraken trailing-stop reports its OFFSET ("+3%") in descr.price, not a level; the
        // ratchet cannot reason about it. Only fixed stop-loss orders are managed here.
        const hasTrailing = coveringAll0.some((o) => o.ordertype !== "stop-loss");
        const covering0 = coveringAll0.filter((o) => o.ordertype === "stop-loss" && o.price > 0);
        const cancelledTxids = new Set<string>();
        if (coveringAll0.some((o) => o.ordertype === "stop-loss" && !(o.price > 0))) {
          // A fixed stop whose trigger we cannot read is an UNKNOWN, not a zero. Acting on it
          // either way (counting it as cover, or placing a rescue beside it) is a guess.
          errors.push(`${g.pair}: a resting stop has no readable trigger price — not managing this run`);
          if (managedPrev[g.ordertxid]) managedNext[g.ordertxid] = managedPrev[g.ordertxid];
          continue;
        }
        const fifoBlocked = fifoWouldHitManual({ pair: g.pair, side: g.side, openedAt: g.newestOpenedAt }, positionsAll, isOursLoose, samePair);

        // 0) DEDUPE our stops on this order — ONLY when the best one covers the whole volume
        // (partial stops from the naked branch are complementary, not duplicates): keep the
        // best-priced (tie → newest), cancel the rest, and DROP the cancelled from both lists
        // so nothing below acts on an order that no longer rests.
        const byBest = (a: { price: number; opentm: number }, b: { price: number; opentm: number }) => (g.side === "long" ? b.price - a.price : a.price - b.price) || b.opentm - a.opentm;
        if (covering0.length > 1 && [...covering0].sort(byBest)[0].vol >= g.vol * 0.99) {
          const best = [...covering0].sort(byBest)[0];
          for (const o of covering0) {
            if (o.txid === best.txid) continue;
            let gone = false;
            try { await krakenCancelOrder(o.txid); gone = true; }
            catch { try { await krakenCancelOrder(o.txid); gone = true; } catch { errors.push(`could not cancel duplicate stop ${o.txid} on ${g.pair}`); } }
            if (gone) { sent.push(`duplicate-stop-cancelled-${g.pair}`); cancelledTxids.add(o.txid); }
          }
        }
        const coveringAll = coveringAll0.filter((o) => !cancelledTxids.has(o.txid));
        const covering = covering0.filter((o) => !cancelledTxids.has(o.txid));
        const bestStop = covering.length ? [...covering].sort(byBest)[0] : null;

        // Price + peak from COMPLETED 1-minute bars since the last scored bar (paper's walk).
        // Kraken returns ≤720 bars per call, so a gap longer than 12h is paged through.
        const prev = managedPrev[g.ordertxid];
        const sinceS = Math.max(prev?.seenT ?? 0, Number.isFinite(openedMs) ? Math.floor(openedMs / 1000) : 0);
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
        // Kraken cannot return bars older than its most recent 720 regardless of `since`: a
        // gap longer than 12h loses peak history. The stop is never loosened, so principal
        // protection is intact — but the trail may sit lower than paper's would. Say so.
        if (bars.length && bars[0].t > sinceS + 180 && sinceS > 0) errors.push(`${g.pair}: 1-min history gap ${((bars[0].t - sinceS) / 3600).toFixed(1)}h — peak may be under-counted`);
        bars = bars.filter((b, i) => i === bars.length - 1 || bars[i + 1].t !== b.t);   // Kraken can repeat the live bar
        const done = bars.slice(0, -1);   // the newest bar is in progress — it does not ratchet
        let peak = prev?.peak ?? g.entryPrice;
        for (const b of done) peak = g.side === "long" ? Math.max(peak, b.h) : Math.min(peak, b.l);
        const seenT = done.length ? done[done.length - 1].t : (prev?.seenT ?? sinceS);
        let px = bars.length ? bars[bars.length - 1].c : 0;
        if (!(px > 0)) {
          try {
            const tick = await krakenPublic("Ticker", { pair: publicPair });
            px = parseFloat(((Object.values(tick)[0] as { c?: string[] })?.c?.[0]) ?? "0");
          } catch { px = 0; }
        }
        // 1R is fixed at entry: the distance the sizing assumed. Best source is the stop the
        // entry attached (entry − trigger, before any ratchet); else the same clamp the
        // executor applied. Persisted, so a later config change cannot re-price R.
        const clampFrac = clampLiveStopFrac(stopCfgPct, g.leverage);
        let oneR = prev?.oneR ?? 0;
        if (!(oneR > 0)) {
          // The entry wrote its authorised stop distance into the ledger — the one source that
          // cannot have been ratcheted.
          const ledgerFrac = ownership.stopFracOf(g.ordertxid);
          if (ledgerFrac && ledgerFrac > 0) oneR = g.entryPrice * ledgerFrac;
        }
        if (!(oneR > 0)) {
          // SIGNED: a stop already trailed beyond entry (state lost mid-trade) must not seed
          // R with the trail gap; only a stop on the loss side of entry is the original 1R.
          const restingDist = covering.length ? (g.side === "long" ? g.entryPrice - Math.min(...covering.map((o) => o.price)) : Math.max(...covering.map((o) => o.price)) - g.entryPrice) : 0;
          const sane = restingDist > 0 && restingDist / g.entryPrice >= 0.001 && restingDist / g.entryPrice <= 0.5;
          oneR = sane ? restingDist : g.entryPrice * clampFrac;
        }
        managedNext[g.ordertxid] = { oneR, peak, seenT };
        const initialStop = g.side === "long" ? g.entryPrice - oneR : g.entryPrice + oneR;
        const currentStop = bestStop ? bestStop.price : null;
        const target = managedStopTarget(g.side, g.entryPrice, peak, currentStop ?? initialStop, oneR);

        const closeGroup = async (why: string): Promise<boolean> => {
          if (fifoBlocked) {
            if (shouldFire(state, `fifo-${g.ordertxid}`)) {
              await sendNotification(`🚨 ${why} on ${g.pair} ${g.side} NOT executed — an OLDER manual position on the same side would be reduced first (Kraken nets FIFO). Close it by hand, or close the bot's ${closeVol} yourself. Its stop stays in place.`, "margin_urgent").catch(() => {});
              state.alerts[`fifo-${g.ordertxid}`] = new Date().toISOString();
            }
            return false;
          }
          try {
            await krakenPrivate("AddOrder", { pair: publicPair, type: closeSide, ordertype: "market", volume: closeVol, leverage: lev, reduce_only: "true", userref: String(MARGIN_USERREF) });
          } catch (err) {
            // The response may have been lost after Kraken accepted the close. Re-read: if the
            // group is gone the close happened and its stops must still be swept; otherwise
            // leave everything in place (the stop still protects it) and report.
            const stillOpen = (await getKrakenMarginPositions()).some((p) => p.ordertxid === g.ordertxid && p.side === g.side);
            if (stillOpen) throw err;
          }
          const failed: string[] = [];
          for (const o of coveringAll) {
            try { await krakenCancelOrder(o.txid); }
            catch { try { await krakenCancelOrder(o.txid); } catch { failed.push(o.txid); } }
          }
          if (failed.length) await sendNotification(`🚨 Closed ${g.pair} (${why}) but could NOT cancel stop(s) ${failed.join(", ")} — a stranded stop can OPEN a new position if it triggers. Cancel them on Kraken now.`, "margin_urgent").catch(() => {});
          delete managedNext[g.ordertxid];
          await sendNotification(`⏱ ${why} — closed ${g.pair} ${g.side} ${closeVol} (entry $${g.entryPrice.toFixed(meta.priceDecimals)}, now $${px > 0 ? px.toFixed(meta.priceDecimals) : "?"}, held ${(ageMs / 3600_000).toFixed(0)}h).`, "margin_results").catch(() => {});
          sent.push(`${why.toLowerCase().replace(/[^a-z]+/g, "-")}-${g.pair}`);
          return true;
        };

        // 1) TIME STOP (only with a known open time).
        if (Number.isFinite(openedMs) && ageMs >= maxHoldH * 3600_000) {
          // An empty book that has now been seen twice is a real empty book: the position has
          // no stop AND is overdue — closing is the only protective action left.
          if (ordersUnreliable && (state.emptyOrdersStreak ?? 0) < 2) { errors.push(`time stop due on ${g.pair} but orders read empty — confirming next run`); continue; }
          await closeGroup("Time stop");
          continue;
        }
        // A position covered by a Kraken TRAILING stop is protected by Kraken's own rule; the
        // managed exit does not second-guess it (and a second stop beside a non-reduce-only
        // trailing one could fire first and strand it). The time stop above still applies.
        if (hasTrailing) continue;
        // A stop just beyond the market, checked AFTER rounding — widened until it is safe.
        const guardLevelFor = (): string | null => {
          for (const off of [0.002, 0.005, 0.01]) {
            const cand = g.side === "long" ? px * (1 - off) : px * (1 + off);
            const chk = roundedStopIsSafe(g.side, cand, px, meta.priceDecimals);
            if (chk.ok) return chk.priceStr;
          }
          return null;
        };

        // 2) PAST THE MANAGED STOP — the exit paper would already have taken. Two sightings.
        const beyond = px > 0 && (g.side === "long" ? px <= target : px >= target);
        if (beyond) {
          const strikes = (priorBreached[g.ordertxid] ?? 0) + 1;
          nextBreached[g.ordertxid] = strikes;
          if (strikes >= 2 && (!ordersUnreliable || (state.emptyOrdersStreak ?? 0) >= 2)) { await closeGroup("Managed stop breached"); continue; }
          // Strike one: make sure something protects it while we confirm — a stop just
          // beyond the market, never one that fires the instant it is accepted.
          if (coveringAll.length === 0 && (!ordersUnreliable || (state.emptyOrdersStreak ?? 0) >= 2)) {
            const guardLevel = guardLevelFor();
            if (guardLevel) {
              await krakenPrivate("AddOrder", { pair: publicPair, type: closeSide, ordertype: "stop-loss", price: guardLevel, volume: closeVol, leverage: lev, reduce_only: "true", userref: String(MARGIN_USERREF) });
              sent.push(`naked-stop-placed-${g.pair}`);
            }
          }
          continue;
        }

        // 3) NAKED — the volume a resting stop does not cover (1% lot-rounding tolerance).
        const covered = coveringAll.reduce((s, o) => s + (o.vol ?? 0), 0);
        if (covered < g.vol * 0.99) {
          if (ordersUnreliable && (state.emptyOrdersStreak ?? 0) < 2) continue;   // confirm the empty read first
          const naked = (g.vol - covered).toFixed(meta.lotDecimals);
          if (!(px > 0)) { errors.push(`naked ${g.pair} but no price — cannot place a safe stop this run`); continue; }
          const safe = roundedStopIsSafe(g.side, target, px, meta.priceDecimals);
          const level = safe.ok ? safe.priceStr : guardLevelFor();
          if (!level) { errors.push(`naked ${g.pair}: no safe stop level after rounding — retry next run`); continue; }
          await sendNotification(`🚨 NAKED POSITION — ${g.pair} ${g.side} ${g.vol} has only ${covered} covered by a stop (${naked} unprotected). Placing a protective stop at $${level} now.`, "margin_urgent").catch(() => {});
          try {
            await krakenPrivate("AddOrder", { pair: publicPair, type: closeSide, ordertype: "stop-loss", price: level, volume: naked, leverage: lev, reduce_only: "true", userref: String(MARGIN_USERREF) });
            sent.push(`naked-stop-placed-${g.pair}`);
          } catch (err) {
            await sendNotification(`🚨🚨 COULD NOT PLACE PROTECTIVE STOP on ${g.pair} ${g.side}. THE POSITION IS UNPROTECTED — act manually on Kraken now. ${String(err).slice(0, 160)}`, "margin_urgent").catch(() => {});
            errors.push(`naked-stop placement failed ${g.pair}: ${err}`);
          }
          continue;
        }

        // 4) RATCHET — needs a fixed resting stop's trigger price and a price; never a trailing order.
        if (hasTrailing || !bestStop || !(px > 0)) continue;
        if (!stopNeedsRatchet(g.side, bestStop.price, target, px)) continue;
        const safe = roundedStopIsSafe(g.side, target, px, meta.priceDecimals);
        if (!safe.ok) continue;
        const res = await krakenPrivate("AddOrder", { pair: publicPair, type: closeSide, ordertype: "stop-loss", price: safe.priceStr, volume: closeVol, leverage: lev, reduce_only: "true", userref: String(MARGIN_USERREF) });
        const newTxid = (res.txid as string[] | undefined)?.[0];
        const failed: string[] = [];
        for (const o of covering) {
          try { await krakenCancelOrder(o.txid); }
          catch { try { await krakenCancelOrder(o.txid); } catch { failed.push(o.txid); } }   // one retry
        }
        if (failed.length) {
          // The old attached close[] stop is NOT reduce-only: with the new stop above it, a
          // fall through both would close on the new one and OPEN a reverse position on the
          // old. Withdraw the new stop instead — the book returns to exactly its prior state.
          let rolledBack = false;
          if (newTxid) { try { await krakenCancelOrder(newTxid); rolledBack = true; } catch { rolledBack = false; } }
          await sendNotification(rolledBack
            ? `⚠️ Ratchet on ${g.pair} ABORTED: old stop ${failed.join(", ")} could not be cancelled, so the new stop was withdrawn; the old stop still protects the position. Will retry next run.`
            : `🚨 ${g.pair} has TWO stops resting (new reduce-only at $${safe.priceStr}, old ${failed.join(", ")} NOT reduce-only). If price moves through both, the old one OPENS a reverse position. Cancel the old stop on Kraken now.`,
            "margin_urgent").catch(() => {});
          continue;
        }
        sent.push(`stop-ratcheted-${g.pair}`);
        } catch (err) {
          // One order's failure must not abandon the others or discard this run's state.
          errors.push(`protect/exit ${g.pair}: ${String(err).slice(0, 120)}`);
          if (managedPrev[g.ordertxid] && !managedNext[g.ordertxid]) managedNext[g.ordertxid] = managedPrev[g.ordertxid];
        }
      }
    }
    state.nakedBreached = nextBreached;
    state.managed = managedNext;
  } catch (e) {
    if (!String(e).includes("skip: state unreadable")) errors.push(`protect/exit: ${e}`);
  }

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
