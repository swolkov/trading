import fs from "node:fs";
import path from "node:path";

/**
 * Open-interest positioning endpoint.
 *
 * Pulls Databento `statistics` schema (CME GLOBEX) for the requested symbol,
 * filters to stat_type 9 (Open Interest), and returns daily OI levels + day-
 * over-day changes for the last N days.
 *
 * Why: OI rising with rising price = longs adding (bullish positioning).
 *      OI rising with falling price = shorts adding (bearish positioning).
 *      OI falling = position unwinding (short-covering or long-liquidation).
 *
 * Pairs with `daily_closes` (computed from local 1m CSVs) to surface the
 * positioning regime.
 */

interface StatRec { tsEvent: number; statType: number; price: number; }

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  try {
    const env = fs.readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch { /* swallow */ }
  return "";
}

const KNOWN_SYMBOLS = new Set(["ES", "NQ", "GC", "MBT", "MET", "BFF", "MXR", "MSL"]);

async function fetchStatsWindow(symbol: string, startISO: string, endISO: string): Promise<StatRec[]> {
  const KEY = apiKey();
  if (!KEY) return [];
  const auth = "Basic " + Buffer.from(KEY + ":").toString("base64");
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3", symbols: `${symbol}.v.0`, stype_in: "continuous", schema: "statistics",
    start: startISO, end: endISO, encoding: "csv", pretty_px: "true", pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Databento ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const csv = await res.text();
  const rows = csv.trim().split("\n");
  if (rows.length < 2) return [];
  const header = rows[0].split(",");
  const tsIdx = header.indexOf("ts_event");
  const typeIdx = header.indexOf("stat_type");
  const priceIdx = header.indexOf("price");
  const out: StatRec[] = [];
  for (const r of rows.slice(1)) {
    const c = r.split(",");
    const tsEvent = new Date(c[tsIdx]).getTime();
    const statType = parseInt(c[typeIdx], 10);
    const price = parseFloat(c[priceIdx]);
    if (!isNaN(tsEvent) && !isNaN(statType) && !isNaN(price)) out.push({ tsEvent, statType, price });
  }
  return out;
}

function dailyCloses(symbol: string): Map<string, number> {
  const p = path.join(process.cwd(), "data", `${symbol}_1m.csv`);
  if (!fs.existsSync(p)) return new Map();
  const rows = fs.readFileSync(p, "utf8").trim().split("\n").slice(1);
  const map = new Map<string, number>();
  for (const r of rows) {
    const c = r.split(",");
    const ts = new Date(c[0]).getTime();
    const close = parseFloat(c[7]);
    if (isNaN(ts) || isNaN(close)) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    map.set(date, close); // last close wins
  }
  return map;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const symbol = (url.searchParams.get("symbol") || "ES").toUpperCase();
    const days = parseInt(url.searchParams.get("days") || "30", 10);
    if (!KNOWN_SYMBOLS.has(symbol)) {
      return Response.json({ error: `Unknown symbol: ${symbol}. Known: ${[...KNOWN_SYMBOLS].join(", ")}` }, { status: 400 });
    }

    const end = new Date(Date.now() - 4 * 86_400_000);
    const start = new Date(end.getTime() - days * 86_400_000);
    const stats = await fetchStatsWindow(symbol, start.toISOString().slice(0, 19), end.toISOString().slice(0, 19));

    // Filter to stat_type 9 (Open Interest), one record per day (latest of day)
    const oiByDate = new Map<string, number>();
    for (const r of stats.filter((s) => s.statType === 9)) {
      const d = new Date(r.tsEvent).toISOString().slice(0, 10);
      // Keep latest record per day
      const existing = oiByDate.get(d);
      if (existing === undefined || r.tsEvent > existing) oiByDate.set(d, r.price);
    }

    const closes = dailyCloses(symbol);
    const dates = [...oiByDate.keys()].sort();
    const series = dates.map((d, i) => {
      const oi = oiByDate.get(d)!;
      const prevOi = i > 0 ? oiByDate.get(dates[i - 1])! : null;
      const oiChange = prevOi !== null ? oi - prevOi : 0;
      const close = closes.get(d) ?? null;
      const prevClose = i > 0 ? closes.get(dates[i - 1]) ?? null : null;
      const priceChange = (close !== null && prevClose !== null) ? close - prevClose : null;

      // Interpretation
      let regime: "longs_adding" | "shorts_adding" | "longs_unwinding" | "shorts_covering" | "unchanged" | "unknown" = "unknown";
      if (priceChange !== null) {
        if (oiChange > 0 && priceChange > 0) regime = "longs_adding";
        else if (oiChange > 0 && priceChange < 0) regime = "shorts_adding";
        else if (oiChange < 0 && priceChange > 0) regime = "shorts_covering";
        else if (oiChange < 0 && priceChange < 0) regime = "longs_unwinding";
        else regime = "unchanged";
      }

      return { date: d, openInterest: oi, oiChange, close, priceChange, regime };
    });

    return Response.json({ symbol, days, recordsTotal: stats.length, series });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
