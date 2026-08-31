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
//      • kraken_margin_max_risk_pct (default 1.5) — SIZE is capped so the stop-loss can
//        never lose more than this % of equity; notional shrinks automatically.
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
import { krakenPrivate, krakenPair, getKrakenPrice, getPairMeta, krakenTouch } from "@/lib/kraken";
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
      const txids: string[] = [];
      for (const p of positions) {
        const params: Record<string, string> = {
          pair,
          type: p.side === "long" ? "sell" : "buy",
          ordertype: "market",
          volume: p.vol.toFixed(8),
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
  let equity = 0;   // account equity, captured in the loss-cap block for risk sizing

  // Layer 5: daily loss kill switch — realized round trips closed today plus open P&L.
  // Fails closed on ANY read problem, including a stale trade sync: stale data
  // understates losses, which is exactly when the cap must not be trusted.
  try {
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
    equity = health.equity;
    const todayPnl = realizedToday + (health.unrealized || 0);
    if (todayPnl < -lossCap) {
      await sendNotification(
        `🛑 Margin auto-trade BLOCKED — today's margin P&L $${todayPnl.toFixed(0)} is past the $${lossCap} daily loss cap. No new entries until tomorrow (closes still go through).`,
        "kraken",
      );
      return { executed: false, validated: false, note: `daily loss cap hit (${todayPnl.toFixed(0)} < -${lossCap})` };
    }
  } catch (e) {
    return { executed: false, validated: false, note: `P&L unreadable — failing closed (${e})` };
  }

  try {
    // Layer 6: anti-stacking. A misconfigured once-per-bar alert must not build a tower.
    const open = await getKrakenMarginPositions();
    const maxPositions = Math.max(1, await cfgNum("kraken_margin_max_positions", 3));
    if (open.length >= maxPositions) {
      return { executed: false, validated: false, note: `entry refused: ${open.length} positions already open (max ${maxPositions})` };
    }
    const allowStacking = (await cfg("kraken_margin_allow_stacking")) === "true";
    const wantSide = alert.side === "buy" ? "long" : "short";
    if (!allowStacking && open.some((p) => pairMatchesSymbol(p.pair, alert.symbol) && p.side === wantSide)) {
      return { executed: false, validated: false, note: `entry refused: already ${wantSide} ${alert.symbol} (stacking off)` };
    }

    // Layer 7: attached protective exit. Static stop at half the liquidation cushion
    // (0.3/leverage) by default; a NATIVE Kraken trailing stop if kraken_margin_trail_pct
    // > 0 (the exchange ratchets it behind the best price, locking profit even if our
    // infra is down).
    const stopPct = Math.min(0.5, Math.max(0.001, (await cfgNum("kraken_margin_stop_pct", (0.3 / leverage) * 100)) / 100));
    const trailPct = Math.min(50, Math.max(0, await cfgNum("kraken_margin_trail_pct", 0)));

    // Layer 8c: RISK-BASED SIZING. The stop can lose at most stopPct × notional; cap
    // notional so that loss never exceeds max_risk_pct of equity. Size shrinks
    // automatically when leverage or stop width would risk too much — this, not a fixed
    // dollar amount, is how a levered book avoids a single trade doing real damage.
    const price = await getKrakenPrice(alert.symbol);
    const meta = await getPairMeta(pair);
    let notional = perTrade * leverage;
    const maxRiskPct = Math.max(0.1, await cfgNum("kraken_margin_max_risk_pct", 1.5)) / 100;
    // Trailing stops have no fixed distance; use the trail % as the risk proxy.
    const riskDist = trailPct > 0 ? trailPct / 100 : stopPct;
    if (equity > 0 && riskDist > 0) {
      const notionalCap = (maxRiskPct * equity) / riskDist;
      if (notional > notionalCap) notional = notionalCap;
    }
    const rawVol = notional / price;
    const volume = rawVol.toFixed(meta.lotDecimals);
    if (meta.orderMin > 0 && rawVol < meta.orderMin) {
      return { executed: false, validated: false, note: `size ${rawVol} below Kraken minimum ${meta.orderMin} after risk cap — skipped` };
    }

    // Layer 9: maker-first entry. Rest a post-only limit at the bid (buy) / ask (sell)
    // so we pay the maker fee, not taker. `post` makes Kraken REJECT rather than cross,
    // so we can never accidentally pay taker; a resting unfilled entry is swept by the
    // guardian. Market fallback only when maker entries are explicitly disabled.
    const makerEntries = (await cfg("kraken_margin_maker_entries")) !== "false";
    const stopPrice = alert.side === "buy" ? price * (1 - stopPct) : price * (1 + stopPct);
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
      const { bid, ask } = await krakenTouch(alert.symbol);
      const limitPx = alert.side === "buy" ? bid : ask;
      if (!(limitPx > 0)) return { executed: false, validated: false, note: "no touch price — skipped" };
      params.ordertype = "limit";
      params.price = limitPx.toFixed(meta.priceDecimals);
      params.oflags = "post";
    } else {
      params.ordertype = "market";
    }
    if (validate) params.validate = "true";

    let res;
    try {
      res = await krakenPrivate("AddOrder", params);
    } catch (e) {
      // Post-only rejection = price already moved through our limit. Do not chase (one
      // order per invocation, no fallback); report and let the next alert re-price.
      if (makerEntries && /post|would|cross/i.test(String(e))) {
        return { executed: false, validated: false, note: "maker entry would cross — price moved, skipped (no chase)" };
      }
      throw e;
    }
    const txid = (res.txid as string[] | undefined)?.[0];
    const descr = (res.descr as { order?: string } | undefined)?.order;

    // Count only real executions against the daily governor (validate never trades).
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
  }
}
