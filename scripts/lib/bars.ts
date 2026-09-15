// HISTORICAL BARS for the crypto research scripts (C6, Sep 15 2026).
//
// data/crypto/<COIN>.csv holds Binance USDT-pair 1h klines (t in ms, o h l c v) from 2024-01 —
// a proxy for Kraken USD spot that tracks closely enough for a replay, and the only source that
// reaches past Kraken's 720-bar OHLC window (120 days of 4h). `aggregate` rolls the hourly bars
// up to 4h and 1d on UTC boundaries: 4h bars open at 00/04/08/12/16/20 UTC, exactly the bars
// isFourHourClose (margin-live-risk.ts) treats as 4h closes, so a replay's "4h close" is the
// live desk's 4h close. Going forward the desk keeps its own native 4h history in
// margin_bars_4h (src/lib/margin-bars-cache.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KrakenBar } from "../../src/lib/kraken-margin";
import { FOUR_H_SEC } from "../../src/lib/margin-live-risk";

export const DAY_SEC = 86_400;
export const DEFAULT_DATA_DIR = join(process.cwd(), "data", "crypto");
export const RESEARCH_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK", "ADA", "LTC", "SUI"] as const;

/** Parse a CSV of `t,o,h,l,c,v` rows (t in ms or s) into bars in seconds, sorted, de-duplicated by t. */
export function parseBarsCsv(text: string): KrakenBar[] {
  const out: KrakenBar[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("t,")) continue;
    const [t, o, h, l, c, v] = line.split(",");
    const tn = Number(t);
    if (!Number.isFinite(tn)) continue;
    const bar: KrakenBar = { t: tn > 1e11 ? Math.floor(tn / 1000) : tn, o: +o, h: +h, l: +l, c: +c, v: +v };
    if ([bar.o, bar.h, bar.l, bar.c].some((x) => !Number.isFinite(x))) continue;
    out.push(bar);
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((b, i) => i === 0 || b.t !== out[i - 1].t);
}

/** Hourly bars for a coin, or null when the file is absent. */
export function loadHourly(coin: string, dir: string = DEFAULT_DATA_DIR): KrakenBar[] | null {
  const path = join(dir, `${coin}.csv`);
  if (!existsSync(path)) return null;
  return parseBarsCsv(readFileSync(path, "utf8"));
}

/**
 * Roll bars up to `stepSec` buckets on UTC boundaries (bucket = t − t mod step). A bucket's open
 * is its first bar's open, close its last bar's close, high/low the extremes, volume the sum.
 * Buckets with no bars are simply absent (the scanner reads Kraken the same way). The last
 * bucket may be PARTIAL if the input ends mid-bucket — callers that need only complete bars
 * drop it with `completeOnly`.
 */
export function aggregate(bars: KrakenBar[], stepSec: number, completeOnly = true): KrakenBar[] {
  const out: KrakenBar[] = [];
  let cur: KrakenBar | null = null;
  let lastInputT = -Infinity;
  for (const b of bars) {
    const bucket = b.t - (b.t % stepSec);
    if (cur && cur.t === bucket) {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v;
    } else {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    }
    lastInputT = b.t;
  }
  if (cur) {
    // The last bucket is complete only if the input reached its final sub-bar (1h input assumed).
    const inputStep = bars.length >= 2 ? bars[1].t - bars[0].t : stepSec;
    if (!completeOnly || lastInputT + inputStep >= cur.t + stepSec) out.push(cur);
  }
  // A first bucket the input joined mid-way has the wrong open and extremes: dropped when only
  // complete bars are wanted (the CSVs start on 2024-01-01 00:00, so this is a guard, not a path).
  if (completeOnly && out.length && bars.length && bars[0].t !== out[0].t) out.shift();
  return out;
}

export const to4h = (bars: KrakenBar[], completeOnly = true) => aggregate(bars, FOUR_H_SEC, completeOnly);
export const to1d = (bars: KrakenBar[], completeOnly = true) => aggregate(bars, DAY_SEC, completeOnly);

/** Bars whose open time lies in [fromIso, toIso). */
export function between(bars: KrakenBar[], fromIso: string, toIso: string): KrakenBar[] {
  const a = Date.parse(fromIso) / 1000, b = Date.parse(toIso) / 1000;
  return bars.filter((x) => x.t >= a && x.t < b);
}

export interface CoinBars { coin: string; h1: KrakenBar[]; h4: KrakenBar[]; d: KrakenBar[] }

/** Every research coin with a CSV present, aggregated. Missing coins are reported, never fatal. */
export function loadResearchBars(dir: string = DEFAULT_DATA_DIR, coins: readonly string[] = RESEARCH_COINS): { bars: CoinBars[]; missing: string[] } {
  const bars: CoinBars[] = [], missing: string[] = [];
  for (const coin of coins) {
    const h1 = loadHourly(coin, dir);
    if (!h1 || h1.length < 24 * 30) { missing.push(coin); continue; }
    bars.push({ coin, h1, h4: to4h(h1), d: to1d(h1) });
  }
  return { bars, missing };
}
