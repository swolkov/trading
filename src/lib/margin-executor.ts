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
// One order per invocation, market only, tagged with its own userref. Fails closed on
// any read error. Close orders are reduce_only so a stale read can never flip us into
// an opposite position.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { krakenPrivate, krakenPair, getKrakenPrice, getPairMeta } from "@/lib/kraken";
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
  // Layer 3: leverage. Kraken margin minimum is 2; a cap below that means "no entries".
  const maxLev = await cfgNum("kraken_margin_max_leverage", 2);
  if (maxLev < 2) {
    return { executed: false, validated: false, note: `entries disabled (max leverage ${maxLev} < Kraken minimum 2)` };
  }
  const leverage = Math.min(Math.min(20, maxLev), Math.max(2, alert.leverage ?? 2));
  const perTrade = Math.max(10, await cfgNum("kraken_margin_per_trade_usd", 100));
  const lossCap = Math.max(0, await cfgNum("kraken_margin_daily_loss_cap", 200));

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

    // Size and price.
    const price = await getKrakenPrice(alert.symbol);
    const notional = perTrade * leverage;
    const meta = await getPairMeta(pair);
    const volume = (notional / price).toFixed(meta.lotDecimals);

    // Layer 7: attached stop-loss at half the liquidation cushion (0.3/leverage), so an
    // armed position is never naked. Price MUST be rounded to the pair's tick or Kraken
    // rejects the whole order (the gold naked-stop lesson).
    const stopPct = Math.min(0.5, Math.max(0.001, (await cfgNum("kraken_margin_stop_pct", (0.3 / leverage) * 100)) / 100));
    const stopPrice = alert.side === "buy" ? price * (1 - stopPct) : price * (1 + stopPct);
    const params: Record<string, string> = {
      pair,
      type: alert.side,
      ordertype: "market",
      volume,
      leverage: String(leverage),
      userref: String(MARGIN_USERREF),
      "close[ordertype]": "stop-loss",
      "close[price]": stopPrice.toFixed(meta.priceDecimals),
    };
    if (validate) params.validate = "true";
    const res = await krakenPrivate("AddOrder", params);
    const txid = (res.txid as string[] | undefined)?.[0];
    const descr = (res.descr as { order?: string } | undefined)?.order;
    return {
      executed: !validate,
      validated: validate,
      txid,
      note: `${alert.side} $${notional} notional (${leverage}x on $${perTrade}) ${pair}, stop ${(stopPct * 100).toFixed(1)}% @ ${stopPrice.toFixed(meta.priceDecimals)}${validate ? " (validate)" : ""} — ${descr ?? ""}`,
    };
  } catch (e) {
    return { executed: false, validated: validate, note: `order failed: ${e}` };
  }
}
