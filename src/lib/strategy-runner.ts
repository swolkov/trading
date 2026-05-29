/**
 * Strategy-runner — adapter that lets the live engine call registry strategies.
 *
 * Each registry strategy declares its timeframe (1m … 1d). The engine's native bar storage is
 * 5m only, so this module:
 *   1. Fetches the bars the strategy actually needs (via Databento HTTP for daily/4h, native 5m otherwise).
 *   2. Caches the higher-timeframe pulls per day to avoid burning API calls.
 *   3. Returns a typed signal the engine can route through its existing evaluateAndTrade pipeline.
 */
import fs from "node:fs";
import type { OHLCBar, Strategy, StrategySignal } from "./strategies/types";

function dbnApiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  // Fallback for local dev — Railway always has the env var, this branch is for `npx tsx` runs.
  try {
    const env = fs.readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
    const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  throw new Error("DATABENTO_API_KEY not set");
}

// Daily-bar fetch (CME daily OHLCV). One row per session.
async function fetchDailyBarsFromDatabento(symbol: string, days: number): Promise<OHLCBar[]> {
  const end = new Date(Date.now() - 1 * 86_400_000); // yesterday — today is in-progress
  const start = new Date(end.getTime() - days * 86_400_000);
  const auth = "Basic " + Buffer.from(dbnApiKey() + ":").toString("base64");
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3", symbols: symbol + ".v.0", stype_in: "continuous",
    schema: "ohlcv-1d", start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    encoding: "csv", pretty_px: "true", pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Databento ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const csv = await res.text();
  const lines = csv.trim().split("\n").slice(1);
  return lines.map((line) => {
    const cols = line.split(",");
    return {
      t: new Date(cols[0]).getTime(),
      o: parseFloat(cols[4]), h: parseFloat(cols[5]),
      l: parseFloat(cols[6]), c: parseFloat(cols[7]),
      v: parseFloat(cols[8] || "0"),
    };
  }).filter((b) => isFinite(b.c) && b.c > 0);
}

// Cache higher-TF bars by (symbol, timeframe, day) — refresh once per UTC day.
const barCache = new Map<string, { day: string; bars: OHLCBar[] }>();

async function getBarsForStrategy(strategy: Strategy, currentDayBar: OHLCBar): Promise<OHLCBar[] | null> {
  if (strategy.timeframe !== "1d") return null; // for now, only daily is implemented; intraday strategies use engine's 5m

  const sym = strategy.applicableSymbols[0];
  if (!sym) return null;

  const key = `${sym}:1d`;
  const today = new Date().toISOString().slice(0, 10);
  let cached = barCache.get(key);
  if (!cached || cached.day !== today) {
    const bars = await fetchDailyBarsFromDatabento(sym, 30);
    cached = { day: today, bars };
    barCache.set(key, cached);
  }
  // Append today's in-progress bar so detect() sees current price action against prior NR4 candle.
  return [...cached.bars, currentDayBar];
}

/**
 * Run a single strategy against the current state. Returns a signal if conditions met.
 * Caller passes the strategy's current intraday bar (built from engine state) — for daily strategies
 * this is "today's in-progress candle" which the strategy compares against yesterday's completed one.
 */
export async function runStrategy(
  strategy: Strategy,
  currentBar: OHLCBar,
  symbol: string,
  now: number,
): Promise<StrategySignal | null> {
  try {
    const bars = await getBarsForStrategy(strategy, currentBar);
    if (!bars || bars.length === 0) return null;
    return strategy.detect(bars, { symbol, now });
  } catch (err) {
    console.warn(`[strategy-runner] ${strategy.id} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Build "today's in-progress daily bar" from a rolling intraday bar buffer. The strategy needs
 * o = today's open, h/l = today's running extremes, c = latest price.
 */
export function buildTodayDailyBar(intradayBars: OHLCBar[], nowMs: number): OHLCBar {
  const utcDayStart = new Date(nowMs);
  utcDayStart.setUTCHours(0, 0, 0, 0);
  const todayBars = intradayBars.filter((b) => b.t >= utcDayStart.getTime());
  if (todayBars.length === 0) {
    const last = intradayBars[intradayBars.length - 1];
    return { t: nowMs, o: last?.c ?? 0, h: last?.c ?? 0, l: last?.c ?? 0, c: last?.c ?? 0, v: 0 };
  }
  const o = todayBars[0].o;
  const h = Math.max(...todayBars.map((b) => b.h));
  const l = Math.min(...todayBars.map((b) => b.l));
  const c = todayBars[todayBars.length - 1].c;
  const v = todayBars.reduce((s, b) => s + b.v, 0);
  return { t: nowMs, o, h, l, c, v };
}
