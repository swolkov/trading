/**
 * EVENT STUDY (Day 1 fail-fast) — volatility compression → breakout continuation.
 * No fitting. Measures the raw CONDITIONAL forward move after a low-vol "coil" breaks out,
 * in ATR units (R-like), pooled across 27 markets / 15yr, reported BY YEAR (consistency = real).
 * Kill-criterion: if forward edge isn't clearly + and year-consistent, the hypothesis dies here.
 *   npx tsx scripts/event-study.ts
 */
import fs from "node:fs";

interface Bar { d: string; o: number; h: number; l: number; c: number; }
function loadDaily(file: string): Bar[] {
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
const FWD = 3; // forward holding (days)

function study(bars: Bar[]): Ev[] {
  const evs: Ev[] = [];
  for (let i = 60; i < bars.length - FWD; i++) {
    const a = atr(bars, i); if (a <= 0) continue;
    // 5-day range, compared to its own trailing-60 average → "coil" if compressed
    const r5 = (k: number) => Math.max(...bars.slice(k - 5, k).map(x => x.h)) - Math.min(...bars.slice(k - 5, k).map(x => x.l));
    const cur5 = r5(i);
    let avg = 0; for (let k = i - 60; k < i; k++) avg += r5(k); avg /= 60;
    const coiled = cur5 < 0.6 * avg;
    if (!coiled) continue;
    // breakout of the 5-day range on this bar's close
    const hi5 = Math.max(...bars.slice(i - 5, i).map(x => x.h)), lo5 = Math.min(...bars.slice(i - 5, i).map(x => x.l));
    let dir = 0;
    if (bars[i].c > hi5) dir = 1; else if (bars[i].c < lo5) dir = -1;
    if (dir === 0) continue;
    // forward move over FWD days, in ATR units (R-like), direction-adjusted
    const fwd = (bars[i + FWD].c - bars[i].c) * dir;
    evs.push({ year: +bars[i].d.slice(0, 4), fwdR: fwd / a });
  }
  return evs;
}

function main() {
  const dir = new URL("../data/daily/", import.meta.url);
  let files: string[]; try { files = fs.readdirSync(dir).filter(f => f.endsWith("_1d.csv")); } catch { console.log("run dbn-fetch-daily.ts first"); return; }
  const all: Ev[] = [];
  for (const f of files) all.push(...study(loadDaily(new URL(f, dir) as unknown as string)));
  console.log("\n" + "═".repeat(76));
  console.log("  EVENT STUDY — vol-coil breakout → forward " + FWD + "-day move (ATR units), 27 mkts/15yr");
  console.log("  Fail-fast: is the conditional forward edge clearly + and year-consistent?");
  console.log("═".repeat(76));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const R = all.map(e => e.fwdR);
  const wins = R.filter(r => r > 0).length;
  console.log(`\n  POOLED: n=${all.length}  avg fwd ${mean(R) >= 0 ? "+" : ""}${mean(R).toFixed(3)}R  win ${(wins / all.length * 100).toFixed(0)}%`);
  const years = [...new Set(all.map(e => e.year))].sort();
  const posY = years.filter(y => mean(all.filter(e => e.year === y).map(e => e.fwdR)) > 0).length;
  console.log(`  by year (avg fwd R): ${years.map(y => `${String(y).slice(2)}:${(mean(all.filter(e => e.year === y).map(e => e.fwdR)) >= 0 ? "+" : "")}${mean(all.filter(e => e.year === y).map(e => e.fwdR)).toFixed(2)}`).join(" ")}`);
  console.log(`  → positive in ${posY}/${years.length} years`);
  console.log(`\n  VERDICT: ${mean(R) > 0.05 && posY >= years.length * 0.6 ? "✅ survives Day-1 screen — promote to deep-dive" : "❌ no clear edge — kill or re-specify"}`);
  console.log("═".repeat(76) + "\n");
}
main();
