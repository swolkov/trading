// THE REPLAY ENGINE (C6, Sep 15 2026) — extracted VERBATIM from scripts/backtest-variants.ts so
// every research script (backtest-variants, replay-walkforward) scores a trade the same way.
//
// entries()         every high-conviction breakout, collected ONCE so variants are compared on
//                   identical signals (the desk's own evaluate + scoreConviction, with the other
//                   timeframe as context exactly as the scanner sees it)
// simulate()        one entry under an exit profile — paper's managed exit, chase and fees
// simulatePyramid() the same with one add at +addAtR (risk-sized to the resting stop when asked)
// simulatePartial() the same with partialFrac banked at +partialAtR (margin-shadow-legs.ts)
// nonOverlapping()  one open trade per coin, decided by the CONTROL profile for every variant
// tOf() / welch()   the statistics; report() the one-line table row
//
// ⚠️ Behaviour is pinned: the Q2f line of backtest-variants (risk-sized pyramid on the 2R trail vs
// swing-wide, paired) must reproduce on the same bar cache before and after this extraction —
// tests/replay-engine.test.ts covers the arithmetic on hand-built series; the operating-model doc
// records the reproduction.
import { evaluate, scoreConviction, type ScanSignal, type TfSpec } from "../../src/lib/margin-scanner";
import { managedStop, type ExitProfile } from "../../src/lib/margin-shadow";
import { partialDue, partialFillPx, partialTradePnl, type LegFees } from "../../src/lib/margin-shadow-legs";
import type { KrakenBar } from "../../src/lib/kraken-margin";
import { readFileSync } from "node:fs";

export const TAKER = 0.0025, MAKER = 0.0016, CHASE = 0.001;   // Kraken US margin: taker ~0.25%, maker ~0.16%
export const ROLLOVER_4H: Record<string, number> = { BTC: 0.00015, ETH: 0.0002, SOL: 0.0003 };
export const ROLLOVER_DEFAULT = 0.0003;
export const REF_EQUITY = 5335, RISK_PCT = 0.06, RISK$ = REF_EQUITY * RISK_PCT;
/** The bar cache path: BARS_CACHE env, else the scratchpad file the Sep 9–12 replays used. */
export const CACHE = process.env.BARS_CACHE ?? "/tmp/claude-501/-Users-user-trading/9d589653-7ac2-433f-a03a-11e6aa69aeb5/scratchpad/bars.json";
export const TF: Record<string, TfSpec> = {
  "4h": { interval: 240, label: "4h", movePct: 0.05, realertMs: 0 },
  "1d": { interval: 1440, label: "1d", movePct: 0.07, realertMs: 0 },
};

export interface Entry { coin: string; tf: "4h" | "1d"; i: number; month: string }
export interface Result { pnl: number; r: number; reason: string }
export type BarCache = Record<string, { d: KrakenBar[]; h4: KrakenBar[] }>;

export function loadCache(path: string = CACHE): BarCache {
  return JSON.parse(readFileSync(path, "utf8")) as BarCache;
}

/** Every high-conviction breakout entry, collected ONCE so variants are compared on identical signals. */
export function entries(coin: string, tfLabel: "4h" | "1d", bars: KrakenBar[], ctx: KrakenBar[] | null): Entry[] {
  const tf = TF[tfLabel], out: Entry[] = [];
  for (let i = 25; i < bars.length - 1; i++) {
    const sigs = evaluate({ name: coin, symbol: `${coin}/USD` }, tf, bars.slice(0, i + 1));
    const brk = sigs.find((s) => s.kind === "breakout");
    if (!brk) continue;
    let all: ScanSignal[] = sigs;
    if (ctx) {
      const other = tfLabel === "4h" ? TF["1d"] : TF["4h"];
      const upto = ctx.filter((b) => b.t <= bars[i].t);
      if (upto.length >= 25) all = [...sigs, ...evaluate({ name: coin, symbol: `${coin}/USD` }, other, upto)];
    }
    if (scoreConviction(brk, all).tier !== "high") continue;
    out.push({ coin, tf: tfLabel, i, month: new Date(bars[i].t * 1000).toISOString().slice(2, 7) });
  }
  return out;
}

