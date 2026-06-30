// Long-term Dollar-Cost-Average agent (Alpaca).
//
// This is the ONE Alpaca activity with a genuine, durable edge: buy a fixed dollar amount of a
// broad target (default SPY) on a schedule and HOLD — harvesting the ~8-10%/yr equity risk premium
// with discipline. It is BUY-ONLY by design; it never auto-sells (long-term hold). Uses Alpaca
// fractional/notional orders so a small amount ($50) buys a slice of a $600 ETF.
//
// OFF by default. Enable with dca_enabled="true". Config keys (agentConfig):
//   dca_enabled    "true" to run                (default off)
//   dca_symbol     target ETF/stock             (default SPY)
//   dca_amount_usd $ per scheduled buy          (default 50)
//   dca_mode       "live" | "paper"             (default live — the funded $500)
import { prisma } from "./db";
import { getAccount, placeOrder } from "./alpaca";
import type { TradingMode } from "./trading-mode";

const DEFAULT_SYMBOL = "SPY";
const DEFAULT_AMOUNT = 50;

interface DcaConfig { enabled: boolean; symbol: string; amountUsd: number; mode: TradingMode; }

async function loadDcaConfig(): Promise<DcaConfig> {
  const rows = await prisma.agentConfig.findMany({
    where: { key: { in: ["dca_enabled", "dca_symbol", "dca_amount_usd", "dca_mode"] } },
  });
  const c: Record<string, string> = {};
  for (const r of rows) c[r.key] = r.value;
  return {
    enabled: c.dca_enabled === "true",
    symbol: (c.dca_symbol || DEFAULT_SYMBOL).toUpperCase(),
    amountUsd: parseFloat(c.dca_amount_usd) || DEFAULT_AMOUNT,
    mode: (c.dca_mode === "live" ? "live" : "paper") as TradingMode,
  };
}

export async function runDCA(): Promise<{ bought: boolean; details: string[] }> {
  const details: string[] = [];
  const cfg = await loadDcaConfig();
  if (!cfg.enabled) return { bought: false, details: ["DCA disabled (set dca_enabled=true to start)"] };

  try {
    const account = await getAccount(cfg.mode);
    const cash = parseFloat(account.cash);
    details.push(`DCA ${cfg.mode}: cash $${isFinite(cash) ? cash.toFixed(2) : "?"} | target ${cfg.symbol} | buy $${cfg.amountUsd}`);

    if (!isFinite(cash) || cash < cfg.amountUsd) {
      details.push(`Skip — not enough cash for a $${cfg.amountUsd} buy (fully deployed into ${cfg.symbol}, or add funds).`);
      return { bought: false, details };
    }

    // Fractional/notional MARKET buy. Alpaca only fills notional orders during market hours, so this
    // cron is scheduled at the open; a day order that misses the window simply doesn't fill (no harm).
    const order = await placeOrder({
      symbol: cfg.symbol,
      notional: cfg.amountUsd.toFixed(2),
      side: "buy",
      type: "market",
      time_in_force: "day",
    }, cfg.mode);

    details.push(`✅ DCA BUY: $${cfg.amountUsd} of ${cfg.symbol} (order ${order.id}) — buy & hold.`);
    try {
      await prisma.autoTradeLog.create({
        data: {
          symbol: `STK:${cfg.symbol}`,
          action: `dca_buy_${cfg.mode}`,
          qty: 0,
          reason: `Long-term DCA: bought $${cfg.amountUsd} of ${cfg.symbol} (buy & hold — equity risk premium). Cash before: $${cash.toFixed(2)}.`,
          orderId: order.id,
        },
      });
    } catch { /* logging is best-effort */ }
    return { bought: true, details };
  } catch (e) {
    details.push(`DCA error: ${e instanceof Error ? e.message : String(e)}`);
    return { bought: false, details };
  }
}
