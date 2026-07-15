import { prisma } from "@/lib/db";

// Unified lifetime order/trade log across ALL live systems — Futures (demo + live), Kraken, and Meme Lab.
// One place to see everything, categorized. Read-only. Retired Alpaca is intentionally excluded.
export const dynamic = "force-dynamic";

interface UnifiedOrder {
  category: "futures" | "kraken" | "meme";
  mode: "live" | "demo";
  symbol: string;
  action: string;      // cleaned action/type (e.g. "short", "stop loss", "buy", "sold")
  size: number | null; // contracts (futures) or USD (kraken/meme)
  pnl: number | null;
  time: string;
  reason?: string | null;
}

export async function GET() {
  try {
    const [futRows, krkRows, memeClosedRow, memeOpenRow] = await Promise.all([
      // Futures — both modes (live_ = live, futures_ = demo). shadow_ rows are retagged duplicates → excluded.
      prisma.autoTradeLog.findMany({
        where: { symbol: { startsWith: "FUT:" }, OR: [{ action: { startsWith: "live_" } }, { action: { startsWith: "futures_" } }] },
        orderBy: { createdAt: "desc" }, take: 800,
      }),
      prisma.autoTradeLog.findMany({ where: { symbol: { startsWith: "KRK:" } }, orderBy: { createdAt: "desc" }, take: 300 }),
      prisma.agentConfig.findUnique({ where: { key: "meme_live_closed" } }),
      prisma.agentConfig.findUnique({ where: { key: "meme_live_open" } }),
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

    const parse = (v: string | null | undefined): Record<string, unknown>[] => {
      try { const p = JSON.parse(v || "[]"); return Array.isArray(p) ? p : []; } catch { return []; }
    };
    const memeClosed = parse(memeClosedRow?.value);
    const memeOpen = parse(memeOpenRow?.value);
    const meme: UnifiedOrder[] = [
      ...memeClosed.map((m) => ({
        category: "meme" as const, mode: "live" as const,
        symbol: String(m.name ?? m.mint ?? "?").split(" /")[0],
        action: `closed · ${String(m.exitReason ?? "").replace(/_/g, " ")}`.trim(),
        size: typeof m.sizeUsd === "number" ? m.sizeUsd : null,
        pnl: typeof m.realizedUsd === "number" ? m.realizedUsd : null,
        time: String(m.exitTs ?? m.entryTs ?? ""),
        reason: typeof m.realizedPct === "number" ? `${(m.realizedPct * 100).toFixed(0)}%` : null,
      })),
      ...memeOpen.map((m) => ({
        category: "meme" as const, mode: "live" as const,
        symbol: String(m.name ?? m.mint ?? "?").split(" /")[0],
        action: "open",
        size: typeof m.sizeUsd === "number" ? m.sizeUsd : null,
        pnl: null,
        time: String(m.entryTs ?? ""),
        reason: typeof m.lastPnlPct === "number" ? `unrealized ${(m.lastPnlPct * 100).toFixed(0)}%` : null,
      })),
    ];

    const orders = [...futures, ...kraken, ...meme]
      .filter((o) => o.time)
      .sort((a, b) => b.time.localeCompare(a.time));

    // Per-category realized P&L summary (futures + meme have per-trade P&L; kraken is account-level).
    const sum = (arr: UnifiedOrder[]) => arr.reduce((s, o) => s + (o.pnl ?? 0), 0);
    return Response.json({
      orders,
      summary: {
        total: orders.length,
        futures: { count: futures.length, pnl: sum(futures) },
        kraken: { count: kraken.length },
        meme: { count: meme.length, pnl: sum(meme) },
      },
    });
  } catch (error) {
    console.error("[/api/orders/all]", error);
    return Response.json({ orders: [], error: String(error) }, { status: 500 });
  }
}