/** Simulate ONE entry under a given exit profile and entry fee. Same engine as paper. */
export function simulate(coin: string, bars: KrakenBar[], i: number, barH: number, p: ExitProfile, entryFee: number): Result & { exitBar: number } {
  const stopFrac = p.oneR;                       // exitParams called with entry=1 ⇒ fraction
  const holdBars = Math.ceil(p.maxHoldH / barH);
  const notional = RISK$ / stopFrac;
  const roll = ROLLOVER_4H[coin] ?? ROLLOVER_DEFAULT;
  const entry = bars[i].c * (1 + CHASE);
  const oneR = entry * stopFrac;
  let stop = entry - oneR, peak = entry, exit = entry, reason = "time stop", closedAt = bars[Math.min(i + holdBars, bars.length - 1)].t;
  let exitBar = Math.min(i + holdBars, bars.length - 1);
  for (let j = i + 1; j < bars.length && j <= i + holdBars; j++) {
    const b = bars[j];
    if (b.l <= stop) { exit = stop; reason = stop >= entry ? "trail" : "initial stop"; closedAt = b.t; exitBar = j; break; }
    peak = Math.max(peak, b.h);
    stop = managedStop(1, entry, peak, stop, oneR, p);
    exit = b.c; closedAt = b.t; exitBar = j;
  }
  const heldH = ((closedAt - bars[i].t) / 3600) || barH;
  const gross = (notional * (exit - entry)) / entry;
  const fees = notional * (entryFee + TAKER) + (p.carry ? notional * roll * (heldH / 4) : 0);
  const pnl = gross - fees;
  return { pnl, r: pnl / RISK$, reason, exitBar };
}

/**
 * PYRAMID: the same entry, but when a bar CLOSES at or above +addAtR (default +1R) a second unit
 * is added at that close (chased like the first) — of the same notional, or RISK-SIZED to the
 * resting stop when `sizeToStop` — and from then on the trail runs on the combined position.
 * Second unit pays its own taker fee and rollover.
 */
export function simulatePyramid(coin: string, bars: KrakenBar[], i: number, barH: number, p: ExitProfile, entryFee: number, sizeToStop = false, addAtR = 1): Result & { exitBar: number; added: boolean } {
  const stopFrac = p.oneR;
  const holdBars = Math.ceil(p.maxHoldH / barH);
  const notional = RISK$ / stopFrac;
  const roll = ROLLOVER_4H[coin] ?? ROLLOVER_DEFAULT;
  const entry = bars[i].c * (1 + CHASE);
  const oneR = entry * stopFrac;
  let stop = entry - oneR, peak = entry, exit = entry, reason = "time stop", closedAt = bars[Math.min(i + holdBars, bars.length - 1)].t;
  let exitBar = Math.min(i + holdBars, bars.length - 1);
  let add: { price: number; t: number; notional: number } | null = null;
  for (let j = i + 1; j < bars.length && j <= i + holdBars; j++) {
    const b = bars[j];
    if (b.l <= stop) { exit = stop; reason = stop >= entry ? "trail" : "initial stop"; closedAt = b.t; exitBar = j; break; }
    peak = Math.max(peak, b.h);
    stop = managedStop(1, entry, peak, stop, oneR, p);
    exit = b.c; closedAt = b.t; exitBar = j;
    if (!add && b.c >= entry + oneR * addAtR) {
      const price = b.c * (1 + CHASE);
      // RISK-SIZED ADD: the second unit risks exactly RISK$ to the stop that is resting at the
      // moment of the add — so the combined worst case from here is the same −1R as without
      // the add, whatever trail is running. (Same-notional adds on a 2R trail can risk ~2R.)
      const n2 = sizeToStop ? Math.min(notional, (RISK$ * price) / Math.max(price - stop, 1e-9)) : notional;
      add = { price, t: b.t, notional: n2 };
    }
  }
  const heldH = ((closedAt - bars[i].t) / 3600) || barH;
  let gross = (notional * (exit - entry)) / entry;
  let fees = notional * (entryFee + TAKER) + (p.carry ? notional * roll * (heldH / 4) : 0);
  if (add) {
    const heldH2 = ((closedAt - add.t) / 3600) || barH;
    gross += (add.notional * (exit - add.price)) / add.price;
    fees += add.notional * (TAKER + TAKER) + (p.carry ? add.notional * roll * (heldH2 / 4) : 0);
  }
  const pnl = gross - fees;
  return { pnl, r: pnl / RISK$, reason, exitBar, added: !!add };
}

