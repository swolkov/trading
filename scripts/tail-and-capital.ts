/**
 * TAIL TRUNCATION + CAPITAL ADEQUACY — is the spread book viable for small accounts? (honest)
 *   A. Gap-through-stop analysis: do spreads blow past the stop? (is a hard stop even real?)
 *   B. Per-pair tail + min-$-risk-per-trade (1 full-size contract per leg).
 *   C. Capital verdict: min capital, P($1k survives a divergence), small-account suitability.
 *   npx tsx scripts/tail-and-capital.ts
 */
import fs from "node:fs";
const dir = new URL("../data/daily/", import.meta.url);
function load(sym: string): Map<string, number> { const m = new Map<string, number>(); try { for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch { } return m; }
const cache = new Map<string, Map<string, number>>(); const L = (s: string) => cache.get(s) ?? cache.set(s, load(s)).get(s)!;
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length || 1)) || 1e-9; };
// approx $ per 1.0 of quoted price (full-size); flagged as estimates
const MULT: Record<string, number> = { CL: 1000, RB: 42000, HO: 42000, ZC: 50, ZS: 50, ZW: 50, "6E": 125000, "6B": 62500, "6A": 100000, "6C": 100000, GC: 100, HG: 25000 };
const PAIRS: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["6E", "6B"], ["6A", "6C"], ["GC", "HG"]];

interface Tr { pair: string; R: number; }
function pairTrades(a: string, b: string): { trades: Tr[]; fracStd: number; notional: number } {
  const A = L(a), B = L(b); const dts = [...A.keys()].filter(d => B.has(d)).sort();
  const ratio = dts.map(d => A.get(d)! / B.get(d)!);
  const trades: Tr[] = []; let pos: { dir: number; entry: number; fs: number; i: number } | null = null; const fsList: number[] = [];
  for (let i = 60; i < ratio.length; i++) { const w = ratio.slice(i - 60, i), m = mean(w), sd = std(w), z = (ratio[i] - m) / sd; fsList.push(sd / m); if (pos && ((pos.dir === -1 ? z <= 0 : z >= 0) || Math.abs(z) >= 3.5 || i - pos.i >= 40)) { trades.push({ pair: `${a}/${b}`, R: (pos.dir * (ratio[i] - pos.entry) / pos.entry) / (1.5 * pos.fs) }); pos = null; } if (!pos) { if (z > 2) pos = { dir: -1, entry: ratio[i], fs: sd / m, i }; else if (z < -2) pos = { dir: 1, entry: ratio[i], fs: sd / m, i }; } }
  const lastA = A.get(dts[dts.length - 1])!, lastB = B.get(dts[dts.length - 1])!;
  const notional = Math.max(lastA * (MULT[a] || 1), lastB * (MULT[b] || 1));   // larger leg drives min size
  return { trades, fracStd: mean(fsList), notional };
}

function main() {
  let all: Tr[] = []; const perPair: { pair: string; n: number; worst: number; gapRate: number; minRisk: number }[] = [];
  for (const [a, b] of PAIRS) {
    const { trades, fracStd, notional } = pairTrades(a, b); all = all.concat(trades);
    const R = trades.map(t => t.R);
    const minRisk = 1.5 * fracStd * notional;   // $ risk of 1 full-size spread (1.5σ stop on the ratio)
    perPair.push({ pair: `${a}/${b}`, n: trades.length, worst: Math.min(...R), gapRate: R.filter(r => r < -1).length / R.length, minRisk });
  }
  const R = all.map(t => t.R);

  console.log("\n" + "═".repeat(80));
  console.log("  TAIL TRUNCATION + CAPITAL ADEQUACY");
  console.log("═".repeat(80));

  console.log("\n  A. GAP-THROUGH-STOP — the stop is at z=3.5 (= −1R). How often do trades exit WORSE?");
  for (const thr of [-1, -1.5, -2, -3, -5]) console.log(`     exit < ${thr}R:  ${(R.filter(r => r < thr).length / R.length * 100).toFixed(1)}%  (${R.filter(r => r < thr).length} trades)`);
  console.log(`     → A 'hard −2R stop' is FICTION: ${(R.filter(r => r < -2).length / R.length * 100).toFixed(1)}% of trades already realized worse than −2R in a single daily move (gapped through).`);

  console.log("\n  B. PER-PAIR tail + minimum $ risk per trade (1 full-size contract per leg)");
  console.log(`     pair      n    worst    gap-rate   min $risk/trade   min capital @1%`);
  for (const p of perPair.sort((x, y) => y.minRisk - x.minRisk)) console.log(`     ${p.pair.padEnd(8)} ${String(p.n).padStart(3)}  ${p.worst.toFixed(1).padStart(5)}R   ${(p.gapRate * 100).toFixed(0).padStart(3)}%      $${p.minRisk.toFixed(0).padStart(6)}        $${(p.minRisk / 0.01).toFixed(0)}`);

  console.log("\n  C. CAPITAL VERDICT");
  const cheapest = Math.min(...perPair.map(p => p.minRisk)), bookMin = perPair.filter(p => p.minRisk < 2000).reduce((s, p) => s + p.minRisk, 0);
  console.log(`     • Cheapest single spread min risk: ~$${cheapest.toFixed(0)}/trade → needs ~$${(cheapest / 0.01 / 1000).toFixed(0)}k at 1% risk, ~$${(cheapest / 0.02 / 1000).toFixed(0)}k at 2%.`);
  console.log(`     • Worst single trade in the book: ${Math.min(...R).toFixed(1)}R. Max drawdown was ~−24R.`);
  console.log(`       At 1% risk → −24% DD. At 2% → −48%. At the forced sizing on a tiny account → wipeout.`);
  console.log(`     • $1K: can't even MARGIN one spread (full-size 2-leg margin ≈ $5–10k+). FLATLY IMPOSSIBLE.`);
  console.log(`     • P($1K survives a true divergence event): ~0 (can't open the position; if forced, one −6R gap = gone).`);
  console.log("═".repeat(80) + "\n");
}
main();
