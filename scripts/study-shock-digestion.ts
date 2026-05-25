/**
 * STRUCTURAL EVENT STUDY — shock-day digestion (15yr × 27 markets, daily). No fitting.
 * Hypothesis: a big move that CLOSES STRONG (accepted) → institutions reposition over days → CONTINUATION.
 *             a big move that REVERSES intraday (failed reaction) → trapped traders cover → REVERSAL.
 * Forced participants: institutions (impact-spread execution) + trapped momentum chasers.
 * Measures forward 2-day move in ATR units, by year. Kill if not + and year-consistent.
 *   npx tsx scripts/study-shock-digestion.ts
 */
import fs from "node:fs";

interface Bar { d: string; o: number; h: number; l: number; c: number; }
function loadDaily(file: string | URL): Bar[] {
  return fs.readFileSync(file, "utf8").trim().split("\n").slice(1)
    .map(r => { const x = r.split(","); return { d: x[0].slice(0, 10), o: +x[4], h: +x[5], l: +x[6], c: +x[7] }; })
    .filter(b => isFinite(b.c) && b.c > 0 && isFinite(b.h)).sort((a, b) => (a.d < b.d ? -1 : 1));
}
function atr(b: Bar[], i: number, n = 14): number {
  if (i < n) return 0; let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += Math.max(b[j].h - b[j].l, Math.abs(b[j].h - b[j - 1].c), Math.abs(b[j].l - b[j - 1].c));
  return s / n;
}
interface Ev { year: number; fwdR: number; }
const FWD = 2;

function study(bars: Bar[], cont: Ev[], fail: Ev[]) {
  const absR: number[] = [];
  for (let i = 1; i < bars.length; i++) absR.push(Math.abs((bars[i].c - bars[i - 1].c) / bars[i - 1].c));
  const thr = [...absR].sort((a, b) => a - b)[Math.floor(absR.length * 0.85)]; // top 15% |move| = "shock"
  for (let i = 60; i < bars.length - FWD; i++) {
    const r = (bars[i].c - bars[i - 1].c) / bars[i - 1].c;
    if (Math.abs(r) < thr) continue;
    const dir = Math.sign(r), rng = bars[i].h - bars[i].l, a = atr(bars, i);
    if (rng <= 0 || a <= 0) continue;
    const closePos = (bars[i].c - bars[i].l) / rng;                 // 0 = low, 1 = high
    const fwd = bars[i + FWD].c - bars[i].c;
    const strong = dir > 0 ? closePos > 0.7 : closePos < 0.3;        // closed in the move's direction = accepted
    const weak = dir > 0 ? closePos < 0.3 : closePos > 0.7;          // reversed intraday = failed reaction
    if (strong) cont.push({ year: +bars[i].d.slice(0, 4), fwdR: (fwd * dir) / a });        // trade WITH the move
    else if (weak) fail.push({ year: +bars[i].d.slice(0, 4), fwdR: (fwd * -dir) / a });    // trade AGAINST (fade)
  }
}

function report(label: string, ev: Ev[]) {
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const R = ev.map(e => e.fwdR), wins = R.filter(r => r > 0).length;
  const years = [...new Set(ev.map(e => e.year))].sort();
  const posY = years.filter(y => mean(ev.filter(e => e.year === y).map(e => e.fwdR)) > 0).length;
  console.log(`\n  ${label}: n=${ev.length}  avg fwd ${mean(R) >= 0 ? "+" : ""}${mean(R).toFixed(3)}R  win ${(wins / ev.length * 100).toFixed(0)}%  +in ${posY}/${years.length} yrs`);
  console.log(`    by year: ${years.map(y => `${String(y).slice(2)}:${(mean(ev.filter(e => e.year === y).map(e => e.fwdR)) >= 0 ? "+" : "")}${mean(ev.filter(e => e.year === y).map(e => e.fwdR)).toFixed(2)}`).join(" ")}`);
  const ok = mean(R) > 0.05 && posY >= years.length * 0.65;
  console.log(`    VERDICT: ${ok ? "✅ survives — deep-dive" : "❌ no clear edge"}`);
}

function main() {
  const dir = new URL("../data/daily/", import.meta.url);
  const files = fs.readdirSync(dir).filter(f => f.endsWith("_1d.csv"));
  const cont: Ev[] = [], fail: Ev[] = [];
  for (const f of files) study(loadDaily(new URL(f, dir)), cont, fail);
  console.log("\n" + "═".repeat(78));
  console.log("  SHOCK-DAY DIGESTION — forward 2-day move after a big move, by close character (27mkts/15yr)");
  console.log("═".repeat(78));
  report("CONTINUATION (big move, closed STRONG → trade with)", cont);
  report("FAILED REACTION (big move, REVERSED intraday → fade)", fail);
  console.log("\n" + "═".repeat(78) + "\n");
}
main();
