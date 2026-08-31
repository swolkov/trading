import { prisma } from "@/lib/db";

// Lifetime order/trade log — Kraken only since the Aug 2026 futures retirement.
// (Historical FUT: rows remain in the table but are no longer served; the futures
// pages that displayed them are retired.) Read-only.
export const dynamic = "force-dynamic";

interface UnifiedOrder {
  category: "kraken";
  mode: "live";
  symbol: string;
  action: string;      // "buy" | "sell"
  size: number | null; // USD amount
  pnl: number | null;
  time: string;
  reason?: string | null;
}

export async function GET() {
  try {
    const krkRows = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "KRK:" } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    const orders: UnifiedOrder[] = krkRows.map((t) => ({
      category: "kraken" as const,
      mode: "live" as const,
      symbol: t.symbol.replace("KRK:", "").replace("/USD", ""),
      action: t.action === "kraken_buy" ? "buy" : "sell",
      size: t.price, // kraken logs the USD amount in `price`
      pnl: null,     // trend book — P&L is account-level, not per-trade
      time: t.createdAt.toISOString(),
      reason: t.reason,
    }));

    return Response.json({
      orders,
      summary: {
        total: orders.length,
        kraken: { count: orders.length },
      },
    });
  } catch (error) {
    console.error("[/api/orders/all]", error);
    return Response.json({ orders: [], error: String(error) }, { status: 500 });
  }
}
