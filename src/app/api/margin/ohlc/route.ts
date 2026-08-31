import { getKrakenOHLC, KRAKEN_INTERVALS, type KrakenInterval } from "@/lib/kraken-margin";

// Multi-timeframe candles for the cockpit charts, straight from Kraken's public feed —
// the same venue we trade on. ?symbol=BTC/USD&interval=15 (minutes; 3 is aggregated
// from 1m). Kraken caps each interval at 720 candles.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol") || "BTC/USD";
  const interval = Number(searchParams.get("interval") || "60");
  if (!KRAKEN_INTERVALS.includes(interval as KrakenInterval)) {
    return Response.json({ error: `interval must be one of ${KRAKEN_INTERVALS.join(",")}` }, { status: 400 });
  }
  try {
    const bars = await getKrakenOHLC(symbol, interval as KrakenInterval);
    return Response.json({ symbol, interval, bars });
  } catch (error) {
    console.error("[/api/margin/ohlc]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
