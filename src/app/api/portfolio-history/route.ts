import { getPortfolioHistory } from "@/lib/alpaca";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "1M";
    const timeframe = searchParams.get("timeframe") || "1D";
    const history = await getPortfolioHistory(period, timeframe);
    return Response.json(history);
  } catch (error) {
    console.error("[/api/portfolio-history]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
