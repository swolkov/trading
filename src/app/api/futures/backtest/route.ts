import { runFuturesBacktest } from "@/lib/futures-backtest";

export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "ES=F";
    const days = Math.min(55, parseInt(searchParams.get("days") || "55"));

    const result = await runFuturesBacktest(symbol, days);

    // Strip individual trades to reduce payload (keep last 50 for display)
    return Response.json({
      ...result,
      allTrades: result.allTrades.slice(-50),
    });
  } catch (error) {
    console.error("[/api/futures/backtest]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Backtest failed" },
      { status: 500 }
    );
  }
}
