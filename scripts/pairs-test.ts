/**
 * RELATIVE-VALUE / PAIRS test — a different edge class entirely (dollar-neutral, direction-agnostic).
 * Trades the RATIO of two related futures back to its mean (z-score reversion). 15yr daily.
 * Classic stat-arb: gold/silver, ES/NQ, bonds, energy crack.   npx tsx scripts/pairs-test.ts
 */
import fs from "node:fs";

function load(sym: string): Map<string, number> {
  const rows = fs.readFileSync(new URL(`../data/daily/${sym}_1d.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
  const m = new Map<string, number>();
  for (const r of rows) { const c = r.split(","); const px = +c[7]; if (isFinite(px) && px > 0) m.set(c[0].slice(0, 10), px); }
  return m;
}

interface T { year: number; ret: number; }
// z-score mean-reversion on the A/B ratio. Enter |z|>2, exit at z=0, stop |z|>3.5.
function pair(a: string, b: string, look = 60): T[] | null {
  let A: Map<string, number>, B: Map<string, number>;
  try { A = load(a); B = load(b); } catch { return null; }
  const dates = [...A.keys()].filter(d => B.has(d)).sort();
  if (dates.length < look + 50) return null;
  const ratio = dates.map(d => A.get(d)! / B.get(d)!);
  const trades: T[] = [];
  let pos: { dir: number; entry: number; year: number } | null = null; // dir -1 = short ratio (z high), +1 = long ratio
  for (let i = look; i < ratio.length; i++) {
    const win = ratio.slice(i - look, i);
    const mean = win.reduce((s, v) => s + v, 0) / look;
    const sd = Math.sqrt(win.reduce((s, v) => s + (v - mean) ** 2, 0) / look) || 1e-9;
    const z = (ratio[i] - mean) / sd;
    if (pos) {
      const crossed = pos.dir === -1 ? z <= 0 : z >= 0;
      const stopped = Math.abs(z) > 3.5 && Math.sign(z) === -pos.dir * -1; // moved further against
      if (crossed || stopped) { trades.push({ year: pos.year, ret: pos.dir * (ratio[i] - pos.entry) / pos.entry }); pos = null; }
    }
    if (!pos) {
      if (z > 2) pos = { dir: -1, entry: ratio[i], year: +dates[i].slice(0, 4) };
      else if (z < -2) pos = { dir: 1, entry: ratio[i], year: +dates[i].slice(0, 4) };
    }
  }
  return trades;
}

function report(label: string, t: T[] | null) {
  if (!t || !t.length) { console.log(`  ${label.padEnd(14)} no data / no trades`); return; }
  const n = t.length, wins = t.filter(x => x.ret > 0).length;
  const sum = t.reduce((s, x) => s + x.ret, 0);
  const gw = t.filter(x => x.ret > 0).reduce((s, x) => s + x.ret, 0);
  const gl = Math.abs(t.filter(x => x.ret < 0).reduce((s, x) => s + x.ret, 0));
  const years = [...new Set(t.map(x => x.year))].sort();
  const posY = years.filter(y => t.filter(x => x.year === y).reduce((s, x) => s + x.ret, 0) > 0).length;
  console.log(`  ${label.padEnd(14)} n=${String(n).padStart(3)}  win ${((wins / n) * 100).toFixed(0)}%  PF ${gl ? (gw / gl).toFixed(2) : "INF"}  sumRet ${(sum * 100).toFixed(0)}%  +in ${posY}/${years.length} yrs`);
}

function main() {
  console.log("\n" + "═".repeat(74));
  console.log("  RELATIVE-VALUE / PAIRS (z-score ratio reversion, 15yr daily) — dollar-neutral");
  console.log("═".repeat(74) + "\n");
  const pairs: [string, string][] = [["GC", "SI"], ["ES", "NQ"], ["ZB", "ZN"], ["CL", "HO"], ["CL", "RB"], ["ZC", "ZS"], ["6E", "6B"], ["GC", "PL"], ["ES", "YM"], ["NQ", "RTY"]];
  for (const [a, b] of pairs) report(`${a}/${b}`, pair(a, b));
  console.log("\n  (sumRet = cumulative % move captured on the ratio; a real relative-value edge = PF>1 + positive most years)");
  console.log("═".repeat(74) + "\n");
}
main();
