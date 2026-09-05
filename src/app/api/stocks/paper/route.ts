import { prisma } from "@/lib/db";
import { recentStockPaperTrades, stockScore, stockStrategyBreakdown } from "@/lib/stock-shadow";
import { STOCK_UNIVERSE } from "@/lib/stock-paper-model";

// The stock paper book's scoreboard: record, per-sleeve verdicts, the trade log, and the
// latest scanner signals. Owner-only (route-access); read-only.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [score, strategies, log, lastRun] = await Promise.all([
      stockScore().catch(() => null),
      stockStrategyBreakdown().catch(() => []),
      recentStockPaperTrades(100).catch(() => []),
      prisma.agentConfig.findUnique({ where: { key: "stock_scan_last_run" } }).then((r) => r?.value ?? null).catch(() => null),
    ]);
    const signals = await prisma.$queryRawUnsafe<{ ts: Date; symbol: string; timeframe: string; kind: string; detail: string; price: number }[]>(
      `SELECT ts, symbol, timeframe, kind, detail, price FROM stock_scan_signals WHERE ts > now() - interval '24 hours' ORDER BY ts DESC LIMIT 60`,
    ).catch(() => []);
    return Response.json({
      score, strategies, log, lastRun,
      universe: STOCK_UNIVERSE,
      signals: signals.map((s) => ({ ...s, ts: s.ts.toISOString() })),
    });
  } catch (error) {
    console.error("[/api/stocks/paper]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
