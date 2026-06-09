/**
 * EDGE DISCOVERY — honest cross-asset screen for the RSI mean-reversion family
 * (the one edge that survives OOS: gold). Built June 9 2026 after the edge re-audit.
 *
 * DISCIPLINE (the whole point):
 *  - Verified fill logic copied from the sound backtester: enter at the 5m bar CLOSE,
 *    resolve exits ONLY on 1m bars AFTER entry (no look-ahead), block overlapping trades.
 *  - Metrics in R-multiples (1R = stop distance) so no per-contract $ multiplier is needed
 *    and results are comparable across asset classes. Round-trip cost modeled as a fraction
 *    of the stop (sweep 0 / 5% / 10%). Survivors still need $-accurate validation.
 *  - SELECT on in-sample, CONFIRM once on out-of-sample. A config is a "candidate" only if it
 *    is positive in-sample AND holds OOS with adequate n. Multiple-testing footprint reported.
 *  - GC is the CONTROL: the engine must independently reproduce gold's known positive edge.
 *
 * DATA REALITY:
 *  - data/GC_1m.csv etc: ~3yr (2023-2026) → real multi-year OOS (2026 held out).
 *  - data/intraday/*: ~1yr (2025-2026) → EXPLORATORY only (train H2-2025 / test 2026); a
 *    5-month OOS is a lead, not a validation. Labeled as such.
 *
 * Run: node_modules/.bin/tsx scripts/edge-discovery.ts
 */
import fs from "node:fs";

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Cfg { lo: number; hi: number; stopMult: number; targetMult: number; }
interface Trade { dir: "long" | "short"; grossR: number; year: number; t: number; outcome: string; }

const RSI_PERIOD = 14, ATR_PERIOD = 14, MAX_HOLD = 24; // 24×5m = 2h
const SPLIT = Date.UTC(2026, 0, 1); // OOS = 2026+
const GRID: Cfg[] = [];
for (const [lo, hi] of [[20, 80], [25, 75], [30, 70]])
  for (const targetMult of [2.0, 3.0])
    GRID.push({ lo, hi, stopMult: 1.5, targetMult });

function loadCsv(path: string): Bar[] {
  const rows = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
  const out: Bar[] = [];
  for (const r of rows) {
    const c = r.split(",");
    const b = { t: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] };
    if (isFinite(b.c) && b.c > 0 && isFinite(b.t)) out.push(b);
  }
  out.sort((a, z) => a.t - z.t);
  return out;
}

