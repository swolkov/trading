import { getHistoricalBars, getIntradayBars } from "@/lib/yahoo";

const FUTURES_MAP: Record<string, string> = {
  MES: "ES=F",
  MNQ: "NQ=F",
  MYM: "YM=F",
  M2K: "RTY=F",
  MGC: "GC=F",
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "MES").toUpperCase();
    const interval = searchParams.get("interval") || "5m";

    const yahooSymbol = FUTURES_MAP[symbol] || FUTURES_MAP.MES;

    // Intraday intervals
    if (interval === "5m" || interval === "15m" || interval === "1h") {
      const range = interval === "1h" ? "5d" : "1d";
      const bars = await getIntradayBars(
        yahooSymbol,
        interval as "5m" | "15m" | "1h",
        range as "1d" | "5d"
      );
      return Response.json(bars);
    }

    // Daily bars
    const days = interval === "1W" ? 7 : interval === "1M" ? 30 : interval === "3M" ? 90 : interval === "1Y" ? 365 : 30;
    const bars = await getHistoricalBars(yahooSymbol, days);
    return Response.json(bars);
  } catch (error) {
    console.error("[/api/futures/bars]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch futures bars" },
      { status: 500 }
    );
  }
}
