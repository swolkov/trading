/**
 * TREND-FOLLOWING test — the historically-durable futures edge (time-series momentum /
 * Donchian channel breakout), on DAILY bars. Contrast with the intraday 5m strategy.
 * This is the approach managed-futures funds (Winton, Dunn, the Turtles) actually used.
 *
 * Reads data/<SYM>_1m.csv, aggregates to daily, runs Donchian breakout w/ ATR stop + trail,
 * reports by-year + fixed-fractional annual return.    npx tsx scripts/trend-test.ts
 */
import fs from "node:fs";

interface Bar { t: number; o: number; h: number; l: number; c: number; }
const SYMBOLS = ["ES", "NQ", "GC"];
const COMMISSION_R = 0; // daily-bar trend trades are infrequent + large — commission is negligible vs move size

function loadDaily(sym: string): Bar[] {
  const rows = fs.readFileSync(new URL(`../data/${sym}_1m.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
  const byDay = new Map<string, Bar>();
  for (const r of rows) {
    const c = r.split(",");
    const day = c[0].slice(0, 10); // UTC date — fine for a daily trend signal
    const o = +c[4], h = +c[5], l = +c[6], cl = +c[7];
    const e = byDay.get(day);
    if (!e) byDay.set(day, { t: new Date(day).getTime(), o, h, l, c: cl });
    else { e.h = Math.max(e.h, h); e.l = Math.min(e.l, l); e.c = cl; }
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

function atr(bars: Bar[], i: number, period = 20): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++)
    s += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
  return s / period;
}

interface Trade { sym: string; dir: string; r: number; entryT: number; }

// Donchian breakout: enter on enterN-day high/low breakout; stop = stopMult*ATR; trail-exit on exitN-day opposite.
function donchian(sym: string, enterN: number, exitN: number, stopMult: number): Trade[] {
  const bars = loadDaily(sym);
  const trades: Trade[] = [];
  let pos: { dir: string; entry: number; stop: number; risk: number; entryT: number } | null = null;
  for (let i = Math.max(enterN, 21); i < bars.length; i++) {
    const b = bars[i];
    const hiN = Math.max(...bars.slice(i - enterN, i).map(x => x.h));
    const loN = Math.min(...bars.slice(i - enterN, i).map(x => x.l));
    const hiX = Math.max(...bars.slice(i - exitN, i).map(x => x.h));
    const loX = Math.min(...bars.slice(i - exitN, i).map(x => x.l));
    const a = atr(bars, i);
    if (pos) {
      const long = pos.dir === "long";
      let exit: number | null = null;
      if (long && b.l <= pos.stop) exit = pos.stop;          // initial stop
      else if (!long && b.h >= pos.stop) exit = pos.stop;
      else if (long && b.c < loX) exit = b.c;                // trail-exit (opposite Donchian)
      else if (!long && b.c > hiX) exit = b.c;
      if (exit !== null) {
        const r = (long ? exit - pos.entry : pos.entry - exit) / pos.risk - COMMISSION_R;
        trades.push({ sym, dir: pos.dir, r, entryT: pos.entryT });
        pos = null;
      }
    }
    if (!pos && a > 0) {
      if (b.c > hiN) pos = { dir: "long", entry: b.c, stop: b.c - stopMult * a, risk: stopMult * a, entryT: b.t };
      else if (b.c < loN) pos = { dir: "short", entry: b.c, stop: b.c + stopMult * a, risk: stopMult * a, entryT: b.t };
    }
  }
  return trades;
}

function stats(ts: Trade[]) {
  const n = ts.length; if (!n) return null;
  const w = ts.filter(t => t.r > 0), gw = ts.filter(t => t.r > 0).reduce((s, t) => s + t.r, 0);
  const gl = Math.abs(ts.filter(t => t.r < 0).reduce((s, t) => s + t.r, 0));
  const sumR = ts.reduce((s, t) => s + t.r, 0);
  return { n, wr: w.length / n, expR: sumR / n, sumR, pf: gl ? gw / gl : Infinity };
}
const yearOf = (t: Trade) => new Date(t.entryT).getUTCFullYear();

function report(label: string, all: Trade[]) {
  const s = stats(all);
  if (!s) { console.log(`\n${label}: no trades`); return; }
  console.log(`\n${label}:  n=${s.n}  win ${(s.wr * 100).toFixed(0)}%  expR ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)}  sumR ${s.sumR >= 0 ? "+" : ""}${s.sumR.toFixed(0)}  PF ${s.pf === Infinity ? "INF" : s.pf.toFixed(2)}`);
  const years = [...new Set(all.map(yearOf))].sort();
  const parts = years.map(y => { const ys = stats(all.filter(t => yearOf(t) === y)); return ys ? `${y} ${ys.sumR >= 0 ? "+" : ""}${ys.sumR.toFixed(0)}R/${ys.n}` : `${y} —`; });
  console.log(`   by year: ${parts.join("  ")}`);
  for (const risk of [0.005, 0.01, 0.02]) {
    let eq = 1; const rp = years.map(y => { const r = all.filter(t => yearOf(t) === y).reduce((s, t) => s + t.r, 0) * risk; eq *= (1 + r); return `${y} ${r >= 0 ? "+" : ""}${(r * 100).toFixed(0)}%`; });
    console.log(`   @ ${(risk * 100).toFixed(1)}% risk: ${rp.join("  ")}  → compounded ${((eq - 1) * 100).toFixed(0)}%`);
  }
}

async function main() {
  console.log("\n" + "═".repeat(74));
  console.log("  TREND-FOLLOWING (Donchian breakout, DAILY bars) — the documented futures edge");
  console.log("═".repeat(74));
  for (const [eN, xN, sm] of [[55, 20, 2], [20, 10, 2]] as [number, number, number][]) {
    console.log("\n" + "─".repeat(74));
    console.log(`SYSTEM: enter ${eN}-day breakout, exit ${xN}-day opposite, ${sm}×ATR stop`);
    const all: Trade[] = [];
    for (const sym of SYMBOLS) { const t = donchian(sym, eN, xN, sm); all.push(...t); report(`  ${sym}`, t); }
    report("  ★ COMBINED (3 markets)", all);
  }
  console.log("\n⚠️  Only ~3yr / 3 markets — trend-following needs LONG samples + MANY markets to prove out.");
  console.log("   If promising, pull 15yr daily across 20+ futures (cheap) for a real test.");
  console.log("═".repeat(74) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
