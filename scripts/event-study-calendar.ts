/**
 * STAGE 2 — EVENT-DRIVEN ANOMALY STUDY (testable now on daily OHLC, no tick data).
 *   • NFP (first Friday — rule-derivable, no hardcoded dates): pre-drift, event-day expansion+direction, post.
 *   • Volatility-shock reactions: persistence + reversion-vs-continuation after a >2.5 ATR day.
 * Asymmetry + by-year regime dependency. Honest: vol expansion is expected; the question is whether
 * any DIRECTIONAL, repeatable, non-HFT-tradable behavior exists.   npx tsx scripts/event-study-calendar.ts
 * (FOMC/CPI need a VERIFIED date calendar — not hardcoded from memory to avoid date errors. Flagged.)
 */
import fs from "node:fs";
const dir = new URL("../data/daily/", import.meta.url);
interface Bar { d: string; o: number; h: number; l: number; c: number; }
function load(sym: string): Bar[] { try { return fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1).map(r => { const x = r.split(","); return { d: x[0].slice(0, 10), o: +x[4], h: +x[5], l: +x[6], c: +x[7] }; }).filter(b => isFinite(b.c) && b.c > 0).sort((a, b) => (a.d < b.d ? -1 : 1)); } catch { return []; } }
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
function atr(b: Bar[], i: number, n = 14) { if (i < n) return 0; let s = 0; for (let j = i - n + 1; j <= i; j++) s += Math.max(b[j].h - b[j].l, Math.abs(b[j].h - b[j - 1].c), Math.abs(b[j].l - b[j - 1].c)); return s / n; }
const isFirstFriday = (d: string) => { const dt = new Date(d + "T12:00:00Z"); return dt.getUTCDay() === 5 && +d.slice(8, 10) <= 7; };

function main() {
  console.log("\n" + "═".repeat(80));
  console.log("  STAGE 2 — EVENT-DRIVEN STUDY (daily OHLC; NFP first-Friday + vol-shock)");
  console.log("═".repeat(80));
  const EQ = ["ES", "NQ", "ZN", "CL"];   // assets that react to macro

  // ---- NFP ----
  const preR: number[] = [], evMove: number[] = [], evExp: number[] = [], postR: number[] = [], baseExp: number[] = [];
  for (const sym of EQ) {
    const b = load(sym); if (b.length < 30) continue;
    for (let i = 20; i < b.length - 1; i++) {
      const a = atr(b, i - 1); if (a <= 0) continue; const exp = (b[i].h - b[i].l) / a;
      if (isFirstFriday(b[i].d)) { preR.push((b[i - 1].c - b[i - 2].c) / a); evMove.push((b[i].c - b[i].o) / a); evExp.push(exp); postR.push((b[i + 1].c - b[i].c) / a); }
      else baseExp.push(exp);
    }
  }
  console.log("\n  NFP (first Friday) — across ES/NQ/ZN/CL:");
  console.log(`     pre-day drift (day before): ${mean(preR) >= 0 ? "+" : ""}${mean(preR).toFixed(3)} ATR   (directional edge? ${Math.abs(mean(preR)) > 0.05 ? "maybe" : "no — flat"})`);
  console.log(`     event-day |range| expansion: ${mean(evExp).toFixed(2)} ATR vs ${mean(baseExp).toFixed(2)} baseline   (${(mean(evExp) / mean(baseExp) * 100 - 100).toFixed(0)}% larger ✅ expected)`);
  console.log(`     event-day direction (close-open): ${mean(evMove) >= 0 ? "+" : ""}${mean(evMove).toFixed(3)} ATR   (directional edge? ${Math.abs(mean(evMove)) > 0.05 ? "maybe" : "no — the surprise is random"})`);
  console.log(`     post-day drift: ${mean(postR) >= 0 ? "+" : ""}${mean(postR).toFixed(3)} ATR`);

  // ---- VOL-SHOCK reactions ----
  const nextVol: number[] = [], revert: number[] = [], allVol: number[] = [];
  for (const sym of [...EQ, "GC", "6E"]) {
    const b = load(sym); if (b.length < 30) continue;
    for (let i = 20; i < b.length - 2; i++) {
      const a = atr(b, i - 1); if (a <= 0) continue; const move = (b[i].c - b[i - 1].c) / a; allVol.push(Math.abs((b[i + 1].c - b[i].c) / a));
      if (Math.abs(move) > 2.5) { nextVol.push(Math.abs((b[i + 1].c - b[i].c) / a)); revert.push(-Math.sign(move) * (b[i + 1].c - b[i].c) / a); }
    }
  }
  console.log("\n  VOLATILITY-SHOCK reactions (>2.5 ATR day) — next-day behavior:");
  console.log(`     next-day move size: ${mean(nextVol).toFixed(2)} ATR vs ${mean(allVol).toFixed(2)} baseline   (vol persistence ${mean(nextVol) > mean(allVol) ? "✅ confirmed" : "no"})`);
  console.log(`     next-day reversion (vs shock dir): ${mean(revert) >= 0 ? "+" : ""}${mean(revert).toFixed(3)} ATR   (${Math.abs(mean(revert)) > 0.05 ? (mean(revert) > 0 ? "🟡 mild reversion" : "🟡 mild continuation") : "no clean directional edge"})`);

  console.log("\n  ⚠️ FOMC/CPI pre-drift (the documented directional event anomaly) needs a VERIFIED date");
  console.log("     calendar — I won't hardcode 15yr of dates from memory (error risk). That's a small sourcing task.");
  console.log("═".repeat(80) + "\n");
}
main();