function build5m(m1: Bar[]): Bar[] {
  const map = new Map<number, Bar>();
  for (const b of m1) {
    const bk = Math.floor(b.t / 300000) * 300000;
    const ex = map.get(bk);
    if (!ex) map.set(bk, { t: bk, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; }
  }
  return [...map.values()].sort((a, z) => a.t - z.t);
}

// Simple RSI at index i over closes[..i] (matches the existing backtester's style).
function rsiAt(closes: number[], i: number, period = RSI_PERIOD): number | null {
  if (i < period) return null;
  let g = 0, l = 0;
  for (let k = i - period + 1; k <= i; k++) { const ch = closes[k] - closes[k - 1]; if (ch > 0) g += ch; else l -= ch; }
  if (l === 0) return g === 0 ? 50 : 100;
  const rs = (g / period) / (l / period);
  return 100 - 100 / (1 + rs);
}
function atrAt(bars: Bar[], i: number, period = ATR_PERIOD): number {
  if (i < period) return 0;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  return s / period;
}

// Walk 1m bars from entryTime forward; return exit price + outcome. No look-ahead: starts AT entry.
// Time-exit falls back to the last bar WITHIN the hold window — never the global end of file
// (that bug books a multi-year fake trade and blocks everything after it). Returns null if the
// window has no data at all (data gap straddling entry) → the caller scratches the trade.
function resolveExit(m1: Bar[], startIdx: number, dir: "long" | "short", stop: number, target: number, maxTime: number) {
  let lastBar: Bar | null = null;
  for (let j = startIdx; j < m1.length; j++) {
    const b = m1[j];
    if (b.t > maxTime) break;
    lastBar = b;
    const hitStop = dir === "long" ? b.l <= stop : b.h >= stop;
    const hitTarget = dir === "long" ? b.h >= target : b.l <= target;
    if (hitStop) return { px: stop, outcome: "stop", t: b.t };          // both-in-bar → stop (conservative)
    if (hitTarget) return { px: target, outcome: "target", t: b.t };
  }
  if (!lastBar) return null;                                            // no data in window → scratch
  return { px: lastBar.c, outcome: "time", t: lastBar.t };             // time-exit at last in-window bar
}

function lowerBound(m1: Bar[], t: number): number { // first index with m1[idx].t >= t
  let lo = 0, hi = m1.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m1[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

function backtest(bars5: Bar[], m1: Bar[], cfg: Cfg): Trade[] {
  const closes = bars5.map((b) => b.c);
  const trades: Trade[] = [];
  let blockedUntil = 0;
  for (let i = Math.max(RSI_PERIOD, ATR_PERIOD) + 1; i < bars5.length; i++) {
    if (bars5[i].t < blockedUntil) continue;
    const r = rsiAt(closes, i); if (r == null) continue;
    const a = atrAt(bars5, i); if (a <= 0) continue;
    let dir: "long" | "short" | null = null;
    if (r <= cfg.lo) dir = "long"; else if (r >= cfg.hi) dir = "short"; else continue;

    const entry = bars5[i].c;
    const stopDist = cfg.stopMult * a;
    const stop = dir === "long" ? entry - stopDist : entry + stopDist;
    const target = dir === "long" ? entry + cfg.targetMult * a : entry - cfg.targetMult * a;
    const entryTime = bars5[i].t + 300000;            // exit walk starts AFTER the 5m bar closes
    const sIdx = lowerBound(m1, entryTime);
    if (sIdx >= m1.length) break;
    const ex = resolveExit(m1, sIdx, dir, stop, target, entryTime + MAX_HOLD * 300000);
    if (!ex) continue;                                // data gap straddling entry → scratch, don't block
    const grossR = (dir === "long" ? ex.px - entry : entry - ex.px) / stopDist;
    trades.push({ dir, grossR, year: new Date(bars5[i].t).getUTCFullYear(), t: bars5[i].t, outcome: ex.outcome });
    blockedUntil = ex.t;                               // no overlapping positions
  }
  return trades;
}

function pf(trades: Trade[], costR: number) {
  let gw = 0, gl = 0, wins = 0, sum = 0;
  for (const t of trades) { const r = t.grossR - costR; sum += r; if (r > 0) { gw += r; wins++; } else gl += -r; }
  return { n: trades.length, pf: gl > 0 ? gw / gl : gw > 0 ? 99 : 0, wr: trades.length ? wins / trades.length : 0, expR: trades.length ? sum / trades.length : 0, sumR: sum };
}

const COST = 0.05; // headline: round-trip cost = 5% of stop (≈1-2 ticks + comm on a 1.5×ATR stop)
const fmt = (s: { n: number; pf: number; expR: number }) => `PF ${(s.pf === 99 ? "INF" : s.pf.toFixed(2)).padStart(5)} n${String(s.n).padStart(4)} ${(s.expR >= 0 ? "+" : "")}${s.expR.toFixed(3)}R`;

function evalInstrument(label: string, path: string, isExploratory: boolean) {
  if (!fs.existsSync(path)) { console.log(`  ${label.padEnd(6)} — no data`); return null; }
  const m1 = loadCsv(path);
  const bars5 = build5m(m1);
  let best: { cfg: Cfg; is: ReturnType<typeof pf>; oos: ReturnType<typeof pf>; all: Trade[] } | null = null;
  for (const cfg of GRID) {
    const all = backtest(bars5, m1, cfg);
    const is = pf(all.filter((t) => t.t < SPLIT), COST);
    const oos = pf(all.filter((t) => t.t >= SPLIT), COST);
    // select by in-sample PF (with a minimum sample), as discipline requires
    if (is.n >= 40 && (!best || is.pf > best.is.pf)) best = { cfg, is, oos, all };
  }
  if (!best) { console.log(`  ${label.padEnd(6)} — too few trades`); return null; }
  const c = best.cfg;
  const candidate = best.is.pf > 1.0 && best.oos.pf >= 1.20 && best.oos.n >= (isExploratory ? 40 : 80);
  console.log(`  ${label.padEnd(6)} RSI${c.lo}/${c.hi} t${c.targetMult}  IS ${fmt(best.is)}  |  OOS ${fmt(best.oos)}  ${candidate ? "◀ CANDIDATE" : ""}`);
  return { label, best, candidate };
}

function main() {
  console.log(`\n══ EDGE DISCOVERY — RSI mean-reversion screen ══`);
  console.log(`  Grid: ${GRID.length} configs/instrument | cost=${COST * 100}% of stop | OOS = 2026+ | metric = R-multiples`);

  console.log(`\n── 3-YEAR UNIVERSE (real multi-year OOS; GC = control, must be positive) ──`);
  console.log(`  inst   best-config       in-sample(2023-25)        out-of-sample(2026)`);
  const threeYr = [["GC", "data/GC_1m.csv"], ["ES", "data/ES_1m.csv"], ["NQ", "data/NQ_1m.csv"]];
  const res3: any[] = [];
  for (const [lab, p] of threeYr) { const r = evalInstrument(lab, p, false); if (r) res3.push(r); }

  console.log(`\n── 1-YEAR UNIVERSE (EXPLORATORY — train H2'25 / test '26; leads only, NOT validated) ──`);
  console.log(`  inst   best-config       in-sample(H2-2025)        out-of-sample(2026)`);
  const oneYr = [
    ["GCx", "data/intraday/GC_1m.csv"], ["HG", "data/intraday/HG_1m.csv"],
    ["CL", "data/intraday/CL_1m.csv"], ["RB", "data/intraday/RB_1m.csv"], ["HO", "data/intraday/HO_1m.csv"],
    ["6E", "data/intraday/6E_1m.csv"], ["6B", "data/intraday/6B_1m.csv"], ["6A", "data/intraday/6A_1m.csv"], ["6C", "data/intraday/6C_1m.csv"],
    ["ZC", "data/intraday/ZC_1m.csv"], ["ZS", "data/intraday/ZS_1m.csv"], ["ZW", "data/intraday/ZW_1m.csv"],
  ];
  const res1: any[] = [];
  for (const [lab, p] of oneYr) { const r = evalInstrument(lab, p, true); if (r) res1.push(r); }

  // ── Gold deep tune+validate (3yr, the rigorous deliverable) ──
  console.log(`\n── GOLD TUNE + VALIDATE (3yr): pick best config on 2023-25, confirm ONCE on 2026 ──`);
  const gm1 = loadCsv("data/GC_1m.csv");
  const g5 = build5m(gm1);
  let gBest: { cfg: Cfg; is: ReturnType<typeof pf>; all: Trade[] } | null = null;
  for (const cfg of GRID) {
    const all = backtest(g5, gm1, cfg);
    const is = pf(all.filter((t) => t.t < SPLIT), COST);
    if (is.n >= 40 && (!gBest || is.pf > gBest.is.pf)) gBest = { cfg, is, all };
  }
  if (gBest) {
    const c = gBest.cfg;
    console.log(`  Best in-sample config: RSI ${c.lo}/${c.hi}, target ${c.targetMult}×ATR, stop ${c.stopMult}×ATR`);
    for (const cost of [0, 0.05, 0.10]) {
      const oos = pf(gBest.all.filter((t) => t.t >= SPLIT), cost);
      const is = pf(gBest.all.filter((t) => t.t < SPLIT), cost);
      console.log(`    cost ${(cost * 100).toString().padStart(2)}%:  IS ${fmt(is)}   OOS ${fmt(oos)}`);
    }
    console.log(`  By year (cost 5%):`);
    for (const y of [2023, 2024, 2025, 2026]) {
      const s = pf(gBest.all.filter((t) => new Date(t.t).getUTCFullYear() === y), 0.05);
      if (s.n > 0) console.log(`    ${y}: ${fmt(s)} win ${(s.wr * 100).toFixed(0)}%`);
    }
  }

  // ── Honest multiple-testing accounting ──
  const totalConfigs = (threeYr.length + oneYr.length) * GRID.length;
  const cands = [...res3, ...res1].filter((r) => r.candidate);
  console.log(`\n── HONESTY CHECK ──`);
  console.log(`  Configs tested: ${totalConfigs}. At 5% false-positive rate, expect ~${(totalConfigs * 0.05).toFixed(0)} to look good OOS by chance.`);
  console.log(`  Candidates flagged: ${cands.length} (${cands.map((c) => c.label).join(", ") || "none"})`);
  console.log(`  → Treat candidates as LEADS for $-accurate, multi-year, real-fill validation — NOT green lights.\n`);
}

main();
