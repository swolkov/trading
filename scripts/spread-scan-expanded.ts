/**
 * EXPANDED SPREAD SCAN — hunt for MORE uncorrelated economic spreads to add to the book.
 * More good, uncorrelated edges = higher combined Sharpe = more deployable risk = more monthly profit.
 * Tests rates-curve, energy, grain-complex, FX-cross, metals, equity spreads (15yr daily, R-based + OOS).
 *   npx tsx scripts/spread-scan-expanded.ts
 */
import fs from "node:fs";
const dir = new URL("../data/daily/", import.meta.url);
function load(sym: string): Map<string, number> { const m = new Map<string, number>(); try { for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch { } return m; }

const SPLIT = 2020;
interface T { R: number; test: boolean; year: number; }
function pair(a: string, b: string): T[] | null {
  const A = load(a), B = load(b); const dates = [...A.keys()].filter(d => B.has(d)).sort();
  if (dates.length < 200) return null;
  const ratio = dates.map(d => A.get(d)! / B.get(d)!); const t: T[] = [];
  let pos: { dir: number; entry: number; fs: number; i: number } | null = null;
  for (let i = 60; i < ratio.length; i++) {
    const w = ratio.slice(i - 60, i), m = w.reduce((s, v) => s + v, 0) / 60, sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / 60) || 1e-9, z = (ratio[i] - m) / sd;
    if (pos && ((pos.dir === -1 ? z <= 0 : z >= 0) || Math.abs(z) >= 3.5 || i - pos.i >= 40)) { t.push({ R: (pos.dir * (ratio[i] - pos.entry) / pos.entry) / (1.5 * pos.fs), test: +dates[i].slice(0, 4) >= SPLIT, year: +dates[i].slice(0, 4) }); pos = null; }
    if (!pos) { if (z > 2) pos = { dir: -1, entry: ratio[i], fs: sd / m, i }; else if (z < -2) pos = { dir: 1, entry: ratio[i], fs: sd / m, i }; }
  }
  return t;
}

function main() {
  const groups: Record<string, [string, string][]> = {
    "rates curve": [["ZB", "ZN"], ["ZN", "ZF"], ["ZF", "ZT"], ["ZB", "ZF"]],
    "energy": [["CL", "RB"], ["CL", "HO"], ["RB", "HO"], ["NG", "CL"], ["HO", "NG"]],
    "grains": [["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["ZS", "ZL"], ["ZL", "ZM"]],
    "FX cross": [["6E", "6B"], ["6E", "6J"], ["6E", "6C"], ["6A", "6C"], ["6B", "6J"]],
    "metals": [["SI", "HG"], ["GC", "HG"], ["GC", "SI"], ["GC", "PL"]],
    "equity": [["ES", "YM"], ["NQ", "RTY"], ["ES", "NQ"]],
  };
  console.log("\n" + "═".repeat(80));
  console.log("  EXPANDED SPREAD SCAN — more uncorrelated edges = higher Sharpe = more monthly profit");
  console.log("  ✅ = robust: positive IN (PF>1.1) AND OUT (PF>1.2, +R), n>=80");
  console.log("═".repeat(80));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const winners: string[] = [];
  for (const [grp, pairs] of Object.entries(groups)) {
    console.log(`\n  ── ${grp} ──`);
    for (const [a, b] of pairs) {
      const t = pair(a, b); if (!t || t.length < 30) { console.log(`  ${`${a}/${b}`.padEnd(9)} (insufficient)`); continue; }
      const inR = t.filter(x => !x.test).map(x => x.R), outR = t.filter(x => x.test).map(x => x.R);
      const pf = (rs: number[]) => { const gw = rs.filter(r => r > 0).reduce((s, r) => s + r, 0), gl = Math.abs(rs.filter(r => r < 0).reduce((s, r) => s + r, 0)); return gl ? gw / gl : Infinity; };
      const robust = inR.length && outR.length && pf(inR) > 1.1 && pf(outR) > 1.2 && mean(outR) > 0 && t.length >= 80;
      if (robust) winners.push(`${a}/${b}`);
      console.log(`  ${robust ? "✅" : "  "} ${`${a}/${b}`.padEnd(9)} n=${String(t.length).padStart(3)}  avg ${mean(t.map(x => x.R)) >= 0 ? "+" : ""}${mean(t.map(x => x.R)).toFixed(2)}R  PF ${(pf(t.map(x => x.R)) === Infinity ? "INF" : pf(t.map(x => x.R)).toFixed(2))}  | IN ${inR.length ? mean(inR).toFixed(2) : "-"}R  OUT ${outR.length ? mean(outR).toFixed(2) : "-"}R`);
    }
  }
  console.log("\n" + "─".repeat(80));
  console.log(`  ROBUST EDGES TO ADD: ${winners.length ? winners.join(", ") : "(none beyond current)"}`);
  console.log("═".repeat(80) + "\n");
}
main();
