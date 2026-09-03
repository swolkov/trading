// TradingView-alert → Kraken margin order executor.
//
// SAFETY MODEL (every layer must be crossed before real money moves):
//   1. kraken_margin_auto         — default OFF: alerts are logged + scored, never traded.
//   2. kraken_margin_validate_only — default ON: even when armed, orders go out with
//      validate=true (Kraken checks but does not execute) until this is explicitly "false".
//   3. kraken_margin_max_leverage — hard cap (default 2). Values below Kraken's margin
//      minimum of 2 REFUSE entries rather than silently rounding up.
//   4. kraken_margin_per_trade_usd — margin committed per entry (default $100).
//   5. kraken_margin_daily_loss_cap — today's margin loss beyond this blocks NEW ENTRIES
//      (default $200). It never blocks a close — a kill switch must not stop a
//      flattening order.
//   6. Anti-stacking: an entry is refused when a position already exists on that pair in
//      that direction (unless kraken_margin_allow_stacking="true"), and when
//      kraken_margin_max_positions (default 3) are already open.
//   7. Every entry carries an attached stop-loss (conditional close) at half the
//      liquidation cushion, so no armed position is ever naked.
//   8. RISK GOVERNOR — the structural fix for the fee-bleed that cost the real money:
//      • kraken_margin_max_trades_per_day (default 6) — hard cap on entries/day.
//      • kraken_margin_cooldown_min (default 30) — minimum minutes between entries, so
//        a once-per-bar alert can't churn 280 trades/month.
//      • kraken_margin_live_max_risk_pct (default 0.5, hard ceiling 2.0) — SIZE is capped
//        so the stop-loss can never lose more than this % of equity; notional shrinks
//        automatically. NOTE the `live_` in the name: this is deliberately NOT the paper
//        experiment's kraken_margin_max_risk_pct (3%, ×2 on conviction), so arming can
//        never silently inherit a research setting. Observed paper losing streak is 13 in
//        a row: 0.5% costs 6% of the account, 3% costs 33%, 6% costs 55%.
//      • kraken_margin_disarmed_dd — account drawdown circuit breaker (set by the
//        guardian); while true, NO new entries (closes still allowed).
//   9. MAKER ENTRIES — kraken_margin_maker_entries (default true) rests a post-only
//      limit so entries pay the maker fee, not taker (taker was 96% of the real loss).
//      Post-only means Kraken rejects rather than crosses, so we never pay taker; an
//      unfilled entry is swept by the guardian.
// One order per invocation, tagged with its own userref. Fails closed on any read error.
// Close orders are reduce_only so a stale read can never flip us into an opposite position.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { krakenPrivate, krakenPair, getKrakenPrice, getPairMeta, krakenTouch, krakenOpenOrders } from "@/lib/kraken";
import { pairMatchesSymbol } from "@/lib/kraken-pairs";
import { getKrakenMarginPositions, getKrakenMarginHealth, listRoundTrips } from "@/lib/kraken-margin";

// Distinct from the trend bot's 770077 so each system's orders are separable forever.
export const MARGIN_USERREF = 770078;

export interface AlertOrder {
  symbol: string;              // "BTC/USD" style
  side: "buy" | "sell" | "close";
  leverage?: number;
  note?: string;
}

export interface ExecResult {
  executed: boolean;
  validated: boolean;          // true = validate-only round (no money moved)
  note: string;
  txid?: string;
}

async function cfg(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null);
  return row?.value ?? null;
}

