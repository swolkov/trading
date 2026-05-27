/**
 * SEASONAL TEST — do commodities have a consistent, tradable month-of-year edge? (15yr daily, continuous)
 * Seasonality is the most overfit idea in trading (12 months × many markets → some look seasonal by luck),
 * so the bar is CONSISTENCY: a real seasonal is positive in most years AND economically grounded (weather,
 * harvest, demand cycles). Reports the strongest seasonal month per commodity + its hit-rate across years.
 *   npx tsx scripts/seasonal-test.ts
 */
import fs from "node:fs";

const dir = new URL("../data/daily/", import.meta.url);
const COMMODITIES = ["CL", "NG", "RB", "HO", "GC", "SI", "HG", "ZC", "ZS", "ZW", "ZL", "ZM", "LE", "HE"];
const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthlyReturns(sym: string): { ym: string; mo: number; ret: number }[] {
  let rows: { d: string; p: number }[];
  try { rows = fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1).map(r => { const c = r.split(","); return { d: c[0].slice(0, 10), p: +c[7] }; }).filter(x => isFinite(x.p) && x.p > 0); }
  catch { return []; }
  const monthEnd = new Map<string, number>();   // last close of each YYYY-MM
  for (const x of rows) monthEnd.set(x.d.slice(0, 7), x.p);
  const keys = [...monthEnd.keys()].sort(); const out: { ym: string; mo: number; ret: number }[] = [];
  for (let i = 1; i < keys.length; i++) out.push({ ym: keys[i], mo: +keys[i].slice(5, 7), ret: monthEnd.get(keys[i])! / monthEnd.get(keys[i - 1])! - 1 });
  return out;
}

console.log("\n" + "═".repeat(80));
console.log("  COMMODITY SEASONALITY — strongest month-of-year per market (15yr); bar = CONSISTENCY");
console.log("═".repeat(80));
console.log(`  ${"market".padEnd(8)} ${"best month".padEnd(20)} ${"worst month".padEnd(20)} robust?`);
const robust: string[] = [];
for (const sym of COMMODITIES) {
  const mr = monthlyReturns(sym); if (mr.length < 60) { console.log(`  ${sym} — no data`); continue; }
  const byMo: Record<number, number[]> = {}; for (const x of mr) (byMo[x.mo] = byMo[x.mo] || []).push(x.ret);
  const stats = Object.entries(byMo).map(([mo, rs]) => { const avg = rs.reduce((s, v) => s + v, 0) / rs.length; const hit = rs.filter(v => v > 0).length / rs.length; return { mo: +mo, avg, hit, n: rs.length }; });
  const best = stats.reduce((a, b) => b.avg > a.avg ? b : a), worst = stats.reduce((a, b) => b.avg < a.avg ? b : a);
  // "robust" = strong avg AND consistent (hit-rate ≥70% for best, ≤30% for worst) — i.e., not driven by a couple years
  const bestRobust = best.hit >= 0.70 && best.avg > 0.02, worstRobust = worst.hit <= 0.30 && worst.avg < -0.02;
  if (bestRobust || worstRobust) robust.push(`${sym} ${MON[bestRobust ? best.mo : worst.mo]}`);
  const f = (s: typeof best) => `${MON[s.mo]} ${(s.avg * 100 >= 0 ? "+" : "") + (s.avg * 100).toFixed(1)}% (${(s.hit * 100).toFixed(0)}% yrs, n${s.n})`;
  console.log(`  ${sym.padEnd(8)} ${f(best).padEnd(20)} ${f(worst).padEnd(20)} ${bestRobust || worstRobust ? "🟡 maybe" : "❌"}`);
}
console.log("─".repeat(80));
console.log(`  Consistent seasonals (hit-rate ≥70% / ≤30%, avg >2%): ${robust.length ? robust.join(", ") : "NONE"}`);
console.log(`  NOTE: even "robust" here is ~15 samples per month — high overfitting risk. A real seasonal needs`);
console.log(`  out-of-sample confirmation + an economic story, and is a small, low-frequency (12 trades/yr) edge.`);
console.log("═".repeat(80) + "\n");