/** The replay's fee model in the legs' shape: linear rollover (held ÷ 4), as simulate() charges it. */
export function replayLegFees(coin: string, entryFee: number): LegFees {
  return { entry: entryFee, taker: TAKER, roll4h: ROLLOVER_4H[coin] ?? ROLLOVER_DEFAULT, periods: (h) => h / 4 };
}

/**
 * PARTIAL (swing-partial, C5a): the same entry; on the first bar whose HIGH reaches +partialAtR
 * a `partialFrac` share is banked at that level (at the open when the bar gapped through), the
 * remainder keeps trailing on the first unit's R. Fee split = margin-shadow-legs.ts, with the
 * replay's linear rollover. Falls back to simulate() for a profile without a partial.
 */
export function simulatePartial(coin: string, bars: KrakenBar[], i: number, barH: number, p: ExitProfile, entryFee: number): Result & { exitBar: number; banked: boolean } {
  if (p.partialAtR == null || p.partialFrac == null) return { ...simulate(coin, bars, i, barH, p, entryFee), banked: false };
  const stopFrac = p.oneR;
  const holdBars = Math.ceil(p.maxHoldH / barH);
  const notional = RISK$ / stopFrac;
  const entry = bars[i].c * (1 + CHASE);
  const oneR = entry * stopFrac;
  let stop = entry - oneR, peak = entry, exit = entry, reason = "time stop", closedAt = bars[Math.min(i + holdBars, bars.length - 1)].t;
  let exitBar = Math.min(i + holdBars, bars.length - 1);
  let partial: { px: number; t: number; notional: number } | null = null;
  for (let j = i + 1; j < bars.length && j <= i + holdBars; j++) {
    const b = bars[j];
    if (b.l <= stop) { exit = stop; reason = stop >= entry ? "trail" : "initial stop"; closedAt = b.t; exitBar = j; break; }
    peak = Math.max(peak, b.h);
    stop = managedStop(1, entry, peak, stop, oneR, p);
    exit = b.c; closedAt = b.t; exitBar = j;
    if (!partial && partialDue(p.partialAtR, 1, entry, oneR, b, false)) partial = { px: partialFillPx(1, entry, oneR, p.partialAtR, b.o), t: b.t, notional: notional * p.partialFrac };
  }
  const tExit = closedAt;
  const fees = replayLegFees(coin, entryFee);
  if (!partial) {
    const s = simulate(coin, bars, i, barH, p, entryFee);
    return { ...s, banked: false };
  }
  const r = partialTradePnl({ dir: 1, entry, exit, notional, partial, tOpen: bars[i].t, tExit, carry: p.carry, fees });
  return { pnl: r.pnl, r: r.pnl / RISK$, reason, exitBar, banked: true };
}

/**
 * ONE OPEN TRADE PER COIN, exactly as paper enforces. Occupancy is decided by the CONTROL profile
 * for EVERY variant, so all variants are scored on an identical entry list and the comparison
 * stays paired. ⚠️ Generous to the longer-holding variants: the opportunity cost of holding is
 * not modelled.
 */
export function nonOverlapping(list: { e: Entry; bars: KrakenBar[] }[], barH: number, control: ExitProfile): { e: Entry; bars: KrakenBar[] }[] {
  const openUntil: Record<string, number> = {};
  const kept: { e: Entry; bars: KrakenBar[] }[] = [];
  for (const x of list) {
    if (x.e.i <= (openUntil[x.e.coin] ?? -1)) continue;
    kept.push(x);
    openUntil[x.e.coin] = simulate(x.e.coin, x.bars, x.e.i, barH, control, TAKER).exitBar;
  }
  return kept;
}

