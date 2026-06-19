// ============ PAPER ACCOUNT RESET ============
// Flatten the Alpaca PAPER account and lock a fresh $1K-test baseline, so /day-trade measures
// P&L from a clean flat start. Runs SERVER-SIDE only (where the sealed Alpaca keys resolve).
//
// Triggered out-of-band via the DB flag `alpaca_flatten_requested` (set to any timestamp);
// the crypto cron consumes it on its next 5-min tick and marks it "done". This is the safe
// path: liquidation runs where the keys live, not from anyone's shell.

import { getAccount, getPositions, getOrders, cancelOrder, placeOrder, placeCryptoOrder } from "./alpaca";
import { prisma } from "./db";

export interface FlattenResult {
  total: number;
  crypto: number;
  stocks: number;
  failed: number;
  baseline: number;
  startISO: string;
}

// Cancel resting orders, close every PAPER position, then anchor a clean baseline.
// Crypto fills immediately (24/7); stock market orders submitted while the market is closed
// queue for the next open — equity is ~invariant to liquidation so the baseline is still clean.
export async function flattenPaperAndResetBaseline(): Promise<FlattenResult> {
  // 1. Cancel resting orders so queued entries don't refill behind us.
  try {
    const open = await getOrders("open", "paper");
    for (const o of open) {
      try { await cancelOrder(o.id); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }

  // 2. Close every open position (sell longs, buy-to-cover shorts).
  const positions = await getPositions("paper");
  let crypto = 0, stocks = 0, failed = 0;
  for (const p of positions) {
    const qty = Math.abs(parseFloat(p.qty));
    if (qty <= 0) continue;
    const side = p.side === "long" ? "sell" : "buy";
    try {
      if (p.asset_class === "crypto") {
        await placeCryptoOrder({ symbol: p.symbol, qty: String(qty), side, type: "market" }, "paper");
        crypto++;
      } else {
        await placeOrder({ symbol: p.symbol, qty: String(qty), side, type: "market", time_in_force: "day" }, "paper");
        stocks++;
      }
    } catch {
      failed++;
    }
  }

  // 3. Lock a clean baseline for the $1K test P&L.
  const after = await getAccount("paper");
  const baseline = parseFloat(after.equity);
  const startISO = new Date().toISOString();
  await prisma.agentConfig.upsert({
    where: { key: "alpaca_test_baseline_equity" },
    update: { value: String(baseline) },
    create: { key: "alpaca_test_baseline_equity", value: String(baseline) },
  });
  await prisma.agentConfig.upsert({
    where: { key: "alpaca_test_start" },
    update: { value: startISO },
    create: { key: "alpaca_test_start", value: startISO },
  });

  return { total: positions.length, crypto, stocks, failed, baseline, startISO };
}

// Consumed by the crypto cron: if a flatten was requested, run it once and mark it done.
// Returns a short status string when it acted, else null. Never throws to the caller's flow.
export async function maybeFlattenPaper(): Promise<string | null> {
  try {
    const flag = await prisma.agentConfig.findUnique({ where: { key: "alpaca_flatten_requested" } });
    if (!flag || !flag.value || flag.value === "done") return null;
    const r = await flattenPaperAndResetBaseline();
    await prisma.agentConfig.update({ where: { key: "alpaca_flatten_requested" }, data: { value: "done" } });
    return `Flattened ${r.total} positions (${r.crypto} crypto, ${r.stocks} stock queued, ${r.failed} failed). Baseline $${r.baseline.toLocaleString()} at ${r.startISO}.`;
  } catch (e) {
    console.error("[paper-reset] maybeFlattenPaper failed:", e);
    return null;
  }
}
