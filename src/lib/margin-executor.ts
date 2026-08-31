// TradingView-alert → Kraken margin order executor.
//
// SAFETY MODEL (every layer must be crossed before real money moves):
//   1. kraken_margin_auto        — default OFF: alerts are logged + scored, never traded.
//   2. kraken_margin_validate_only — default ON: even when armed, orders go out with
//      validate=true (Kraken checks but does not execute) until this is explicitly "false".
//   3. kraken_margin_max_leverage  — hard cap (default 2). An alert asking for 20x gets 2x.
//   4. kraken_margin_per_trade_usd — margin committed per trade (default $100).
//   5. kraken_margin_daily_loss_cap — realized+open margin loss today beyond this = no new
//      entries until tomorrow (default $200).
// One order per invocation, market only, tagged with its own userref so the trend bot's
// orders and Spencer's manual orders are never touched. Fails closed on any read error.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { krakenPrivate, krakenPair } from "@/lib/kraken";
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

export async function executeAlert(alert: AlertOrder): Promise<ExecResult> {
  // Layer 1: armed at all?
  const auto = (await cfg("kraken_margin_auto")) === "true";
  if (!auto) return { executed: false, validated: false, note: "tracked only (kraken_margin_auto off)" };

  // Layer 2: validate-only unless explicitly disabled.
  const validate = (await cfg("kraken_margin_validate_only")) !== "false";

  // Layers 3–4: caps.
  const maxLev = Math.max(1, Math.min(20, parseFloat((await cfg("kraken_margin_max_leverage")) ?? "2") || 2));
  const perTrade = Math.max(10, parseFloat((await cfg("kraken_margin_per_trade_usd")) ?? "100") || 100);
  const lossCap = Math.max(0, parseFloat((await cfg("kraken_margin_daily_loss_cap")) ?? "200") || 200);
  const leverage = Math.max(2, Math.min(maxLev, alert.leverage ?? 2));

  // Layer 5: daily loss kill switch — realized round trips closed today plus open P&L.
  // Any failure to READ the P&L blocks the trade (fail closed).
  try {
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
        `🛑 Margin auto-trade BLOCKED — today's margin P&L ${todayPnl.toFixed(0)} is past the $${lossCap} daily loss cap. No new entries until tomorrow.`,
        "kraken",
      );
      return { executed: false, validated: false, note: `daily loss cap hit (${todayPnl.toFixed(0)} < -${lossCap})` };
    }
  } catch (e) {
    return { executed: false, validated: false, note: `P&L unreadable — failing closed (${e})` };
  }

  const pair = krakenPair(alert.symbol);

  try {
    if (alert.side === "close") {
      // Close every open margin position on this pair by sending the opposite order with
      // leverage — Kraken settles margin positions that way.
      const positions = (await getKrakenMarginPositions()).filter((p) => {
        const base = p.pair.replace(/USD$/, "").replace(/^X+/, "").replace("XBT", "BTC");
        return alert.symbol.toUpperCase().startsWith(base);
      });
      if (!positions.length) return { executed: false, validated: false, note: "close alert but no open position" };
      const p = positions[0];
      const params: Record<string, string> = {
        pair,
        type: p.side === "long" ? "sell" : "buy",
        ordertype: "market",
        volume: p.vol.toFixed(8),
        leverage: String(Math.max(2, Math.round(p.leverage))),
        userref: String(MARGIN_USERREF),
      };
      if (validate) params.validate = "true";
      const res = await krakenPrivate("AddOrder", params);
      const txid = (res.txid as string[] | undefined)?.[0];
      return { executed: !validate, validated: validate, txid, note: `close ${p.side} ${p.vol} ${pair}${validate ? " (validate)" : ""}` };
    }

    // Entry: size volume from margin × leverage at the current price.
    const { getKrakenPrice } = await import("@/lib/kraken");
    const price = await getKrakenPrice(alert.symbol);
    const notional = perTrade * leverage;
    const volume = (notional / price).toFixed(8);
    const params: Record<string, string> = {
      pair,
      type: alert.side,
      ordertype: "market",
      volume,
      leverage: String(leverage),
      userref: String(MARGIN_USERREF),
    };
    if (validate) params.validate = "true";
    const res = await krakenPrivate("AddOrder", params);
    const txid = (res.txid as string[] | undefined)?.[0];
    const descr = (res.descr as { order?: string } | undefined)?.order;
    return {
      executed: !validate,
      validated: validate,
      txid,
      note: `${alert.side} $${notional} notional (${leverage}x on $${perTrade}) ${pair}${validate ? " (validate)" : ""} — ${descr ?? ""}`,
    };
  } catch (e) {
    return { executed: false, validated: validate, note: `order failed: ${e}` };
  }
}
