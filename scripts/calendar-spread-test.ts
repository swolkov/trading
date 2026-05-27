/**
 * CALENDAR SPREAD TEST — front-vs-deferred month of the SAME commodity (term-structure mean-reversion).
 * Calendar spreads margin ~90% cheaper than outrights (SPAN credit) → they fit a small account.
 * Same z-score reversion params as the validated futures spread book; ratio = front/deferred.
 * Question: does the term structure mean-revert profitably net of cost, at a size $1K can hold?
 *   npx tsx scripts/calendar-spread-test.ts
 */
import fs from "node:fs";

const dir = new URL("../data/daily/", import.meta.url);
const SYMS = ["CL", "NG", "RB", "HO", "ZC", "ZS", "ZW", "HG", "GC"];
const P = { lookback: 60, entryZ: 2, exitZ: 0, stopZ: 3.5, maxHold: 40 };
const COST = 0.0006;   // ~6bps round trip — calendar spreads are tight (1-tick) + commission small

function load(file: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(file, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch { }
  return m;
}

interface Tr { ret: number; }
function runCal(sym: string): { n: number; trades: Tr[] } | null {
  const F = load(`${sym}_1d.csv`), D = load(`${sym}_v1_1d.csv`);
  if (!F.size || !D.size) return null;
  const ds = [...F.keys()].filter(d => D.has(d)).sort();
  if (ds.length < P.lookback + 40) return null;
  const ratio = ds.map(d => F.get(d)! / D.get(d)!);
  const trades: Tr[] = []; let pos: { dir: number; i: number } | null = null;
  for (let i = P.lookback; i < ratio.length; i++) {
    const w = ratio.slice(i - P.lookback, i); const m = w.reduce((s, v) => s + v, 0) / P.lookback;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / P.lookback) || 1e-9; const z = (ratio[i] - m) / sd;
    if (pos) {
      const revert = pos.dir === -1 ? z <= P.exitZ : z >= P.exitZ, stopped = Math.abs(z) >= P.stopZ, timeout = i - pos.i >= P.maxHold;
      if (revert || stopped || timeout) {
        const fRet = F.get(ds[i])! / F.get(ds[pos.i])! - 1, dRet = D.get(ds[i])! / D.get(ds[pos.i])! - 1;
        trades.push({ ret: pos.dir * (fRet - dRet) - COST });    // long front / short deferred (dollar-neutral)
        pos = null;
      }
    }
    if (!pos) { if (z > P.entryZ) pos = { dir: -1, i }; else if (z < -P.entryZ) pos = { dir: 1, i }; }
  }
  return { n: trades.length, trades };
}

const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const all: number[] = [];
console.log("\n" + "═".repeat(74));
console.log("  CALENDAR SPREADS — front vs deferred, z-score reversion, net of cost (15yr)");
console.log("═".repeat(74));
console.log(`  ${"market".padEnd(8)} ${"n".padStart(4)} ${"avg net %".padStart(11)} ${"win%".padStart(6)} ${"total %".padStart(9)}`);
for (const s of SYMS) {
  const r = runCal(s); if (!r || !r.n) { console.log(`  ${s.padEnd(8)} — no data/trades`); continue; }
  const rets = r.trades.map(x => x.ret * 100); all.push(...r.trades.map(x => x.ret));
  console.log(`  ${s.padEnd(8)} ${String(r.n).padStart(4)} ${((mean(rets) >= 0 ? "+" : "") + mean(rets).toFixed(3) + "%").padStart(11)} ${(rets.filter(x => x > 0).length / r.n * 100).toFixed(0) + "%"}`.padEnd(0) + ` ${((rets.reduce((s, v) => s + v, 0) >= 0 ? "+" : "") + rets.reduce((s, v) => s + v, 0).toFixed(1) + "%").padStart(9)}`);
}
console.log("─".repeat(74));
const avg = mean(all);
console.log(`  POOLED (${all.length} trades): avg net ${(avg * 100).toFixed(3)}%/trade · win ${(all.filter(x => x > 0).length / all.length * 100).toFixed(0)}%`);
console.log(`  COST STRESS: ` + [1, 2, 3].map(mu => { const a = mean(all.map(x => x + COST - mu * COST)) * 100; return `${mu}× ${a >= 0 ? "+" : ""}${a.toFixed(3)}%`; }).join("  "));
const ok = avg > 0 && mean(all.map(x => x + COST - 2 * COST)) > 0;
console.log(`  VERDICT: ${ok ? "✅ positive net of cost (survives 2×)" : avg > 0 ? "🟡 marginal (positive 1×, fails 2×)" : "❌ no edge net of cost"}`);
console.log(`  NOTE: calendar P&L shown as % of underlying; the spread is leveraged vs its tiny margin, so % looks small.`);
console.log("═".repeat(74) + "\n");
