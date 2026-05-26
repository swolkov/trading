import { getFuturesIntradayBars, getFuturesDailyBars } from "@/lib/futures-data";
import { getDatabentoIntradayBars } from "@/lib/databento";
import { getViewMode } from "@/lib/trading-mode";

// VWAP calculation (running, per-bar values for chart overlay)
function calcVwapSeries(bars: { t: number; h: number; l: number; c: number; v: number }[]): { t: number; vwap: number; upper: number; lower: number }[] {
  let cumPV = 0, cumV = 0, cumPV2 = 0;
  const result: { t: number; vwap: number; upper: number; lower: number }[] = [];
  for (const bar of bars) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    cumPV += typical * bar.v;
    cumPV2 += typical * typical * bar.v;
    cumV += bar.v;
    const vwap = cumV > 0 ? cumPV / cumV : 0;
    const variance = cumV > 0 ? (cumPV2 / cumV) - (vwap * vwap) : 0;
    const stdDev = Math.sqrt(Math.max(0, variance));
    result.push({ t: bar.t, vwap, upper: vwap + stdDev, lower: vwap - stdDev });
  }
  return result;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "MES").toUpperCase();
    const interval = searchParams.get("interval") || "5m";
    const viewMode = await getViewMode("futures");

    // Intraday intervals — include VWAP + key levels
    if (interval === "5m" || interval === "15m" || interval === "1h") {
      const range = interval === "1h" ? "5d" : "1d";
      // PRIMARY: Databento (canonical, ~7-min-delayed historical). Fall back to Tradovate→Yahoo if empty.
      let provider = "databento";
      let bars = await getDatabentoIntradayBars(symbol, interval as "5m" | "15m" | "1h", range as "1d" | "5d");
      if (!bars || bars.length === 0) {
        provider = "tradovate-yahoo";
        bars = await getFuturesIntradayBars(symbol, interval as "5m" | "15m" | "1h", range as "1d" | "5d", viewMode);
      }

      // Compute VWAP series (running values per bar)
      const vwapSeries = bars.length > 0 ? calcVwapSeries(bars) : [];

      // Key levels from yesterday's bars
      let prevDayHigh = 0, prevDayLow = 0;
      try {
        const dailyBars = await getFuturesDailyBars(symbol, 5, viewMode);
        if (dailyBars.length >= 2) {
          const prevDay = dailyBars[dailyBars.length - 2];
          prevDayHigh = prevDay.h;
          prevDayLow = prevDay.l;
        }
      } catch {}

      // Opening range (first 3 bars of 5m = 15 min)
      let orHigh = 0, orLow = 0;
      if (interval === "5m" && bars.length >= 3) {
        const openBars = bars.slice(0, 3);
        orHigh = Math.max(...openBars.map(b => b.h));
        orLow = Math.min(...openBars.map(b => b.l));
      }

      return Response.json({
        bars,
        overlays: {
          vwapSeries,
          prevDayHigh,
          prevDayLow,
          openingRangeHigh: orHigh,
          openingRangeLow: orLow,
        },
        // Honest meta so the UI can tell the truth (provider/env/freshness). Databento not yet wired into
        // this path — bars still come from Tradovate→Yahoo (see DATABENTO-MIGRATION.md, Phase 1).
        meta: { viewMode, provider, count: bars.length, lastBarTs: bars.length && typeof bars[bars.length - 1].t === "number" ? (bars[bars.length - 1].t as number) : null },
      });
    }

    // Daily bars — no overlays
    const days = interval === "1W" ? 7 : interval === "1M" ? 30 : interval === "3M" ? 90 : interval === "1Y" ? 365 : 30;
    const bars = await getFuturesDailyBars(symbol, days, viewMode);
    return Response.json({ bars, overlays: null, meta: { viewMode, provider: "tradovate-yahoo", count: bars.length, lastBarTs: null } });
  } catch (error) {
    console.error("[/api/futures/bars]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch futures bars" },
      { status: 500 }
    );
  }
}
