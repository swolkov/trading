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
import { LIVE_MAX_HOLD_H, LIVE_STOP_DEFAULT_PCT, managedStopTarget, stopNeedsRatchet } from "@/lib/margin-live-risk";

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

async function loadState(): Promise<WatchState> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: STATE_KEY } });
    if (row?.value) return JSON.parse(row.value) as WatchState;
  } catch { /* fresh state */ }
  return { alerts: {} };
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
  const state = await loadState();

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
    if (health.equity > 0) {
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
        const jump = Math.abs(health.equity - state.lastEquity) / state.lastEquity;
        if (jump > 0.30) {
          peak = health.equity;
          await prisma.agentConfig.upsert({
            where: { key: "kraken_margin_equity_peak" },
            update: { value: String(peak) }, create: { key: "kraken_margin_equity_peak", value: String(peak) },
          }).catch(() => {});
          sent.push("dd-peak-rebaselined (capital flow)");
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
    errors.push(`order reconcile: ${e}`);
  }

  // 3c) NAKED-POSITION GUARD — the reverse direction of 3b, and the one that actually
  // protects money. 3b walks stop → position (cancel orphaned stops). Nothing walked
  // position → stop, so the promise that "no armed position is ever naked" rested entirely
  // on Kraken's conditional-close having been accepted — unverified, with real break paths:
  // a post-only entry that partially filled before the stale sweep cancelled it, or a
  // close[] rejected at fill time (price already through the trigger, decimals, margin).
  // Either leaves a live levered position running to LIQUIDATION instead of a stop.
  // So: for every position WE opened, assert a stop exists that closes it. Scoped to the
  // bot's own txids — Spencer's hand-opened positions are his to manage and we must never
  // attach orders to them.
  try {
    const ownership = await botOwnership();   // ledger ∪ adopted — same predicate as the close path
    if (ownership.ledger.size > 0 || ownership.adopted.size > 0) {
      const positions = await getKrakenMarginPositions();
      // Join on ordertxid ("O…"), the OPENING ORDER's id — NOT the OpenPositions key,
      // which is the TRADE txid ("T…"). Verified against the real account: 115 fills from
      // 72 orders, zero where the two ids matched. Getting this wrong makes the whole
      // guard silently inert while the safety docs claim it runs.
      const botPositions = positions.filter(ownership.isOurs);
      if (botPositions.length) {
        const orders = await krakenOpenOrders();
        // EMPTY-ORDERS READ. Kraken can return an empty collection during degradation — but
        // an account with no resting orders is also this account's NORMAL state, and a bot
        // position that lost its stop is precisely the case that produces "positions, no
        // orders". Until Sep 5 2026 this guard skipped itself on that read, so the one
        // situation it exists for was the one it never handled. Now: the rescue stop is
        // still placed (reduce_only — a duplicate can never open anything; 3b sweeps the
        // spare once one fires), and only the MARKET FLATTEN is withheld on an empty read,
        // because that is the action a bad read must never trigger.
        const ordersUnreliable = orders.length === 0;
        if (ordersUnreliable) errors.push("naked-position guard: zero open orders while holding bot positions — placing rescue stops, withholding any flatten (possibly unreliable read)");
        const stopPctCfg = Math.max(0.005, Math.min(0.5, (await cfgNum("kraken_margin_stop_pct", LIVE_STOP_DEFAULT_PCT)) / 100));
        const myStops = orders.filter((o) => o.userref === MARGIN_USERREF && o.ordertype.includes("stop"));
        const priorBreached = state.nakedBreached ?? {};
        const nextBreached: Record<string, number> = {};
        for (const p of botPositions) {
          // GRACE PERIOD: Kraken submits the attached close[] only after the primary
          // fills, so a position opened seconds ago may legitimately have no visible stop
          // yet. Placing one now would race the conditional close and could leave two.
          // One guardian cycle (5 min) is enough for it to appear.
          const ageMs = p.openedAt ? Date.now() - new Date(p.openedAt).getTime() : Infinity;
          if (ageMs < 6 * 60_000) continue;
          const covering = myStops.filter((o) =>
            pairBase(o.pair) === pairBase(p.pair) &&
            ((p.side === "long" && o.side === "sell") || (p.side === "short" && o.side === "buy")));
          const covered = covering.reduce((s, o) => s + (o.vol ?? 0), 0);
          // 1% tolerance for lot rounding between the position and its stop.
          if (covered >= p.vol * 0.99) continue;
          const naked = p.vol - covered;
          await sendNotification(
            `🚨 NAKED POSITION — ${p.pair} ${p.side} ${p.vol} has only ${covered} covered by a stop (${naked.toFixed(8)} unprotected). Placing a protective stop now.`,
            "margin_urgent",
          ).catch(() => {});
          try {
            // ⚠️ p.pair is VENUE-SUFFIXED on real margin fills ("XBTUSD:BTNL" — confirmed
            // on every one of Spencer's 115 margin fills). AssetPairs and Ticker both
            // reject that form, so route through publicPairFor() exactly as step 3 does.
            const publicPair = publicPairFor(p.pair);
            const meta = await getPairMeta(publicPair);
            const tick = await krakenPublic("Ticker", { pair: publicPair });
            const px = parseFloat(((Object.values(tick)[0] as { c?: string[] })?.c?.[0]) ?? "0");
            if (!(px > 0)) throw new Error(`no price for ${publicPair}`);
            // Anchor the rescue stop to the position's ENTRY, not the current price — the
            // entry-relative distance is the risk that was actually authorised. If price
            // has already run past that level the position is beyond its budget, so the
            // correct action is to flatten now rather than set a stop it already breached.
            // The distance is the paper container's (kraken_margin_stop_pct, default 3%) —
            // the same one sizing assumed — and if the managed exit had already ratcheted
            // this position, the rescue goes at the RATCHETED level, never back below it.
            const anchor = p.entryPrice > 0 ? p.entryPrice : px;
            const initialStop = p.side === "long" ? anchor * (1 - stopPctCfg) : anchor * (1 + stopPctCfg);
            const m = state.managed?.[p.ordertxid];
            const stopPx = m ? managedStopTarget(p.side, anchor, m.peak, initialStop, m.oneR) : initialStop;
            // TWO-STRIKE RULE ON THE FLATTEN ONLY. Placing a reduce_only stop is cheap and
            // reversible, so it happens on the first sighting. MARKET-CLOSING realizes P&L,
            // so a false positive costs real money — it must be confirmed across two
            // consecutive runs, exactly like 3b's orphan rule. The protective stop is still
            // placed on strike one, so the position is covered while we confirm.
            const breachedNow = p.side === "long" ? px <= stopPx : px >= stopPx;
            const strikes = breachedNow ? (priorBreached[p.ordertxid] ?? 0) + 1 : 0;
            if (breachedNow) nextBreached[p.ordertxid] = strikes;
            const alreadyBreached = breachedNow && strikes >= 2 && !ordersUnreliable;
            await krakenPrivate("AddOrder", alreadyBreached ? {
              pair: publicPair,
              type: p.side === "long" ? "sell" : "buy",
              ordertype: "market",
              volume: naked.toFixed(meta.lotDecimals),
              leverage: String(Math.max(2, Math.round(p.leverage))),
              reduce_only: "true",
              userref: String(MARGIN_USERREF),
            } : {
              pair: publicPair,
              type: p.side === "long" ? "sell" : "buy",
              ordertype: "stop-loss",
              price: stopPx.toFixed(meta.priceDecimals),
              volume: naked.toFixed(meta.lotDecimals),
              leverage: String(Math.max(2, Math.round(p.leverage))),
              reduce_only: "true",
              userref: String(MARGIN_USERREF),
            });
            sent.push(alreadyBreached ? `naked-position-flattened-${p.pair}` : `naked-stop-placed-${p.pair}`);
          } catch (err) {
            // Could not protect it — this is the loudest thing the system can say.
            await sendNotification(
              `🚨🚨 COULD NOT PLACE PROTECTIVE STOP on ${p.pair} ${p.side}. THE POSITION IS UNPROTECTED — act manually on Kraken now. ${String(err).slice(0, 160)}`,
              "margin_urgent",
            ).catch(() => {});
            errors.push(`naked-stop placement failed ${p.pair}: ${err}`);
          }
        }
        state.nakedBreached = nextBreached;
      }
    }
  } catch (e) {
    errors.push(`naked-position guard: ${e}`);
  }

  // 3d) MANAGED EXIT — the paper record's container, applied to the bot's REAL positions.
  //     Paper's `selective` sleeve: once the best price since entry reaches +1R the stop
  //     moves to breakeven and then trails 1R behind the peak (ratchet only, never looser),
  //     with a 48h time stop. A Kraken stop-loss rests and fires natively, so all this does
  //     is MOVE our own resting stop in the trade's favour when paper's rule says so, and
  //     market-close a position that has outlived the time stop. Scoped to the bot's
  //     positions (ledger ∪ adopted); manual positions are never touched. On a ratchet the
  //     NEW reduce_only stop is placed FIRST and the old one cancelled after — a
  //     cancel-then-place gap would leave the position naked for a call, while two
  //     reduce_only stops resting for a moment can never open anything.
  try {
    const ownership = await botOwnership();
    const positions = await getKrakenMarginPositions();
    const positionsUnreliable = positions.length === 0 && (marginUsedNow == null || marginUsedNow > 0);
    const managedPrev = state.managed ?? {};
    const managedNext: NonNullable<WatchState["managed"]> = {};
    if (positionsUnreliable) {
      Object.assign(managedNext, managedPrev);   // keep what we know; act next run
    } else {
      const botPositions = positions.filter(ownership.isOurs);
      const orders = botPositions.length ? await krakenOpenOrders() : [];
      const stopPctCfg = Math.max(0.005, Math.min(0.5, (await cfgNum("kraken_margin_stop_pct", LIVE_STOP_DEFAULT_PCT)) / 100));
      const maxHoldH = Math.max(1, await cfgNum("kraken_margin_max_hold_h", LIVE_MAX_HOLD_H));
      for (const p of botPositions) {
        const openedMs = p.openedAt ? new Date(p.openedAt).getTime() : NaN;
        const ageMs = Number.isFinite(openedMs) ? Date.now() - openedMs : 0;
        // Same grace as 3c: the attached stop appears only after the fill.
        if (ageMs < 6 * 60_000) { if (managedPrev[p.ordertxid]) managedNext[p.ordertxid] = managedPrev[p.ordertxid]; continue; }
        const publicPair = publicPairFor(p.pair);
        const prev = managedPrev[p.ordertxid];
        // 1R is fixed at entry — the stop distance the sizing assumed. Seeded from the same
        // key the entry read minutes earlier; persisted so a later config change cannot
        // re-price an open trade's R.
        const oneR = prev?.oneR ?? p.entryPrice * stopPctCfg;
        let peak = prev?.peak ?? p.entryPrice;
        const sinceS = Math.max(prev?.seenT ?? 0, Number.isFinite(openedMs) ? Math.floor(openedMs / 1000) : 0);
        let bars: { t: number; h: number; l: number; c: number }[] = [];
        try { bars = (await getKrakenOHLC(publicPair, 1, sinceS - 60)).filter((b) => b.t >= sinceS); } catch { bars = []; }
        // Exactly as paper: the newest bar is in progress and does not ratchet.
        const done = bars.slice(0, -1);
        for (const b of done) peak = p.side === "long" ? Math.max(peak, b.h) : Math.min(peak, b.l);
        const seenT = done.length ? done[done.length - 1].t : (prev?.seenT ?? sinceS);
        managedNext[p.ordertxid] = { oneR, peak, seenT };
        const px = bars.length ? bars[bars.length - 1].c : 0;
        const closeSide = p.side === "long" ? "sell" : "buy";
        const covering = orders.filter((o) => o.userref === MARGIN_USERREF && o.ordertype.includes("stop") && pairBase(o.pair) === pairBase(p.pair) && o.side === closeSide);
        const meta = await getPairMeta(publicPair);
        const lev = String(Math.max(2, Math.round(p.leverage)));

        // TIME STOP (paper: 48h). Reduce-only market close, then sweep the stops it leaves.
        if (ageMs >= maxHoldH * 3600_000) {
          await krakenPrivate("AddOrder", { pair: publicPair, type: closeSide, ordertype: "market", volume: p.vol.toFixed(meta.lotDecimals), leverage: lev, reduce_only: "true", userref: String(MARGIN_USERREF) });
          for (const o of covering) { try { await krakenCancelOrder(o.txid); } catch { errors.push(`time stop: could not cancel stop ${o.txid} on ${p.pair}`); } }
          delete managedNext[p.ordertxid];
          await sendNotification(`⏱ Time stop — closed ${p.pair} ${p.side} ${p.vol} after ${(ageMs / 3600_000).toFixed(0)}h (paper's ${maxHoldH}h rule).`, "margin_results").catch(() => {});
          sent.push(`time-stop-${p.pair}`);
          continue;
        }

        // RATCHET — needs a known resting stop (its trigger price) and a price.
        if (!covering.length || !(px > 0)) continue;
        const currentStop = p.side === "long" ? Math.max(...covering.map((o) => o.price)) : Math.min(...covering.map((o) => o.price));
        if (!(currentStop > 0)) continue;
        const target = managedStopTarget(p.side, p.entryPrice, peak, currentStop, oneR);
        if (!stopNeedsRatchet(p.side, currentStop, target, px)) continue;
        // Never move a stop THROUGH the current price: it would fire instantly as a market
        // close at whatever the book offers. If price is already past the target the old
        // stop (or the next tick) resolves the trade; leave it.
        if (p.side === "long" ? target >= px : target <= px) continue;
        await krakenPrivate("AddOrder", { pair: publicPair, type: closeSide, ordertype: "stop-loss", price: target.toFixed(meta.priceDecimals), volume: p.vol.toFixed(meta.lotDecimals), leverage: lev, reduce_only: "true", userref: String(MARGIN_USERREF) });
        const failed: string[] = [];
        for (const o of covering) { try { await krakenCancelOrder(o.txid); } catch { failed.push(o.txid); } }
        if (failed.length) {
          await sendNotification(`⚠️ Ratcheted ${p.pair} stop to $${target.toFixed(meta.priceDecimals)} but could not cancel the old stop(s) ${failed.join(", ")} — two reduce-only stops rest; when one fires the guardian sweeps the other.`, "margin_urgent").catch(() => {});
        }
        sent.push(`stop-ratcheted-${p.pair}`);
      }
    }
    state.managed = managedNext;
  } catch (e) {
    errors.push(`managed exit: ${e}`);
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

  await saveState(state);

  // Fail loudly: an unhealthy guardian is worse than none, because it feels like cover.
  if (errors.length) {
    console.error("[/api/cron/margin-watch]", errors);
    const key = "watch-errors";
    if (shouldFire(state, key)) {
      await sendNotification(`⚠️ margin-watch errors: ${errors.join(" | ").slice(0, 400)}`, "margin_urgent");
      state.alerts[key] = new Date().toISOString();
      await saveState(state);
    }
  }

  return Response.json({ ok: errors.length === 0, flat, sent, errors });
}