// parseFloat(...) || default treats an EXPLICIT "0" as unset — which turned
// "daily_loss_cap=0" into $200. Honor any finite configured number.
async function cfgNum(key: string, fallback: number): Promise<number> {
  const raw = await cfg(key);
  if (raw == null || raw.trim() === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Self-contained per-day counter for the trade-frequency governor. Resets at UTC
// midnight. Only real (executed) entries are counted, so validate-mode testing does not
// burn the daily cap.
const DAY_STATE_KEY = "kraken_margin_day_state";
interface DayState { date: string; entries: number; lastEntryIso: string | null }
async function loadDayState(): Promise<DayState> {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await cfg(DAY_STATE_KEY);
  if (raw) {
    try {
      const s = JSON.parse(raw) as DayState;
      if (s.date === today) return s;
    } catch { /* fall through to fresh */ }
  }
  return { date: today, entries: 0, lastEntryIso: null };
}
async function bumpDayState(prev: DayState): Promise<void> {
  const next: DayState = { date: prev.date, entries: prev.entries + 1, lastEntryIso: new Date().toISOString() };
  const value = JSON.stringify(next);
  await prisma.agentConfig.upsert({
    where: { key: DAY_STATE_KEY },
    update: { value },
    create: { key: DAY_STATE_KEY, value },
  }).catch(() => {});
}

// Execution lock — serializes the ENTRY path so two webhook invocations landing at once
// can't both read the same day-state, both pass the cap, and both place an order. Atomic
// compare-and-swap (ISO strings compare in time order). Fails CLOSED: if it can't be
// acquired, the alert is refused rather than risking a concurrent double-entry.
const EXEC_LOCK_KEY = "kraken_margin_exec_lock";
// The entry critical section makes ~8 sequential Kraken calls (each up to 15s) under this
// lock, so the TTL must comfortably exceed the worst-case section time — otherwise the lock
// could be stolen while an invocation still holds it, defeating the only guard against a
// truly concurrent double-entry. 120s clears the summed call timeouts with headroom.
const EXEC_LOCK_TTL_MS = 120_000;
async function acquireExecLock(): Promise<boolean> {
  await prisma.agentConfig.upsert({
    where: { key: EXEC_LOCK_KEY }, update: {}, create: { key: EXEC_LOCK_KEY, value: "" },
  }).catch(() => {});
  const cutoff = new Date(Date.now() - EXEC_LOCK_TTL_MS).toISOString();
  const r = await prisma.agentConfig.updateMany({
    where: { key: EXEC_LOCK_KEY, OR: [{ value: "" }, { value: { lt: cutoff } }] },
    data: { value: new Date().toISOString() },
  }).catch(() => ({ count: 0 }));
  return r.count === 1;
}
async function releaseExecLock(): Promise<void> {
  await prisma.agentConfig.update({ where: { key: EXEC_LOCK_KEY }, data: { value: "" } }).catch(() => {});
}

export async function executeAlert(alert: AlertOrder): Promise<ExecResult> {
  // Layer 1: armed at all?
  const auto = (await cfg("kraken_margin_auto")) === "true";
  if (!auto) return { executed: false, validated: false, note: "tracked only (kraken_margin_auto off)" };

  // Layer 2: validate-only unless explicitly disabled.
  const validate = (await cfg("kraken_margin_validate_only")) !== "false";
  const pair = krakenPair(alert.symbol);

  // ---- CLOSE PATH ----
  // Runs before every other guard: a close reduces risk and must never be blocked by
  // the loss cap, leverage config, or position limits.
  if (alert.side === "close") {
    try {
      const positions = (await getKrakenMarginPositions())
        .filter((p) => pairMatchesSymbol(p.pair, alert.symbol));
      if (!positions.length) return { executed: false, validated: false, note: "close alert but no open position" };
      // Round close volume to the pair's lot precision — same as the entry path. Hardcoding 8
      // decimals gets a close REJECTED by Kraken on any pair with fewer lot decimals, leaving the
      // risk-reducing close silently un-done (the same class of bug the entry path already guards).
      const closeMeta = await getPairMeta(pair);
      const txids: string[] = [];
      for (const p of positions) {
        const params: Record<string, string> = {
          pair,
          type: p.side === "long" ? "sell" : "buy",
          ordertype: "market",
          volume: p.vol.toFixed(closeMeta.lotDecimals),
          leverage: String(Math.max(2, Math.round(p.leverage))),
          // reduce_only: if the position shrank between our read and this order (manual
          // close, partial liquidation, duplicate alert), Kraken reduces to flat instead
          // of opening an opposite position with the excess volume.
          reduce_only: "true",
          userref: String(MARGIN_USERREF),
        };
        if (validate) params.validate = "true";
        const res = await krakenPrivate("AddOrder", params);
        const txid = (res.txid as string[] | undefined)?.[0];
        if (txid) txids.push(txid);
      }
      return {
        executed: !validate,
        validated: validate,
        txid: txids[0],
        note: `closed ${positions.length} position(s) on ${pair}${validate ? " (validate)" : ""}`,
      };
    } catch (e) {
      return { executed: false, validated: validate, note: `close failed: ${e}` };
    }
  }

  // ---- ENTRY PATH ----
  // Layer 8a: account drawdown circuit breaker. The guardian sets this when equity
  // falls too far from its peak; while tripped, no new risk (closes still allowed above).
  if ((await cfg("kraken_margin_disarmed_dd")) === "true") {
    return { executed: false, validated: false, note: "entries halted — account drawdown circuit breaker tripped" };
  }

  // Serialize entries: without this, two alerts landing together both read the same
  // day-state and both place an order. Fails closed — a lock we can't get = no entry.
  if (!(await acquireExecLock())) {
    return { executed: false, validated: false, note: "another entry is in progress — skipped (no concurrent entries)" };
  }
  try {
    // Layer 8b: trade-frequency governor — the structural cure for the fee bleed.
    const dayState = await loadDayState();
    const maxPerDay = Math.max(1, await cfgNum("kraken_margin_max_trades_per_day", 6));
    if (dayState.entries >= maxPerDay) {
      return { executed: false, validated: false, note: `entry refused: ${dayState.entries}/${maxPerDay} trades already today` };
    }
    const cooldownMin = Math.max(0, await cfgNum("kraken_margin_cooldown_min", 30));
    if (dayState.lastEntryIso && Date.now() - new Date(dayState.lastEntryIso).getTime() < cooldownMin * 60_000) {
      const waited = Math.round((Date.now() - new Date(dayState.lastEntryIso).getTime()) / 60_000);
      return { executed: false, validated: false, note: `entry refused: cooldown (${waited}/${cooldownMin} min since last entry)` };
    }

    // Layer 3: leverage. Kraken margin minimum is 2; a cap below that means "no entries".
    const maxLev = await cfgNum("kraken_margin_max_leverage", 2);
    if (maxLev < 2) {
      return { executed: false, validated: false, note: `entries disabled (max leverage ${maxLev} < Kraken minimum 2)` };
    }
    const leverage = Math.min(Math.min(20, maxLev), Math.max(2, alert.leverage ?? 2));
    const perTrade = Math.max(10, await cfgNum("kraken_margin_per_trade_usd", 100));
    const lossCap = Math.max(0, await cfgNum("kraken_margin_daily_loss_cap", 200));

    // Layer 5: daily loss kill switch — realized round trips closed today plus open P&L.
    // Fails closed on ANY read problem, including a stale trade sync.
    const syncedAt = await cfg("margin_trades_synced_at");
    if (!syncedAt || Date.now() - new Date(syncedAt).getTime() > 15 * 60 * 1000) {
      return { executed: false, validated: false, note: "trade sync stale (>15m) — cannot trust loss cap, failing closed" };
    }
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const trips = await listRoundTrips();
    const realizedToday = trips
      .filter((t) => new Date(t.closedAt) >= dayStart)
      .reduce((s, t) => s + t.netPnl, 0);
    const health = await getKrakenMarginHealth();
    const equity = health.equity;
    // Fail closed if equity reads 0/unreadable — otherwise risk-based sizing below would
    // silently skip its cap and place a full-size order.
    if (!(equity > 0)) {
      return { executed: false, validated: false, note: "equity reads 0/unreadable — failing closed" };
    }
    const todayPnl = realizedToday + (health.unrealized || 0);
    if (todayPnl < -lossCap) {
      await sendNotification(
        `🛑 Margin auto-trade BLOCKED — today's margin P&L $${todayPnl.toFixed(0)} is past the $${lossCap} daily loss cap. No new entries until tomorrow (closes still go through).`,
        "kraken",
      );
      return { executed: false, validated: false, note: `daily loss cap hit (${todayPnl.toFixed(0)} < -${lossCap})` };
    }

    // Layer 6: anti-stacking — count BOTH open positions AND our resting orders toward
    // the cap. Counting resting orders means an entry whose HTTP response timed out (but
    // that Kraken accepted) still counts on the next alert, so a timeout can't sneak a
    // second position past the limit.
    const openPositions = await getKrakenMarginPositions();
    const ourOrders = (await krakenOpenOrders()).filter((o) => o.userref === MARGIN_USERREF);
    const ourEntryOrders = ourOrders.filter((o) => !o.ordertype.includes("stop"));
    const exposureCount = openPositions.length + ourEntryOrders.length;
    const maxPositions = Math.max(1, await cfgNum("kraken_margin_max_positions", 3));
    if (exposureCount >= maxPositions) {
      return { executed: false, validated: false, note: `entry refused: ${exposureCount} positions+resting orders already (max ${maxPositions})` };
    }
    const allowStacking = (await cfg("kraken_margin_allow_stacking")) === "true";
    const wantSide = alert.side === "buy" ? "long" : "short";
    if (!allowStacking && (
      openPositions.some((p) => pairMatchesSymbol(p.pair, alert.symbol) && p.side === wantSide) ||
      ourEntryOrders.some((o) => pairMatchesSymbol(o.pair, alert.symbol) && (o.side === "buy" ? "long" : "short") === wantSide)
    )) {
      return { executed: false, validated: false, note: `entry refused: already ${wantSide} ${alert.symbol} (position or resting order; stacking off)` };
    }

    // Attached protective exit + risk-based sizing, both computed from the ACTUAL entry
    // price. For a maker order that price is the resting limit (bid/ask), NOT the last
    // trade — sizing the stop from a different price than the entry would make the real
    // stop distance (and risk) wrong.
    const stopPct = Math.min(0.5, Math.max(0.001, (await cfgNum("kraken_margin_stop_pct", (0.3 / leverage) * 100)) / 100));
    const trailPct = Math.min(50, Math.max(0, await cfgNum("kraken_margin_trail_pct", 0)));
    const makerEntries = (await cfg("kraken_margin_maker_entries")) !== "false";
    const meta = await getPairMeta(pair);

    // The entry reference price: the resting limit for a maker order, else the last trade.
    let entryPx: number;
    if (makerEntries) {
      const { bid, ask } = await krakenTouch(alert.symbol);
      entryPx = alert.side === "buy" ? bid : ask;
    } else {
      entryPx = await getKrakenPrice(alert.symbol);
    }
    if (!(entryPx > 0)) return { executed: false, validated: false, note: "no entry price available — skipped" };

    // RISK-BASED SIZING: notional capped so a stop-out loses ≤ max_risk_pct of equity.
    //
    // ⚠️ LIVE RISK HAS ITS OWN KEY, deliberately separate from the paper experiment's.
    // `kraken_margin_max_risk_pct` is read by the PAPER sizer too, and it is set high (3%,
    // doubled to 6% on high conviction) so paper dollars look like real trading. Sharing
    // one key would mean the day this is armed, live silently inherits the paper research
    // setting. The observed paper losing streak is 13 in a row — at 3% that is a −33%
    // account, at 6% a −55% account (which needs +124% to recover). So live reads
    // `kraken_margin_live_max_risk_pct` and defaults to 0.5%: a 13-loss streak costs 6%.
    // Raise it deliberately, in steps, only after live fills have proven out.
    let notional = perTrade * leverage;
    const maxRiskPct = Math.min(2, Math.max(0.1, await cfgNum("kraken_margin_live_max_risk_pct", 0.5))) / 100;
    const riskDist = trailPct > 0 ? trailPct / 100 : stopPct;   // fraction; price-independent
    if (equity > 0 && riskDist > 0) {
      const notionalCap = (maxRiskPct * equity) / riskDist;
      if (notional > notionalCap) notional = notionalCap;
    }
    const rawVol = notional / entryPx;
    if (meta.orderMin > 0 && rawVol < meta.orderMin) {
      return { executed: false, validated: false, note: `size ${rawVol} below Kraken minimum ${meta.orderMin} after risk cap — skipped` };
    }
    const volume = rawVol.toFixed(meta.lotDecimals);
    const stopPrice = alert.side === "buy" ? entryPx * (1 - stopPct) : entryPx * (1 + stopPct);
    const closeParams: Record<string, string> = trailPct > 0
      ? { "close[ordertype]": "trailing-stop", "close[price]": `+${trailPct.toFixed(2)}%` }
      : { "close[ordertype]": "stop-loss", "close[price]": stopPrice.toFixed(meta.priceDecimals) };

    const params: Record<string, string> = {
      pair,
      type: alert.side,
      volume,
      leverage: String(leverage),
      userref: String(MARGIN_USERREF),
      ...closeParams,
    };
    if (makerEntries) {
      params.ordertype = "limit";
      params.price = entryPx.toFixed(meta.priceDecimals);
      params.oflags = "post";   // post-only: Kraken rejects rather than crossing → never taker
    } else {
      params.ordertype = "market";
    }
    if (validate) params.validate = "true";

    let res;
    try {
      res = await krakenPrivate("AddOrder", params);
    } catch (e) {
      if (makerEntries && /post|would|cross/i.test(String(e))) {
        return { executed: false, validated: false, note: "maker entry would cross — price moved, skipped (no chase)" };
      }
      throw e;
    }
    const txid = (res.txid as string[] | undefined)?.[0];
    const descr = (res.descr as { order?: string } | undefined)?.order;

    // Count on acceptance (conservative — an unfilled maker rest still consumes a slot,
    // which caps churn; the guardian sweeps unfilled entries). Real executions only.
    if (!validate) await bumpDayState(dayState);

    const stopDesc = trailPct > 0 ? `trailing stop ${trailPct.toFixed(1)}%` : `stop ${(stopPct * 100).toFixed(1)}%`;
    return {
      executed: !validate,
      validated: validate,
      txid,
      note: `${alert.side} $${notional.toFixed(0)} notional (${leverage}x, ${makerEntries ? "maker" : "market"}) ${pair}, ${stopDesc}, risk≤${(maxRiskPct * 100).toFixed(1)}% equity${validate ? " (validate)" : ""} — ${descr ?? ""}`,
    };
  } catch (e) {
    return { executed: false, validated: validate, note: `order failed: ${e}` };
  } finally {
    await releaseExecLock();
  }
}
