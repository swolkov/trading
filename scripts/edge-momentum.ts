/**
 * EDGE HUNT — momentum/breakout family (the OTHER major family besides mean-reversion).
 * Donchian breakout WITH 15m-trend confirmation. Same honest discipline: enter at 5m close,
 * resolve exits only after entry (no look-ahead), block overlaps, R-multiples, IS/OOS split,
 * multiple-testing reported. Completes the "keep hunting" path.
 *
 * Run: node_modules/.bin/tsx scripts/edge-momentum.ts
 */
import fs from "node:fs";
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
const ATR_P = 14, MAX_HOLD = 48, SPLIT = Date.UTC(2026, 0, 1), COST = 0.05;

function loadCsv(p: string): Bar[] { const rows = fs.readFileSync(p, "utf8").trim().split("\n").slice(1); const o: Bar[] = []; for (const r of rows) { const c = r.split(","); const b = { t: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] }; if (isFinite(b.c) && b.c > 0 && isFinite(b.t)) o.push(b); } o.sort((a, z) => a.t - z.t); return o; }
function build(m1: Bar[], step: number): Bar[] { const m = new Map<number, Bar>(); for (const b of m1) { const k = Math.floor(b.t / step) * step; const e = m.get(k); if (!e) m.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); else { e.h = Math.max(e.h, b.h); e.l = Math.min(e.l, b.l); e.c = b.c; e.v += b.v; } } return [...m.values()].sort((a, z) => a.t - z.t); }
function atrAt(b: Bar[], i: number, p = ATR_P): number { if (i < p) return 0; let s = 0; for (let k = i - p + 1; k <= i; k++) s += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c)); return s / p; }
function ema(v: number[], p: number): number[] { const k = 2 / (p + 1); const o = [v[0]]; for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k)); return o; }
function lb(m: Bar[], t: number): number { let lo = 0, hi = m.length; while (lo < hi) { const x = (lo + hi) >> 1; if (m[x].t < t) lo = x + 1; else hi = x; } return lo; }
function resolveExit(m1: Bar[], s: number, dir: "long" | "short", stop: number, target: number, maxT: number) { let last: Bar | null = null; for (let j = s; j < m1.length; j++) { const b = m1[j]; if (b.t > maxT) break; last = b; const hs = dir === "long" ? b.l <= stop : b.h >= stop; const ht = dir === "long" ? b.h >= target : b.l <= target; if (hs) return { px: stop, t: b.t }; if (ht) return { px: target, t: b.t }; } return last ? { px: last.c, t: last.t } : null; }
function trendMap(m15: Bar[]) { const cl = m15.map((b) => b.c); const e9 = ema(cl, 9), e21 = ema(cl, 21); return m15.map((b, i) => ({ t: b.t, up: i >= 21 && e9[i] > e21[i], dn: i >= 21 && e9[i] < e21[i] })); }
function trendAt(tm: { t: number; up: boolean; dn: boolean }[], t: number) { let lo = 0, hi = tm.length - 1, a = { up: false, dn: false }; while (lo <= hi) { const m = (lo + hi) >> 1; if (tm[m].t <= t) { a = tm[m]; lo = m + 1; } else hi = m - 1; } return a; }

interface Trade { grossR: number; t: number; }
function backtest(m1: Bar[], b5: Bar[], m15: Bar[], lookback: number, targetMult: number): Trade[] {
  const tm = trendMap(m15); const trades: Trade[] = []; let blocked = 0;
  for (let i = lookback + 1; i < b5.length; i++) {
    const bar = b5[i]; if (bar.t < blocked) continue;
    const a = atrAt(b5, i); if (a <= 0) continue;
    const win = b5.slice(i - lookback, i);
    const hh = Math.max(...win.map((x) => x.h)), ll = Math.min(...win.map((x) => x.l));
    const tr = trendAt(tm, bar.t);
    let dir: "long" | "short" | null = null;
    if (bar.c > hh && tr.up) dir = "long"; else if (bar.c < ll && tr.dn) dir = "short"; else continue;
    const entry = bar.c, stopDist = 1.5 * a;
    const stop = dir === "long" ? entry - stopDist : entry + stopDist;
    const target = dir === "long" ? entry + targetMult * a : entry - targetMult * a;
    const ex = resolveExit(m1, lb(m1, bar.t + 300000), dir, stop, target, bar.t + 300000 + MAX_HOLD * 300000);
    if (!ex) continue;
    trades.push({ grossR: (dir === "long" ? ex.px - entry : entry - ex.px) / stopDist, t: bar.t });
    blocked = ex.t;
  }
  return trades;
}
function pf(ts: Trade[]) { let gw = 0, gl = 0, n = 0, sum = 0; for (const t of ts) { const r = t.grossR - COST; sum += r; n++; if (r > 0) gw += r; else gl += -r; } return { n, pf: gl > 0 ? gw / gl : gw > 0 ? 99 : 0, expR: n ? sum / n : 0 }; }
const f = (s: ReturnType<typeof pf>) => `PF ${(s.pf === 99 ? "INF" : s.pf.toFixed(2)).padStart(5)} n${String(s.n).padStart(4)} ${(s.expR >= 0 ? "+" : "")}${s.expR.toFixed(3)}R`;

function main() {
  console.log(`\n══ EDGE HUNT — momentum/breakout (Donchian + 15m trend) ══`);
  console.log(`  Grid: lookback{12,24} × target{2,3}×ATR | cost ${COST * 100}% | OOS 2026+ | R-multiples\n`);
  const universe = [["GC", "data/GC_1m.csv", false], ["ES", "data/ES_1m.csv", false], ["NQ", "data/NQ_1m.csv", false], ["CL", "data/intraday/CL_1m.csv", true], ["6E", "data/intraday/6E_1m.csv", true], ["HG", "data/intraday/HG_1m.csv", true], ["RB", "data/intraday/RB_1m.csv", true]] as [string, string, boolean][];
  let candidates = 0, total = 0;
  for (const [lab, path, expl] of universe) {
    if (!fs.existsSync(path)) { console.log(`  ${lab} — no data`); continue; }
    const m1 = loadCsv(path), b5 = build(m1, 300000), m15 = build(m1, 900000);
    let best: { lk: number; tm: number; is: any; oos: any } | null = null;
    for (const lk of [12, 24]) for (const tmu of [2, 3]) { total++; const all = backtest(m1, b5, m15, lk, tmu); const is = pf(all.filter((t) => t.t < SPLIT)), oos = pf(all.filter((t) => t.t >= SPLIT)); if (is.n >= 40 && (!best || is.pf > best.is.pf)) best = { lk, tm: tmu, is, oos }; }
    if (!best) { console.log(`  ${lab.padEnd(4)} — too few trades`); continue; }
    const cand = best.is.pf > 1.0 && best.oos.pf >= 1.2 && best.oos.n >= (expl ? 40 : 80); if (cand) candidates++;
    console.log(`  ${lab.padEnd(4)}${expl ? "*" : " "} Donchian${best.lk} t${best.tm}  IS ${f(best.is)}  |  OOS ${f(best.oos)}  ${cand ? "◀ CANDIDATE" : ""}`);
  }
  console.log(`\n  (* = 1yr exploratory data)`);
  console.log(`  Configs tested: ${total}. Candidates: ${candidates}.`);
  console.log(`  ${candidates === 0 ? "→ Momentum/breakout family: NO edge found (consistent with mean-reversion screen)." : "→ Investigate candidates with $-accurate validation."}\n`);
}
main();