export interface Stat { n: number; mean: number; sd: number; t: number; ci: [number, number] }
export function tOf(xs: number[]): Stat {
  const n = xs.length; if (!n) return { n: 0, mean: 0, sd: 0, t: 0, ci: [0, 0] };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const se = sd / Math.sqrt(n);
  return { n, mean, sd, t: se > 0 ? mean / se : 0, ci: [mean - 1.96 * se, mean + 1.96 * se] };
}
/** Welch's t on mean(a) − mean(b) with its 95% CI; t = 0 when either side is degenerate. */
export function welch(a: number[], b: number[]): { diff: number; t: number; se: number; ci: [number, number] } {
  const A = tOf(a), B = tOf(b);
  const se = Math.sqrt((A.n ? A.sd ** 2 / A.n : 0) + (B.n ? B.sd ** 2 / B.n : 0));
  const diff = A.mean - B.mean;
  return { diff, se, t: se > 0 ? diff / se : 0, ci: [diff - 1.96 * se, diff + 1.96 * se] };
}
export const money = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(0)}`;
export function report(label: string, xs: number[], unit: "R" | "$" = "$", log: (s: string) => void = console.log): Stat {
  const s = tOf(xs);
  const fmt = (v: number) => (unit === "$" ? money(v) : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}R`);
  const verdict = Math.abs(s.t) >= 2 ? (s.t > 0 ? "SIGNIFICANT +" : "SIGNIFICANT −") : "not distinguishable from zero";
  log(`  ${label.padEnd(34)} n=${String(s.n).padStart(3)}  avg ${fmt(s.mean).padStart(9)}  t=${s.t.toFixed(2).padStart(6)}  95% CI ${fmt(s.ci[0])} … ${fmt(s.ci[1])}   ${verdict}`);
  return s;
}

// ---- Monte Carlo (MC1) --------------------------------------------------------------------------

/** mulberry32 — a small seeded PRNG so a bootstrap is reproducible run to run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Circular block bootstrap: `len` draws made of `block`-long consecutive runs of `sample`. */
export function blockBootstrap(sample: number[], len: number, block: number, rnd: () => number): number[] {
  const out: number[] = [];
  const n = sample.length;
  if (!n) return out;
  while (out.length < len) {
    const start = Math.floor(rnd() * n);
    for (let k = 0; k < block && out.length < len; k++) out.push(sample[(start + k) % n]);
  }
  return out;
}

export interface McPath { final: number; maxDD: number; streak: number; breaker: boolean }
/** One equity path: risk `riskFrac` of CURRENT equity per trade, R fee-inclusive; the 15% breaker halts the path. */
export function mcPath(rs: number[], equity0: number, riskFrac: number, breakerPct = 0.15): McPath {
  let eq = equity0, peak = equity0, maxDD = 0, streak = 0, best = 0, breaker = false;
  for (const R of rs) {
    eq = eq * (1 + riskFrac * R);
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
    if (R <= 0) { streak++; if (streak > best) best = streak; } else streak = 0;
    if (dd >= breakerPct) { breaker = true; break; }
  }
  return { final: eq / equity0 - 1, maxDD, streak: best, breaker };
}

export interface McSummary { riskPct: number; paths: number; pBreaker: number; medianDD: number; p95DD: number; longestStreakMedian: number; longestStreakP95: number; pMinus50: number; pPlus50: number; medianFinal: number }
export function monteCarlo(rs: number[], opts: { paths?: number; trades?: number; block?: number; equity?: number; riskPcts?: number[]; seed?: number } = {}): McSummary[] {
  const paths = opts.paths ?? 10_000, trades = opts.trades ?? 100, block = opts.block ?? 5, equity = opts.equity ?? 5000;
  const out: McSummary[] = [];
  for (const riskPct of opts.riskPcts ?? [3, 5, 8]) {
    const rnd = seededRandom((opts.seed ?? 20260915) + riskPct);
    const res: McPath[] = [];
    for (let k = 0; k < paths; k++) res.push(mcPath(blockBootstrap(rs, trades, block, rnd), equity, riskPct / 100));
    const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    out.push({
      riskPct, paths,
      pBreaker: res.filter((r) => r.breaker).length / paths,
      medianDD: q(res.map((r) => r.maxDD), 0.5), p95DD: q(res.map((r) => r.maxDD), 0.95),
      longestStreakMedian: q(res.map((r) => r.streak), 0.5), longestStreakP95: q(res.map((r) => r.streak), 0.95),
      pMinus50: res.filter((r) => r.final <= -0.5).length / paths, pPlus50: res.filter((r) => r.final >= 0.5).length / paths,
      medianFinal: q(res.map((r) => r.final), 0.5),
    });
  }
  return out;
}
