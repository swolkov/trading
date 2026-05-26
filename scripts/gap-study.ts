/**
 * GAP / EVENT-DRIVEN BEHAVIOR — testable NOW with daily OHLC (no tick/L2 needed).
 * Does the overnight gap FADE (fill) or CONTINUE intraday? Conditioned on gap size + direction,
 * across 27 markets / 15yr, by year. A real microstructure-adjacent effect that candle-pattern
 * minute tests don't isolate.   npx tsx scripts/gap-study.ts
 * NOTE: this is the LIMIT of OHLCV. Order-flow (sweeps/absorption/footprint/DOM) needs tick+L2.
 */
import fs from "node:fs";
const dir = new URL("../data/daily/", import.meta.url);
interface Bar { d: string; o: number; h: number; l: number; c: number; }
function load(sym: string): Bar[] { try { return fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1).map(r => { const x = r.split(","); return { d: x[0].slice(0, 10), o: +x[4], h: +x[5], l: +x[6], c: +x[7] }; }).filter(b => isFinite(b.c) && b.c > 0).sort((a, b) => (a.d < b.d ? -1 : 1)); } catch { return []; } }
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
function atr(b: Bar[], i: number, n = 14) { if (i < n) return 0; let s = 0; for (let j = i - n + 1; j <= i; j++) s += Math.max(b[j].h - b[j].l, Math.abs(b[j].h - b[j - 1].c), Math.abs(b[j].l - b[j - 1].c)); return s / n; }

function main() {
  const files = fs.readdirSync(dir).filter(f => f.endsWith("_1d.csv")).map(f => f.replace("_1d.csv", ""));
  // conditional intraday continuation (dir×(close-open)/ATR) by gap bucket
  const buckets: Record<string, { cont: number[]; year: Map<number, number[]> }> = {
    "small gap (<0.5 ATR)": { cont: [], year: new Map() }, "medium (0.5-1 ATR)": { cont: [], year: new Map() }, "large gap (>1 ATR)": { cont: [], year: new Map() },
  };
  for (const sym of files) {
    const b = load(sym);
    for (let i = 15; i < b.length; i++) {
      const a = atr(b, i); if (a <= 0) continue;
      const gap = b[i].o - b[i - 1].c, gR = Math.abs(gap) / a; if (gR < 0.1) continue;
      const dir = Math.sign(gap), contR = dir * (b[i].c - b[i].o) / a;   // + = gap continued, − = gap faded/filled
      const key = gR < 0.5 ? "small gap (<0.5 ATR)" : gR < 1 ? "medium (0.5-1 ATR)" : "large gap (>1 ATR)";
      buckets[key].cont.push(contR); const y = +b[i].d.slice(0, 4); (buckets[key].year.get(y) ?? buckets[key].year.set(y, []).get(y)!).push(contR);
    }
  }
  console.log("\n" + "═".repeat(80));
  console.log("  GAP BEHAVIOR — does the overnight gap CONTINUE (+) or FADE/FILL (−) intraday? (27mkts/15yr)");
  console.log("═".repeat(80));
  for (const [name, d] of Object.entries(buckets)) {
    const years = [...d.year.keys()].sort(); const signYears = years.filter(y => Math.abs(mean(d.year.get(y)!)) > 0.02);
    const consistent = years.filter(y => Math.sign(mean(d.year.get(y)!)) === Math.sign(mean(d.cont))).length;
    console.log(`\n  ${name}: n=${d.cont.length}  mean intraday ${mean(d.cont) >= 0 ? "+" : ""}${mean(d.cont).toFixed(3)} ATR  (${mean(d.cont) > 0 ? "CONTINUES" : "FADES/FILLS"})`);
    console.log(`     consistent sign in ${consistent}/${years.length} years  → ${Math.abs(mean(d.cont)) > 0.03 && consistent >= years.length * 0.7 ? "🟡 directional tendency — worth a costed test" : "❌ weak/inconsistent — no clean edge"}`);
  }
  console.log("\n  ⚠️ DATA LIMIT: this is the ceiling of OHLCV. It says nothing about liquidity sweeps,");
  console.log("     absorption, footprint, or DOM imbalance — those require TICK + order-book data we have NOT pulled.");
  console.log("═".repeat(80) + "\n");
}
main();
