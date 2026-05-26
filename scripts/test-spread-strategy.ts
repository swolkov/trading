/**
 * PARITY TEST for the SpreadStrategy module — replays 15yr daily data bar-by-bar through the
 * SAME module that will run live, reconstructs trades, and verifies it reproduces the validated
 * edge (~+0.3R, positive on the economic pairs). If parity holds, the module is correct.
 *   npx tsx scripts/test-spread-strategy.ts
 */
import fs from "node:fs";
import { SpreadStrategy } from "../src/lib/strategies/spread-strategy";

const dir = new URL("../data/daily/", import.meta.url);
function loadClose(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) {
    const c = r.split(","); const px = +c[7]; if (isFinite(px) && px > 0) m.set(c[0].slice(0, 10), px);
  }
  return m;
}

function main() {
  const pairs: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["6E", "6B"], ["GC", "PL"], ["GC", "SI"]];
  const syms = [...new Set(pairs.flat())];
  const data: Record<string, Map<string, number>> = {};
  for (const s of syms) data[s] = loadClose(s);
  const dates = [...new Set(syms.flatMap(s => [...data[s].keys()]))].sort();

  const strat = new SpreadStrategy({ pairs });
  // reconstruct trades: on close, R = (favorable ratio move) / (1.5σ stop). Track open ratio per pair.
  const open = new Map<string, { dir: number; ratio: number; sigmaPct: number; year: number }>();
  const trades: { pair: string; R: number; year: number }[] = [];

  for (const d of dates) {
    const prices: Record<string, number> = {};
    for (const s of syms) { const p = data[s].get(d); if (p !== undefined) prices[s] = p; }
    for (const sig of strat.onBar(prices)) {
      if (sig.action === "open") open.set(sig.pair, { dir: sig.dir === "long" ? 1 : -1, ratio: sig.ratio, sigmaPct: sig.sigmaPct, year: +d.slice(0, 4) });
      else {
        const o = open.get(sig.pair); if (!o) continue;
        const R = (o.dir * (sig.ratio - o.ratio) / o.ratio) / (1.5 * o.sigmaPct);
        trades.push({ pair: sig.pair, R, year: o.year });
        open.delete(sig.pair);
      }
    }
  }

  console.log("\n" + "═".repeat(72));
  console.log("  PARITY TEST — SpreadStrategy module replayed over 15yr daily");
  console.log("═".repeat(72));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  for (const [a, b] of pairs) {
    const t = trades.filter(x => x.pair === `${a}/${b}`).map(x => x.R);
    const gw = t.filter(r => r > 0).reduce((s, r) => s + r, 0), gl = Math.abs(t.filter(r => r < 0).reduce((s, r) => s + r, 0));
    console.log(`  ${`${a}/${b}`.padEnd(8)} n=${String(t.length).padStart(3)}  avg ${mean(t) >= 0 ? "+" : ""}${mean(t).toFixed(2)}R  PF ${(gl ? gw / gl : Infinity).toFixed(2)}`);
  }
  const all = trades.map(t => t.R);
  const gw = all.filter(r => r > 0).reduce((s, r) => s + r, 0), gl = Math.abs(all.filter(r => r < 0).reduce((s, r) => s + r, 0));
  console.log(`\n  ★ POOLED: n=${all.length}  avg ${mean(all) >= 0 ? "+" : ""}${mean(all).toFixed(3)}R  PF ${(gw / gl).toFixed(2)}  win ${(all.filter(r => r > 0).length / all.length * 100).toFixed(0)}%`);
  const ok = mean(all) > 0.15 && gw / gl > 1.2;
  console.log(`  PARITY: ${ok ? "✅ module reproduces the validated edge — deployable core verified" : "⚠️ mismatch vs validation — debug before deploy"}`);
  console.log("═".repeat(72) + "\n");
}
main();
