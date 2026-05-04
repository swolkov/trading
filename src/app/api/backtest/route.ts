import { runBacktest, type BacktestConfig } from "@/lib/backtester";

export async function POST(request: Request) {
  try {
    const config: BacktestConfig = await request.json();
    const result = await runBacktest(config);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Backtest failed" },
      { status: 500 }
    );
  }
}
