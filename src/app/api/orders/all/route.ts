import { prisma } from "@/lib/db";
import { getLiveFuturesPnl } from "@/lib/live-pnl";

// Unified lifetime order/trade log across ALL live systems — Futures (demo + live) and Kraken.
// One place to see everything, categorized. Read-only. Retired Alpaca + Meme Lab are intentionally excluded.
export const dynamic = "force-dynamic";

interface UnifiedOrder {
  category: "futures" | "kraken";
  mode: "live" | "demo";
  symbol: string;
  action: string;      // cleaned action/type (e.g. "short", "stop loss", "buy", "sold")
  size: number | null; // contracts (futures) or USD (kraken)
  pnl: number | null;
  time: string;
  reason?: string | null;
}

export async function GET() {
  try {
    const [futRows, krkRows, liveFuturesPnl] = await Promise.all([
      // Futures — both modes (live_ = live, futures_ = demo). shadow_ rows are retagged duplicates → excluded.
      prisma.autoTradeLog.findMany({
        where: { symbol: { startsWith: "FUT:" }, OR: [{ action: { startsWith: "live_" } }, { action: { startsWith: "futures_" } }] },
        orderBy: { createdAt: "desc" }, take: 800,
      }),
      prisma.autoTradeLog.findMany({ where: { symbol: { startsWith: "KRK:" } }, orderBy: { createdAt: "desc" }, take: 300 }),
      // Balance-based live-futures P&L (single source of truth — NOT a sum of the row log above).
      getLiveFuturesPnl().catch(() => null),
    ]);

    const futures: UnifiedOrder[] = futRows
      .filter((t) => !t.reason?.includes("SUPERSEDED"))
      .map((t) => ({
        category: "futures" as const,
        mode: t.action.startsWith("live_") ? "live" as const : "demo" as const,
        symbol: t.symbol.replace("FUT:", ""),
        action: t.action.replace(/^(live_|futures_)/, "").replace(/_/g, " "),
        size: t.qty || null,
        pnl: t.pnl,
        time: t.createdAt.toISOString(),
        reason: t.reason,
      }));

    const kraken: UnifiedOrder[] = krkRows.map((t) => ({
      category: "kraken" as const,
      mode: "live" as const,
      symbol: t.symbol.replace("KRK:", "").replace("/USD", ""),
      action: t.action === "kraken_buy" ? "buy" : "sell",
      size: t.price, // kraken logs the USD amount in `price`
      pnl: null,     // accumulator/trend book — P&L is account-level, not per-trade
      time: t.createdAt.toISOString(),
      reason: t.reason,
    }));

    const orders = [...futures, ...kraken]
      .filter((o) => o.time)
      .sort((a, b) => b.time.localeCompare(a.time));

    // Per-category realized P&L summary (futures has per-trade P&L; kraken is account-level).
    const sum = (arr: UnifiedOrder[]) => arr.reduce((s, o) => s + (o.pnl ?? 0), 0);
    return Response.json({
      orders,
      // Balance-based live-futures P&L (broker delta, incident excluded). Callers should show "—" when ok===false.
      liveFuturesPnl,
      summary: {
        total: orders.length,
        futures: { count: futures.length, pnl: sum(futures) },
        kraken: { count: kraken.length },
      },
    });
  } catch (error) {
    console.error("[/api/orders/all]", error);
    return Response.json({ orders: [], error: String(error) }, { status: 500 });
  }
}
