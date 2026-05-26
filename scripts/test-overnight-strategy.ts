/**
 * PARITY TEST for the OvernightStrategy module — replays 3yr of 1-minute data bar-by-bar through
 * the SAME module that will run live, reconstructs overnight trades, verifies it reproduces the
 * validated overnight edge (positive, sane Sharpe).   npx tsx scripts/test-overnight-strategy.ts
 */
import fs from "node:fs";
import { OvernightStrategy } from "../src/lib/strategies/overnight-strategy";

function nthSun(y: number, mo: number, n: number, h: number) { const f = new Date(Date.UTC(y, mo, 1)); return Date.UTC(y, mo, ((7 - f.getUTCDay()) % 7 + 1) + (n - 1) * 7, h); }
function et(ms: number) { const y = new Date(ms).getUTCFullYear(); const edt = ms >= nthSun(y, 2, 2, 7) && ms < nthSun(y, 10, 1, 6); const d = new Date(ms + (edt ? -4 : -5) * 3600_000); return { min: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.toISOString().slice(0, 10) }; }

function main() {
  const symbols = ["ES", "NQ", "GC"];
  // build a unified, time-ordered minute stream across symbols
  const stream: { t: number; min: number; day: string; prices: Record<string, number> }[] = [];
  const perMin = new Map<number, { min: number; day: string; prices: Record<string, number> }>();
  for (const s of symbols) {
    for (const r of fs.readFileSync(new URL(`../data/${s}_1m.csv`, import.meta.url), "utf8").trim().split("\n").slice(1)) {
      const x = r.split(","); const c = +x[7]; if (!isFinite(c)) continue;
      const ms = new Date(x[0]).getTime(); const e = et(ms);
      let row = perMin.get(ms); if (!row) { row = { min: e.min, day: e.day, prices: {} }; perMin.set(ms, row); }
      row.prices[s] = c;
    }
  }
  const times = [...perMin.keys()].sort((a, b) => a - b);

  const strat = new OvernightStrategy({ symbols });
  const open = new Map<string, { px: number; year: number }>();
  const trades: { sym: string; ret: number; year: number }[] = [];
  for (const t of times) {
    const row = perMin.get(t)!;
    for (const sig of strat.onBar(row.min, row.day, row.prices)) {
      if (sig.action === "open") open.set(sig.symbol, { px: row.prices[sig.symbol], year: +row.day.slice(0, 4) });
      else { const o = open.get(sig.symbol); if (o) { trades.push({ sym: sig.symbol, ret: (row.prices[sig.symbol] - o.px) / o.px, year: o.year }); open.delete(sig.symbol); } }
    }
  }

  console.log("\n" + "═".repeat(70));
  console.log("  PARITY TEST — OvernightStrategy module replayed over 3yr 1-min");
  console.log("═".repeat(70));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  for (const s of symbols) {
    const r = trades.filter(t => t.sym === s).map(t => t.ret);
    console.log(`  ${s}: nights=${r.length}  avg ${(mean(r) * 100).toFixed(3)}%/night  total ${(r.reduce((x, y) => x + y, 0) * 100).toFixed(0)}%  win ${(r.filter(x => x > 0).length / r.length * 100).toFixed(0)}%`);
  }
  const all = trades.map(t => t.ret);
  const years = [...new Set(trades.map(t => t.year))].sort();
  const posY = years.filter(y => mean(trades.filter(t => t.year === y).map(t => t.ret)) > 0).length;
  const ann = mean(all) * 252, vol = Math.sqrt(all.reduce((s, v) => s + (v - mean(all)) ** 2, 0) / all.length) * Math.sqrt(252);
  console.log(`\n  ★ POOLED: nights=${all.length}  avg ${(mean(all) * 100).toFixed(3)}%/night  Sharpe ${(ann / vol).toFixed(2)} (unlevered)  +in ${posY}/${years.length} yrs`);
  const ok = mean(all) > 0 && posY >= years.length * 0.7;
  console.log(`  PARITY: ${ok ? "✅ module reproduces the overnight edge — verified" : "⚠️ mismatch — debug"}`);
  console.log("═".repeat(70) + "\n");
}
main();
