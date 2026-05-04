import { analyzeVolatility, scanUnusualActivity, calculateExpectedMove } from "@/lib/options-intelligence";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const symbol = searchParams.get("symbol");
    const symbols = searchParams.get("symbols")?.split(",") || [];

    if (action === "volatility" && symbol) {
      const vol = await analyzeVolatility(symbol);
      return Response.json(vol);
    }

    if (action === "flow") {
      const targetSymbols = symbols.length > 0 ? symbols : ["AAPL", "TSLA", "NVDA", "SPY", "QQQ", "AMZN", "META", "MSFT"];
      const flow = await scanUnusualActivity(targetSymbols);
      return Response.json(flow);
    }

    if (action === "expected-move" && symbol) {
      const days = parseInt(searchParams.get("days") || "7");
      const move = await calculateExpectedMove(symbol, days);
      return Response.json(move);
    }

    return Response.json({ error: "Specify action: volatility, flow, or expected-move" }, { status: 400 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
