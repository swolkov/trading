/**
 * REGIME-GATING PROBE — do the engine's EXISTING setups have edge in SPECIFIC regimes,
 * even though they're break-even overall? If gap-fills only work in low-vol-risk-on conditions,
 * we gate the engine to trade ONLY then — turning a coin-flip into something selective.
 *
 * Method: reuse backtest()'s trade generation (ES/NQ/GC technical setups over Databento history),
 * tag each trade's entry date with the market-chronicle regime/vol/tone/day-type, segment, and
 * judge each segment IN-sample (2025) vs OUT-of-sample (2026). A gate is only real if the segment
 * is positive in BOTH periods with a real OOS sample — same discipline as backtest's edge scan.
 * Honest: if no regime beats the unconditioned baseline robustly, that's the answer.
 *
 *   npx tsx scripts/probe-regime-gating.ts
 */
import fs from "node:fs";
import { backtest, type Trade } from "./backtest";

const ROOT = new URL("..", import.meta.url);
const SPLIT = new Date("2026-01-01").getTime();

interface Regime { regime: string; vol: string; tone: string; dayType: string; }
function loadChronicle(): Map<string, Regime> {
  const m = new Map<string, Regime>();
  try {
    const txt = fs.readFileSync(new URL("data/market-chronicle.csv", ROOT), "utf8").trim().split("\n");
    const h = txt[0].split(","); const idx = (k: string) => h.indexOf(k);
    const di = idx("date"), ri = idx("regime"), vi = idx("volRegime"), ti = idx("riskTone"), dti = idx("dayType");
    for (const line of txt.slice(1)) { const c = line.split(","); m.set(c[di], { regime: c[ri], vol: c[vi], tone: c[ti], dayType: c[dti] }); }
  } catch {}
  return m;
}

const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 1e-9; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) || 1e-9; };
function seg(trades: Trade[]) {
  const rs = trades.map(t => t.r); const wins = rs.filter(r => r > 0).length;
  return { n: trades.length, wr: trades.length ? wins / trades.length : 0, expR: mean(rs), t: rs.length < 5 ? 0 : mean(rs) / (std(rs) / Math.sqrt(rs.length)) };
}
const fmt = (s: ReturnType<typeof seg>) => `n=${String(s.n).padStart(3)} wr ${(s.wr * 100).toFixed(0).padStart(2)}% expR ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)} t=${s.t.toFixed(2)}`;

function main() {
  const chron = loadChronicle();
  if (!chron.size) { console.error("No data/market-chronicle.csv — run scripts/market-chronicle.ts first"); process.exit(1); }

  let all: Trade[] = [];
  for (const sym of ["ES", "NQ", "GC"]) { try { all.push(...backtest(sym)); } catch (e) { console.error(`${sym}: ${e instanceof Error ? e.message : e}`); } }
  if (!all.length) { console.error("No trades generated (missing data/<sym>_1m.csv?)"); process.exit(1); }

  // tag each trade with the chronicle regime of its entry date
  const tagged = all.map(t => ({ t, r: chron.get(new Date(t.entryTime).toISOString().slice(0, 10)) })).filter(x => x.r) as { t: Trade; r: Regime }[];

  const W = 100;
  console.log("\n" + "═".repeat(W));
  console.log("  REGIME-GATING PROBE — do existing setups have edge in specific regimes? (IN 2025 / OOS 2026)");
  console.log("═".repeat(W));
  console.log(`  ${all.length} trades · ${tagged.length} matched to a chronicle regime`);
  const base = seg(all); const baseOOS = seg(all.filter(t => t.entryTime >= SPLIT));
  console.log(`  BASELINE (all, unconditioned):  full ${fmt(base)}   |   OOS ${fmt(baseOOS)}`);
  console.log("─".repeat(W));

  const dims: { name: string; key: keyof Regime }[] = [
    { name: "regime", key: "regime" }, { name: "vol", key: "vol" }, { name: "risk tone", key: "tone" }, { name: "day type", key: "dayType" },
  ];
  const candidates: string[] = [];
  for (const d of dims) {
    const vals = [...new Set(tagged.map(x => x.r[d.key]))].sort();
    console.log(`\n  ── by ${d.name} ──`);
    for (const v of vals) {
      const sub = tagged.filter(x => x.r[d.key] === v).map(x => x.t);
      const si = seg(sub.filter(t => t.entryTime < SPLIT)), so = seg(sub.filter(t => t.entryTime >= SPLIT));
      // robust gate: positive in BOTH periods, real OOS sample, beats baseline OOS
      const robust = si.expR > 0 && so.expR >= 0.10 && so.n >= 25 && so.expR > baseOOS.expR;
      console.log(`     ${(d.name + "=" + v).padEnd(22)} IN ${fmt(si).padEnd(34)} | OUT ${fmt(so)}  ${robust ? "✅ GATE CANDIDATE" : ""}`);
      if (robust) candidates.push(`${d.name}=${v} (OOS expR ${so.expR.toFixed(2)}, n=${so.n})`);
    }
  }

  console.log("\n" + "─".repeat(W));
  if (candidates.length) {
    console.log(`  ✅ ${candidates.length} regime gate(s) hold OOS — trade the existing setups ONLY in these conditions:`);
    for (const c of candidates) console.log(`     • ${c}`);
    console.log(`  → Next: wire as an entry gate in the engine (only trade when chronicle regime matches), then forward-test.`);
  } else {
    console.log(`  ❌ No regime gate beats the baseline out-of-sample. The setups don't have a hidden regime where they work.`);
    console.log(`     (Honest result — consistent with the overall break-even finding. Gating won't rescue a no-edge setup.)`);
  }
  console.log("═".repeat(W) + "\n");
}
main();
