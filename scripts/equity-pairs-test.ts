/**
 * EQUITY PAIRS / STAT-ARB TEST — relative value (the edge that WORKS) on STOCKS instead of futures.
 * The point: stocks have no contract-size wall, so a $1K account can size them (fractional shares,
 * dollar-neutral). If the z-score reversion edge survives realistic equity costs here, it's the ONE
 * strategy a tiny account could actually trade. Same params as the validated futures spread book.
 *   npx tsx scripts/equity-pairs-test.ts
 */
import fs from "node:fs";

const PAIRS: [string, string][] = [
  ["KO", "PEP"], ["XOM", "CVX"], ["V", "MA"], ["HD", "LOW"], ["JPM", "BAC"],
  ["GS", "MS"], ["UPS", "FDX"], ["WMT", "TGT"], ["DUK", "SO"], ["GOOGL", "GOOG"],
];
const P = { lookback: 60, entryZ: 2, exitZ: 0, stopZ: 3.5, maxHold: 40 };
const COST = 0.0012;   // 0.12% round trip: 2 legs × (tight large-cap spread+slippage) + short borrow. Commission $0 (Alpaca).

const dir = new URL("../data/equities/", import.meta.url);
function load(t: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(`${t}.csv`, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[1]; if (isFinite(p) && p > 0) m.set(c[0], p); } } catch { }
  return m;
}

interface Tr { pair: string; ret: number; reason: "revert" | "stop" | "timeout"; }
function runPair(a: string, b: string): Tr[] {
  const A = load(a), B = load(b); const ds = [...A.keys()].filter(d => B.has(d)).sort();
  if (ds.length < P.lookback + 40) return [];
  const ratio = ds.map(d => A.get(d)! / B.get(d)!);
  const out: Tr[] = []; let pos: { dir: number; i: number } | null = null;
  for (let i = P.lookback; i < ratio.length; i++) {
    const w = ratio.slice(i - P.lookback, i); const m = w.reduce((s, v) => s + v, 0) / P.lookback;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / P.lookback) || 1e-9; const z = (ratio[i] - m) / sd;
    if (pos) {
      const revert = pos.dir === -1 ? z <= P.exitZ : z >= P.exitZ, stopped = Math.abs(z) >= P.stopZ, timeout = i - pos.i >= P.maxHold;
      if (revert || stopped || timeout) {
        const retA = A.get(ds[i])! / A.get(ds[pos.i])! - 1, retB = B.get(ds[i])! / B.get(ds[pos.i])! - 1;
        out.push({ pair: `${a}/${b}`, ret: pos.dir * (retA - retB) - COST, reason: stopped ? "stop" : timeout ? "timeout" : "revert" });
        pos = null;
      }
    }
    if (!pos) { if (z > P.entryZ) pos = { dir: -1, i }; else if (z < -P.entryZ) pos = { dir: 1, i }; }
  }
  return out;
}

const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const all: Tr[] = [];
console.log("\n" + "═".repeat(80));
console.log("  EQUITY PAIRS / STAT-ARB — z-score reversion, net of 0.12% cost (5yr, sector peers)");
console.log("═".repeat(80));
console.log(`  ${"pair".padEnd(12)} ${"n".padStart(4)} ${"avg net %".padStart(10)} ${"win%".padStart(6)} ${"total %".padStart(9)} ${"worst %".padStart(9)}`);
for (const [a, b] of PAIRS) {
  const t = runPair(a, b); all.push(...t);
  if (!t.length) { console.log(`  ${`${a}/${b}`.padEnd(12)} — no trades`); continue; }
  const rets = t.map(x => x.ret * 100); const wins = rets.filter(x => x > 0).length;
  console.log(`  ${`${a}/${b}`.padEnd(12)} ${String(t.length).padStart(4)} ${(mean(rets) >= 0 ? "+" : "") + mean(rets).toFixed(3)}%`.padEnd(0).padStart(0) + ` ${(wins / t.length * 100).toFixed(0)}%`.padStart(8) + ` ${(rets.reduce((s, v) => s + v, 0) >= 0 ? "+" : "") + rets.reduce((s, v) => s + v, 0).toFixed(1)}%`.padStart(11) + ` ${Math.min(...rets).toFixed(1)}%`.padStart(10));
}
console.log("─".repeat(80));
const rets = all.map(x => x.ret);
const avg = mean(rets), winRate = rets.filter(x => x > 0).length / rets.length;
const sd = Math.sqrt(mean(rets.map(x => (x - avg) ** 2))) || 1e-9;
const tradesPerYr = all.length / 5, annual = avg * tradesPerYr * 100;   // rough: avg per trade × trades/yr (one position)
console.log(`  POOLED (all ${all.length} trades): avg net ${(avg * 100).toFixed(3)}%/trade · win ${(winRate * 100).toFixed(0)}% · ~${tradesPerYr.toFixed(0)} trades/yr`);
console.log(`  per-trade Sharpe-ish: ${(avg / sd).toFixed(2)} · rough annual (1 position): ${annual >= 0 ? "+" : ""}${annual.toFixed(1)}%`);
console.log(`  COST STRESS (avg net %/trade): ` + [1, 2, 3].map(m => { const a2 = mean(all.map(x => x.ret + COST - m * COST)) * 100; return `${m}× ${a2 >= 0 ? "+" : ""}${a2.toFixed(3)}%`; }).join("  "));
const ok = avg > 0 && mean(all.map(x => x.ret + COST - 2 * COST)) > 0;
console.log("─".repeat(80));
console.log(`  VERDICT: ${ok ? "✅ positive edge net of cost (survives 2× cost)" : avg > 0 ? "🟡 marginal — positive at 1× but fails 2× cost stress" : "❌ no edge net of cost"}`);
console.log(`  $1K FIT: ✅ stocks have NO contract-size wall — a $1K account CAN size these (fractional, dollar-neutral).`);
console.log("═".repeat(80) + "\n");
