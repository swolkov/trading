/**
 * REAL-TIME TREND FILTER — can a trend signal KNOWN AT ENTRY recover the "trend-day" edge?
 *
 * probe-regime-gating found the setups make money on trend days (OOS +0.26R) — but that used the
 * FULL day's range (look-ahead). This tests trend metrics computable AT ENTRY from bars up to the
 * entry bar only: ADX (Wilder trend strength) and session-range-so-far / ATR (how far the day has
 * already expanded). Fixed a-priori thresholds (no optimization → no overfit). A gate is real only
 * if it's positive IN-sample AND out-of-sample with a real OOS sample, and beats the baseline.
 * If one holds, it's directly wireable into the engine (it computes ADX/ATR live already).
 *
 *   npx tsx scripts/probe-trend-filter.ts
 */
import { backtest, type Trade } from "./backtest";

const SPLIT = new Date("2026-01-01").getTime();
const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 1e-9; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) || 1e-9; };
function seg(trades: Trade[]) {
  const rs = trades.map(t => t.r); const wins = rs.filter(r => r > 0).length;
  return { n: trades.length, wr: trades.length ? wins / trades.length : 0, expR: mean(rs), t: rs.length < 5 ? 0 : mean(rs) / (std(rs) / Math.sqrt(rs.length)) };
}
const fmt = (s: ReturnType<typeof seg>) => `n=${String(s.n).padStart(4)} wr ${(s.wr * 100).toFixed(0).padStart(2)}% expR ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)} t=${s.t.toFixed(2)}`;

function main() {
  let all: Trade[] = [];
  for (const sym of ["ES", "NQ", "GC"]) { try { all.push(...backtest(sym)); } catch (e) { console.error(`${sym}: ${e instanceof Error ? e.message : e}`); } }
  if (!all.length) { console.error("No trades (missing data/<sym>_1m.csv?)"); process.exit(1); }

  const W = 100;
  console.log("\n" + "═".repeat(W));
  console.log("  REAL-TIME TREND FILTER — entry-known trend gates vs the look-ahead trend-day edge (IN 2025 / OOS 2026)");
  console.log("═".repeat(W));
  const base = seg(all), baseOOS = seg(all.filter(t => t.entryTime >= SPLIT));
  console.log(`  ${all.length} trades · BASELINE full ${fmt(base)} | OOS ${fmt(baseOOS)}`);
  console.log(`  (target to recover: trend-day OOS was ~+0.26R. These gates use ONLY data known at entry.)`);

  // Fixed, a-priori gates (no threshold optimization → no overfit)
  const gates: { label: string; fn: (t: Trade) => boolean }[] = [
    { label: "ADX > 20", fn: t => t.adx > 20 },
    { label: "ADX > 25", fn: t => t.adx > 25 },
    { label: "ADX > 30", fn: t => t.adx > 30 },
    { label: "ADX > 35", fn: t => t.adx > 35 },
    { label: "sessRange > 1.0×ATR", fn: t => t.sessRangeAtr > 1.0 },
    { label: "sessRange > 1.5×ATR", fn: t => t.sessRangeAtr > 1.5 },
    { label: "sessRange > 2.0×ATR", fn: t => t.sessRangeAtr > 2.0 },
    { label: "ADX>25 & range>1.5", fn: t => t.adx > 25 && t.sessRangeAtr > 1.5 },
    { label: "ADX>30 & range>1.5", fn: t => t.adx > 30 && t.sessRangeAtr > 1.5 },
  ];

  console.log("─".repeat(W));
  console.log(`  ${"gate (known at entry)".padEnd(24)} ${"kept%".padEnd(7)} IN ${"".padEnd(31)} | OUT`);
  const winners: string[] = [];
  for (const g of gates) {
    const sub = all.filter(g.fn);
    const si = seg(sub.filter(t => t.entryTime < SPLIT)), so = seg(sub.filter(t => t.entryTime >= SPLIT));
    const kept = (sub.length / all.length * 100).toFixed(0) + "%";
    const robust = si.expR > 0 && so.expR >= 0.10 && so.n >= 25 && so.expR > baseOOS.expR;
    console.log(`  ${g.label.padEnd(24)} ${kept.padEnd(7)} IN ${fmt(si).padEnd(34)} | OUT ${fmt(so)}  ${robust ? "✅ HOLDS" : ""}`);
    if (robust) winners.push(`${g.label} → OOS ${so.expR.toFixed(2)}R (n=${so.n}, keeps ${kept} of trades)`);
  }

  console.log("\n" + "─".repeat(W));
  if (winners.length) {
    console.log(`  ✅ ${winners.length} ENTRY-KNOWN trend gate(s) hold out-of-sample — directly wireable into the engine:`);
    for (const w of winners) console.log(`     • ${w}`);
    console.log(`  → Wire the best one as an engine entry gate (skip setups when the trend metric is below threshold), then forward-test.`);
  } else {
    console.log(`  ❌ No entry-known trend gate recovered the trend-day edge out-of-sample.`);
    console.log(`     Honest read: the trend-day edge needed FULL-day info; a real-time proxy doesn't capture it (yet).`);
    console.log(`     Next: test early-session directional drive (open→bar-N extension) or higher-timeframe alignment.`);
  }
  console.log("═".repeat(W) + "\n");
}
main();
