/**
 * RELATIVE-VALUE / PAIRS — risk-based returns + OUT-OF-SAMPLE split (15yr daily).
 * Dollar-neutral z-score reversion on economically-linked spreads. R-multiple sizing so the
 * return is comparable + honest: entry |z|=2, stop |z|=3.5 (=1.5σ risk), exit z=0 or 40-day timeout.
 * Annual return ≈ sumR/yr × risk%.   npx tsx scripts/pairs-test.ts
 */
import fs from "node:fs";

function load(sym: string): Map<string, number> {
  const rows = fs.readFileSync(new URL(`../data/daily/${sym}_1d.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
  const m = new Map<string, number>();
  for (const r of rows) { const c = r.split(","); const px = +c[7]; if (isFinite(px) && px > 0) m.set(c[0].slice(0, 10), px); }
  return m;
}

interface T { year: number; R: number; test: boolean; }
const SPLIT = 2020; // train <2020, test >=2020 (includes COVID, inflation, war — stress-tests the spreads)

function pair(a: string, b: string, look = 60): T[] | null {
  let A: Map<string, number>, B: Map<string, number>;
  try { A = load(a); B = load(b); } catch { return null; }
  const dates = [...A.keys()].filter(d => B.has(d)).sort();
  if (dates.length < look + 50) return null;
  const ratio = dates.map(d => A.get(d)! / B.get(d)!);
  const trades: T[] = [];
  let pos: { dir: number; entry: number; fracStd: number; year: number; i: number } | null = null;
  for (let i = look; i < ratio.length; i++) {
    const win = ratio.slice(i - look, i);
    const mean = win.reduce((s, v) => s + v, 0) / look;
    const sd = Math.sqrt(win.reduce((s, v) => s + (v - mean) ** 2, 0) / look) || 1e-9;
    const z = (ratio[i] - mean) / sd;
    if (pos) {
      const reverted = pos.dir === -1 ? z <= 0 : z >= 0;
      const stopped = Math.abs(z) >= 3.5;
      const timeout = i - pos.i >= 40;
      if (reverted || stopped || timeout) {
        const ret = pos.dir * (ratio[i] - pos.entry) / pos.entry;   // dollar-neutral spread return
        const R = ret / (1.5 * pos.fracStd);                        // risk = the 1.5σ stop distance
        trades.push({ year: pos.year, R, test: pos.year >= SPLIT });
        pos = null;
      }
    }
    if (!pos) {
      if (z > 2) pos = { dir: -1, entry: ratio[i], fracStd: sd / mean, year: +dates[i].slice(0, 4), i };
      else if (z < -2) pos = { dir: 1, entry: ratio[i], fracStd: sd / mean, year: +dates[i].slice(0, 4), i };
    }
  }
  return trades;
}

function stat(t: T[]) {
  if (!t.length) return null;
  const w = t.filter(x => x.R > 0).length, sumR = t.reduce((s, x) => s + x.R, 0);
  const gw = t.filter(x => x.R > 0).reduce((s, x) => s + x.R, 0), gl = Math.abs(t.filter(x => x.R < 0).reduce((s, x) => s + x.R, 0));
  return { n: t.length, wr: w / t.length, sumR, expR: sumR / t.length, pf: gl ? gw / gl : Infinity };
}

function main() {
  console.log("\n" + "═".repeat(82));
  console.log("  RELATIVE-VALUE / PAIRS — risk-based (R) + OUT-OF-SAMPLE (train <2020 / test 2020+)");
  console.log("═".repeat(82) + "\n");
  // a-priori economically-linked spreads (chosen by economics, not by what backtested well)
  const basket: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["6E", "6B"], ["GC", "PL"], ["GC", "SI"]];
  const all: T[] = [];
  console.log(`  ${"pair".padEnd(8)} ${"n".padStart(3)}  win   PF    IN-sumR   OUT-sumR   expR`);
  for (const [a, b] of basket) {
    const t = pair(a, b); if (!t) { console.log(`  ${a}/${b}: no data`); continue; }
    all.push(...t);
    const si = stat(t.filter(x => !x.test)), so = stat(t.filter(x => x.test)), s = stat(t)!;
    console.log(`  ${(a + "/" + b).padEnd(8)} ${String(s.n).padStart(3)}  ${(s.wr * 100).toFixed(0)}%  ${s.pf === Infinity ? "INF" : s.pf.toFixed(2)}   ${(si ? si.sumR.toFixed(1) : "-").padStart(7)}   ${(so ? so.sumR.toFixed(1) : "-").padStart(7)}   ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)}R`);
  }
  // portfolio
  const years = [...new Set(all.map(t => t.year))].sort();
  const inY = years.filter(y => y < SPLIT).length, outY = years.filter(y => y >= SPLIT).length;
  const inR = all.filter(t => !t.test).reduce((s, t) => s + t.R, 0), outR = all.filter(t => t.test).reduce((s, t) => s + t.R, 0);
  console.log("\n  ── PORTFOLIO (all 6 spreads, ~" + (all.length / years.length).toFixed(0) + " trades/yr) ──");
  console.log(`  IN-SAMPLE  (<2020): ${inR.toFixed(0)}R over ${inY}yr = ${(inR / inY).toFixed(1)}R/yr  → @1% risk ≈ ${(inR / inY * 1).toFixed(0)}%/yr`);
  console.log(`  OUT-SAMPLE (2020+): ${outR.toFixed(0)}R over ${outY}yr = ${(outR / outY).toFixed(1)}R/yr  → @1% risk ≈ ${(outR / outY * 1).toFixed(0)}%/yr  ← the real test`);
  console.log("\n  (R = profit ÷ the 1.5σ stop. @1% risk: a +Xr year ≈ +X% on the account, before 2-leg commissions.)");
  console.log("═".repeat(82) + "\n");
}
main();
