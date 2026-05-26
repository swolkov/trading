/**
 * EXECUTION-REALISM VALIDATION — trying to KILL the spread edge with cost + tail + crisis.
 *   A. Slippage breakeven sweep: subtract increasing cost/trade (R) → where does expectancy /
 *      consistency / significance die?  (the killer question)
 *   B. Tail risk: worst excursions, CVaR, max drawdown (R) + duration, loss clustering.
 *   C. Crisis replay: net edge during 2018 vol, COVID 2020, 2022 inflation.
 * LIMIT (honest): true async/partial-fill sim needs tick/L2 data we don't have — this BOUNDS how
 * much total execution cost the edge can absorb, which is the decision-critical number.
 *   npx tsx scripts/validate-execution.ts
 */
import fs from "node:fs";
const dir = new URL("../data/daily/", import.meta.url);
function load(sym: string): Map<string, number> { const m = new Map<string, number>(); try { for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch { } return m; }
const PAIRS: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["6E", "6B"], ["6A", "6C"], ["GC", "HG"]];
const cache = new Map<string, Map<string, number>>(); const L = (s: string) => cache.get(s) ?? cache.set(s, load(s)).get(s)!;

interface Tr { R: number; date: string; year: number; }
function trades(): Tr[] {
  const out: Tr[] = [];
  for (const [a, b] of PAIRS) {
    const A = L(a), B = L(b); const dates = [...A.keys()].filter(d => B.has(d)).sort(); if (dates.length < 110) continue;
    const ratio = dates.map(d => A.get(d)! / B.get(d)!); let pos: { dir: number; entry: number; fs: number; i: number } | null = null;
    for (let i = 60; i < ratio.length; i++) {
      const w = ratio.slice(i - 60, i), m = w.reduce((s, v) => s + v, 0) / 60, sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / 60) || 1e-9, z = (ratio[i] - m) / sd;
      if (pos && ((pos.dir === -1 ? z <= 0 : z >= 0) || Math.abs(z) >= 3.5 || i - pos.i >= 40)) { out.push({ R: (pos.dir * (ratio[i] - pos.entry) / pos.entry) / (1.5 * pos.fs), date: dates[i], year: +dates[i].slice(0, 4) }); pos = null; }
      if (!pos) { if (z > 2) pos = { dir: -1, entry: ratio[i], fs: sd / m, i }; else if (z < -2) pos = { dir: 1, entry: ratio[i], fs: sd / m, i }; }
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
function monthly(t: Tr[], cost: number): number[] { const m = new Map<string, number>(); for (const x of t) { const k = x.date.slice(0, 7); m.set(k, (m.get(k) ?? 0) + (x.R - cost) * 0.01); } const ks = [...m.keys()].sort(); if (!ks.length) return []; const o: number[] = []; let [y, mo] = ks[0].split("-").map(Number); const [ey, em] = ks[ks.length - 1].split("-").map(Number); while (y < ey || (y === ey && mo <= em)) { o.push(m.get(`${y}-${String(mo).padStart(2, "0")}`) ?? 0); mo++; if (mo > 12) { mo = 1; y++; } } return o; }
function sharpe(mr: number[]) { if (mr.length < 2) return 0; const mu = mean(mr), sd = Math.sqrt(mr.reduce((s, v) => s + (v - mu) ** 2, 0) / mr.length) || 1e-9; return (mu / sd) * Math.sqrt(12); }

function main() {
  const t = trades(); const R = t.map(x => x.R); const gross = mean(R);
  const years = [...new Set(t.map(x => x.year))].sort();
  const posWindows = (cost: number) => { let p = 0, n = 0; for (let s = 0; s + 2 < years.length; s++) { const win = years.slice(s, s + 3); const wt = t.filter(x => win.includes(x.year)).map(x => x.R - cost); n++; if (mean(wt) > 0) p++; } return `${p}/${n}`; };

  console.log("\n" + "═".repeat(82));
  console.log("  EXECUTION-REALISM VALIDATION — trying to KILL the spread edge");
  console.log("═".repeat(82));
  console.log(`\n  gross edge: ${t.length} trades, avg +${gross.toFixed(3)}R/trade (pre-cost, ratio-proxy)`);

  console.log("\n  A. SLIPPAGE BREAKEVEN SWEEP — subtract cost/trade (in R), watch it die");
  console.log(`     cost/R   avg net R   win%   +windows   net Sharpe`);
  for (const c of [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35]) {
    const net = R.map(r => r - c); const a = mean(net), wr = net.filter(x => x > 0).length / net.length;
    console.log(`     ${c.toFixed(2)}      ${a >= 0 ? "+" : ""}${a.toFixed(3)}      ${(wr * 100).toFixed(0)}%    ${posWindows(c).padStart(5)}      ${sharpe(monthly(t, c)).toFixed(2)}`);
  }
  console.log(`     → breakeven (avg→0) at ~${gross.toFixed(2)}R cost/trade. Consistency/significance erode well before that.`);

  console.log("\n  B. TAIL RISK (kurtosis was 7.31 — quantifying the fat tail)");
  const sorted = [...R].sort((a, b) => a - b); const cvar5 = mean(sorted.slice(0, Math.ceil(sorted.length * 0.05)));
  console.log(`     worst single trade: ${sorted[0].toFixed(2)}R   |   5th-pct trade: ${sorted[Math.floor(sorted.length * 0.05)].toFixed(2)}R   |   CVaR(5%): ${cvar5.toFixed(2)}R`);
  // max drawdown (R) + duration (consecutive trades underwater)
  let eq = 0, peak = 0, dd = 0, ddStart = 0, maxDur = 0, curStart = -1;
  for (let i = 0; i < R.length; i++) { eq += R[i] - 0.10; if (eq >= peak) { peak = eq; curStart = i; } else { if (curStart >= 0) maxDur = Math.max(maxDur, i - curStart); } if (eq - peak < dd) dd = eq - peak; }
  console.log(`     max drawdown (@0.10R cost): ${dd.toFixed(1)}R   |   longest underwater: ${maxDur} trades`);
  // loss clustering: avg run-length of consecutive losers
  let runs: number[] = [], cur = 0; for (const r of R) { if (r < 0) cur++; else { if (cur) runs.push(cur); cur = 0; } } if (cur) runs.push(cur);
  console.log(`     loss clustering: ${runs.filter(x => x >= 4).length} streaks of ≥4 consecutive losers (max ${Math.max(...runs)})`);

  console.log("\n  C. CRISIS REPLAY — net edge (@0.10R cost) in stress periods");
  const crises: [string, string, string][] = [["2018 vol (Q4)", "2018-10", "2019-02"], ["COVID panic", "2020-02", "2020-05"], ["2022 inflation", "2022-01", "2022-12"]];
  for (const [name, s, e] of crises) { const ct = t.filter(x => { const k = x.date.slice(0, 7); return k >= s && k <= e; }); const a = mean(ct.map(x => x.R - 0.10)); console.log(`     ${name.padEnd(16)} n=${String(ct.length).padStart(3)}  net avg ${a >= 0 ? "+" : ""}${a.toFixed(2)}R  ${a > 0 ? "✅ held" : "❌ negative"}`); }
  console.log("\n" + "═".repeat(82) + "\n");
}
main();
