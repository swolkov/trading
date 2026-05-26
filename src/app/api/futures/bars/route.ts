import { getFuturesIntradayBars, getFuturesDailyBars } from "@/lib/futures-data";
import { getDatabentoIntradayBars } from "@/lib/databento";
import { getViewMode } from "@/lib/trading-mode";
import { prisma } from "@/lib/db";

// Map chart symbol → the live_quotes symbol the Databento sidecar writes (ES/NQ/GC)
const LIVE_MAP: Record<string, string> = { ES: "ES", NQ: "NQ", GC: "GC", MES: "ES", MNQ: "NQ", MGC: "GC" };

// Real-time edge: extend the latest bar with the sidecar's live mid (clears the ~7-min historical lag).
async function appendLiveTick(bars: { t: number; o: number; h: number; l: number; c: number; v: number }[], symbol: string, interval: string) {
  try {
    const lqSym = LIVE_MAP[symbol] || symbol;
    const rows = await prisma.$queryRawUnsafe<{ mid: number; ts: bigint | number }[]>("SELECT mid, ts FROM live_quotes WHERE symbol = $1 LIMIT 1", lqSym);
    const r = rows?.[0]; if (!r) return bars;
    const mid = Number(r.mid), ts = Number(r.ts);
    if (!(mid > 0) || Date.now() - ts > 60_000) return bars;   // only a FRESH (<60s) live quote
    const sec = interval === "1s" ? 1 : interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : 3600;
    const bucket = Math.floor(Date.now() / 1000 / sec) * sec;
    const out = bars.slice();   // don't mutate the cached array
    const last = out[out.length - 1];
    if (last && last.t === bucket) out[out.length - 1] = { ...last, h: Math.max(last.h, mid), l: Math.min(last.l, mid), c: mid };
    else if (!last || bucket > last.t) out.push({ t: bucket, o: mid, h: mid, l: mid, c: mid, v: 0 });
    return out;
  } catch { return bars; }
}

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

// Shared DB bars-cache → fast even on COLD Vercel instances (per-instance memory cache misses on cold starts).
async function cachedBars<T>(key: string, maxAgeSec: number, fetcher: () => Promise<T>): Promise<T> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ payload: unknown; age: number }[]>(
      "SELECT payload, EXTRACT(EPOCH FROM (now()-ts)) AS age FROM bars_cache WHERE key=$1", key);
    if (rows?.[0] && Number(rows[0].age) < maxAgeSec) return rows[0].payload as T;
  } catch { /* table may not exist yet — fall through to fetch */ }
  const data = await fetcher();
  try {
    await prisma.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS bars_cache(key text PRIMARY KEY, payload jsonb, ts timestamptz DEFAULT now())");
    await prisma.$executeRawUnsafe("INSERT INTO bars_cache(key,payload,ts) VALUES($1,$2::jsonb,now()) ON CONFLICT(key) DO UPDATE SET payload=$2::jsonb, ts=now()", key, JSON.stringify(data));
  } catch { /* cache write best-effort */ }
  return data;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "MES").toUpperCase();
    const interval = searchParams.get("interval") || "5m";
    const viewMode = await getViewMode("futures");

    // Intraday intervals — include VWAP + key levels
    if (interval === "1s" || interval === "1m" || interval === "5m" || interval === "15m" || interval === "1h") {
      const range = interval === "1h" ? "5d" : "1d";
      // PRIMARY: Databento. 1s/1m are Databento-only; 5m/15m/1h fall back to Tradovate→Yahoo if empty.
      let provider = "databento";
      let bars = await cachedBars(`dbn|${symbol}|${interval}|${range}`, 120, () => getDatabentoIntradayBars(symbol, interval as "1s" | "1m" | "5m" | "15m" | "1h", range as "1d" | "5d"));
      if ((!bars || bars.length === 0) && (interval === "5m" || interval === "15m" || interval === "1h")) {
        provider = "tradovate-yahoo";
        bars = await getFuturesIntradayBars(symbol, interval, range as "1d" | "5d", viewMode);
      }
      bars = await appendLiveTick(bars, symbol, interval);   // real-time latest price from the sidecar

      // Compute VWAP series (running values per bar)
      const vwapSeries = bars.length > 0 ? calcVwapSeries(bars) : [];

      // Key levels from yesterday's bars
      let prevDayHigh = 0, prevDayLow = 0;
      try {
        const dailyBars = await cachedBars(`daily|${symbol}|${viewMode}`, 600, () => getFuturesDailyBars(symbol, 5, viewMode));
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
