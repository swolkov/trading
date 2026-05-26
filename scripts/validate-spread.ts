/**
 * INSTITUTIONAL VALIDATION of the spread edge — falsification, not optimization.
 *   A. Parameter-stability surface  (robust = smooth plateau; overfit = lone spike)
 *   B. Rolling walk-forward          (consistent across windows = real)
 *   C. Deflated Sharpe               (does it survive multiple-testing of ~N trials?)
 *   npx tsx scripts/validate-spread.ts
 */
import fs from "node:fs";
const dir = new URL("../data/daily/", import.meta.url);
function load(sym: string): Map<string, number> { const m = new Map<string, number>(); try { for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch { } return m; }

// the economically-grounded book (crack, grain-complex, FX, metals)
const PAIRS: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["6E", "6B"], ["6A", "6C"], ["GC", "HG"]];
const cache = new Map<string, Map<string, number>>();
const L = (s: string) => cache.get(s) ?? cache.set(s, load(s)).get(s)!;

interface Tr { R: number; ym: string; year: number; }
function trades(entryZ: number, lookback: number, stopZ = 3.5, maxHold = 40): Tr[] {
  const out: Tr[] = [];
  for (const [a, b] of PAIRS) {
    const A = L(a), B = L(b); const dates = [...A.keys()].filter(d => B.has(d)).sort();
    if (dates.length < lookback + 50) continue;
    const ratio = dates.map(d => A.get(d)! / B.get(d)!);
    let pos: { dir: number; entry: number; fs: number; i: number } | null = null;
    for (let i = lookback; i < ratio.length; i++) {
      const w = ratio.slice(i - lookback, i), m = w.reduce((s, v) => s + v, 0) / lookback, sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / lookback) || 1e-9, z = (ratio[i] - m) / sd;
      if (pos && ((pos.dir === -1 ? z <= 0 : z >= 0) || Math.abs(z) >= stopZ || i - pos.i >= maxHold)) { out.push({ R: (pos.dir * (ratio[i] - pos.entry) / pos.entry) / (1.5 * pos.fs), ym: dates[i].slice(0, 7), year: +dates[i].slice(0, 4) }); pos = null; }
      if (!pos) { if (z > entryZ) pos = { dir: -1, entry: ratio[i], fs: sd / m, i }; else if (z < -entryZ) pos = { dir: 1, entry: ratio[i], fs: sd / m, i }; }
    }
  }
  return out;
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const pf = (t: Tr[]) => { const gw = t.filter(x => x.R > 0).reduce((s, x) => s + x.R, 0), gl = Math.abs(t.filter(x => x.R < 0).reduce((s, x) => s + x.R, 0)); return gl ? gw / gl : Infinity; };

// monthly return series (1% risk), zero-filled across the full range
function monthly(t: Tr[]): number[] {
  const m = new Map<string, number>(); for (const x of t) m.set(x.ym, (m.get(x.ym) ?? 0) + x.R * 0.01);
  const yms = [...m.keys()].sort(); if (!yms.length) return [];
  const out: number[] = []; let [y, mo] = yms[0].split("-").map(Number); const [ey, em] = yms[yms.length - 1].split("-").map(Number);
  while (y < ey || (y === ey && mo <= em)) { out.push(m.get(`${y}-${String(mo).padStart(2, "0")}`) ?? 0); mo++; if (mo > 12) { mo = 1; y++; } }
  return out;
}
// stats helpers + normal CDF/inverse for deflated Sharpe
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
function PhiInv(p: number) { const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924], b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857], c = [-7.78489400243029e-3, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878], d = [7.78469570904146e-3, 0.32246712907004, 2.445134137143, 3.75440866190742]; const pl = 0.02425; let q, r; if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); } if (p <= 1 - pl) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); } q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }

function main() {
  console.log("\n" + "═".repeat(80));
  console.log("  SPREAD EDGE — INSTITUTIONAL VALIDATION (falsification, not optimization)");
  console.log("═".repeat(80));

  // ── A. Parameter-stability surface ──
  console.log("\n  A. PARAMETER-STABILITY SURFACE  (avg R per trade; robust = plateau, overfit = lone spike)");
  console.log("       lookback:   40      60      80     100");
  let allPos = true, cells = 0, posCells = 0;
  for (const ez of [1.5, 2.0, 2.5, 3.0]) {
    const row = [40, 60, 80, 100].map(lb => { const t = trades(ez, lb); cells++; if (mean(t.map(x => x.R)) > 0) posCells++; else allPos = false; return mean(t.map(x => x.R)); });
    console.log(`  entryZ ${ez.toFixed(1)}:  ${row.map(v => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`.padStart(7)).join(" ")}`);
  }
  console.log(`  → ${posCells}/${cells} parameter combos positive  ${posCells === cells ? "✅ PLATEAU (robust, not param-fit)" : posCells >= cells * 0.8 ? "🟡 mostly robust" : "❌ FRAGILE (overfit risk)"}`);

  // ── B. Rolling walk-forward (3yr windows, base params) ──
  console.log("\n  B. ROLLING WALK-FORWARD (base z=2/lb=60; avg R by 3-yr window — consistency = real)");
  const t = trades(2.0, 60);
  const years = [...new Set(t.map(x => x.year))].sort();
  let posW = 0, totW = 0;
  for (let s = 0; s + 2 < years.length; s += 1) {
    const win = years.slice(s, s + 3), wt = t.filter(x => win.includes(x.year));
    const a = mean(wt.map(x => x.R)); totW++; if (a > 0) posW++;
    console.log(`     ${win[0]}–${win[2]}: ${a >= 0 ? "+" : ""}${a.toFixed(2)}R  (n=${wt.length})`);
  }
  console.log(`  → positive in ${posW}/${totW} rolling 3-yr windows  ${posW >= totW * 0.8 ? "✅ consistent" : posW >= totW * 0.6 ? "🟡 mostly" : "❌ regime-dependent"}`);

  // ── C. Deflated Sharpe (multiple-testing correction) ──
  const mr = monthly(t), n = mr.length, mu = mean(mr), sd = Math.sqrt(mr.reduce((s, v) => s + (v - mu) ** 2, 0) / n) || 1e-9;
  const srM = mu / sd, srA = srM * Math.sqrt(12);
  const sk = mr.reduce((s, v) => s + ((v - mu) / sd) ** 3, 0) / n, ku = mr.reduce((s, v) => s + ((v - mu) / sd) ** 4, 0) / n;
  const N = 40, g = 0.5772156649;                          // ~trials run this session
  const zN = (1 - g) * PhiInv(1 - 1 / N) + g * PhiInv(1 - 1 / (N * Math.E));
  const dsr = Phi((srM * Math.sqrt(n - 1) - zN) / Math.sqrt(1 - sk * srM + (ku - 1) / 4 * srM ** 2));
  console.log("\n  C. DEFLATED SHARPE (corrects for ~" + N + " trials of multiple-testing)");
  console.log(`     monthly returns n=${n}, annualized Sharpe ${srA.toFixed(2)}, skew ${sk.toFixed(2)}, kurt ${ku.toFixed(2)}`);
  console.log(`     expected max Sharpe under null (${N} trials): ~${(zN / Math.sqrt(n - 1) * Math.sqrt(12)).toFixed(2)} annualized`);
  console.log(`     → DEFLATED SHARPE PROBABILITY = ${(dsr * 100).toFixed(1)}%  ${dsr > 0.95 ? "✅ survives multiple-testing (>95%)" : dsr > 0.90 ? "🟡 borderline" : "❌ likely multiple-testing artifact"}`);
  console.log("\n" + "═".repeat(80) + "\n");
}
main();
