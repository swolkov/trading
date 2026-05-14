// eslint-disable-next-line @typescript-eslint/no-require-imports
const YF = require("yahoo-finance2").default || require("yahoo-finance2");
const yf = new YF({ suppressNotices: ["ripHistorical"] });

const FUTURES_MAP: Record<string, string> = {
  MES: "ES=F",
  MNQ: "NQ=F",
  MGC: "GC=F",
  MYM: "YM=F",
  M2K: "RTY=F",
};

const CONTRACT_META: Record<string, { name: string; multiplier: number; tickSize: number; margin: number }> = {
  MES: { name: "Micro E-mini S&P 500", multiplier: 5, tickSize: 0.25, margin: 1320 },
  MNQ: { name: "Micro E-mini Nasdaq 100", multiplier: 2, tickSize: 0.25, margin: 1630 },
  MGC: { name: "Micro Gold", multiplier: 10, tickSize: 0.1, margin: 1000 },
  MYM: { name: "Micro E-mini Dow", multiplier: 0.5, tickSize: 1, margin: 880 },
  M2K: { name: "Micro E-mini Russell 2000", multiplier: 5, tickSize: 0.1, margin: 730 },
};

export async function GET() {
  try {
    const symbols = Object.values(FUTURES_MAP);
    const quotes = await yf.quote(symbols);

    const results = Object.entries(FUTURES_MAP).map(([micro, yahoo], i) => {
      const q = Array.isArray(quotes) ? quotes[i] : quotes;
      const meta = CONTRACT_META[micro];
      return {
        symbol: micro,
        yahooSymbol: yahoo,
        name: meta.name,
        multiplier: meta.multiplier,
        tickSize: meta.tickSize,
        margin: meta.margin,
        price: q?.regularMarketPrice ?? 0,
        change: q?.regularMarketChange ?? 0,
        changePercent: q?.regularMarketChangePercent ?? 0,
        prevClose: q?.regularMarketPreviousClose ?? 0,
        open: q?.regularMarketOpen ?? 0,
        high: q?.regularMarketDayHigh ?? 0,
        low: q?.regularMarketDayLow ?? 0,
        volume: q?.regularMarketVolume ?? 0,
        bid: q?.bid ?? 0,
        ask: q?.ask ?? 0,
        timestamp: q?.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
      };
    });

    return Response.json(results);
  } catch (error) {
    console.error("[/api/futures/quotes]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch futures quotes" },
      { status: 500 }
    );
  }
}
