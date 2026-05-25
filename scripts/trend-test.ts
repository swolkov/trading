/**
 * TREND-FOLLOWING test across a DIVERSIFIED basket on 15yr DAILY bars (data/daily/).
 * The documented, durable futures edge (time-series momentum / Donchian breakout) — the approach
 * that built managed-futures funds. Its power IS diversification: catch the trend wherever it shows up.
 * R-multiples are sizing-independent, so no per-market multipliers needed.
 *   npx tsx scripts/trend-test.ts
 */
import fs from "node:fs";

interface Bar { t: number; o: number; h: number; l: number; c: number; }

function loadDaily(file: string | URL): Bar[] {
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  return rows
    .map(r => { const c = r.split(","); return { t: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7] }; })
    .filter(b => isFinite(b.c) && b.c > 0 && isFinite(b.h) && isFinite(b.l))
    .sort((a, b) => a.t - b.t);
}

function atr(bars: Bar[], i: number, period = 20): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++)
    s += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
  return s / period;
}

interface Trade { sym: string; r: number; entryT: number; }

// Donchian: enter on enterN-day high/low breakout; stop = stopMult×ATR; trail-exit on exitN-day opposite.
function donchian(sym: string, bars: Bar[], enterN: number, exitN: number, stopMult: number): Trade[] {
  const trades: Trade[] = [];
  let pos: { dir: string; entry: number; stop: number; risk: number; entryT: number } | null = null;
  for (let i = enterN; i < bars.length; i++) {
    const b = bars[i];
    const hiN = Math.max(...bars.slice(i - enterN, i).map(x => x.h));
    const loN = Math.min(...bars.slice(i - enterN, i).map(x => x.l));
    const hiX = Math.max(...bars.slice(i - exitN, i).map(x => x.h));
    const loX = Math.min(...bars.slice(i - exitN, i).map(x => x.l));
    const a = atr(bars, i);
    if (pos) {
      const long = pos.dir === "long";
      let exit: number | null = null;
      if (long && b.l <= pos.stop) exit = pos.stop;
      else if (!long && b.h >= pos.stop) exit = pos.stop;
      else if (long && b.c < loX) exit = b.c;
      else if (!long && b.c > hiX) exit = b.c;
      if (exit !== null) { trades.push({ sym, r: (long ? exit - pos.entry : pos.entry - exit) / pos.risk, entryT: pos.entryT }); pos = null; }
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
  const w = ts.filter(t => t.r > 0), gw = w.reduce((s, t) => s + t.r, 0);
  const gl = Math.abs(ts.filter(t => t.r < 0).reduce((s, t) => s + t.r, 0));
  return { n, wr: w.length / n, expR: ts.reduce((s, t) => s + t.r, 0) / n, sumR: ts.reduce((s, t) => s + t.r, 0), pf: gl ? gw / gl : Infinity };
}
const yearOf = (t: Trade) => new Date(t.entryT).getUTCFullYear();

async function main() {
  const dir = new URL("../data/daily/", import.meta.url);
  let files: string[];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith("_1d.csv")); }
  catch { console.log("No data/daily/ — run: npx tsx scripts/dbn-fetch-daily.ts 15"); return; }
  if (!files.length) { console.log("data/daily/ empty — run dbn-fetch-daily.ts first"); return; }

  console.log("\n" + "═".repeat(78));
  console.log(`  TREND-FOLLOWING (Donchian, daily) across ${files.length} DIVERSIFIED markets, 15yr`);
  console.log("═".repeat(78));

  for (const [eN, xN, sm] of [[50, 20, 2], [100, 50, 3]] as [number, number, number][]) {
    console.log("\n" + "─".repeat(78));
    console.log(`SYSTEM: enter ${eN}-day breakout · exit ${xN}-day opposite · ${sm}×ATR stop`);
    const all: Trade[] = [];
    let mkts = 0, winners = 0;
    for (const f of files.sort()) {
      const sym = f.replace("_1d.csv", "");
      const t = donchian(sym, loadDaily(new URL(f, dir)), eN, xN, sm);
      all.push(...t); const ms = stats(t); if (ms) { mkts++; if (ms.sumR > 0) winners++; }
    }
    const s = stats(all);
    if (s) {
      console.log(`  per-market: ${winners}/${mkts} markets net-positive`);
      console.log(`  ★ PORTFOLIO (all markets):  n=${s.n}  win ${(s.wr * 100).toFixed(0)}%  expR ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)}R  sumR ${s.sumR >= 0 ? "+" : ""}${s.sumR.toFixed(0)}R  PF ${s.pf.toFixed(2)}`);
      const years = [...new Set(all.map(yearOf))].sort();
      const yearSum = (y: number) => all.filter(t => yearOf(t) === y).reduce((a, t) => a + t.r, 0);
      console.log(`  by year (sumR): ${years.map(y => `${String(y).slice(2)}:${yearSum(y) >= 0 ? "+" : ""}${yearSum(y).toFixed(0)}`).join(" ")}`);
      const posYears = years.filter(y => yearSum(y) > 0).length;
      const avgYr = s.sumR / years.length;
      console.log(`  → positive in ${posYears}/${years.length} years | avg ${avgYr.toFixed(0)}R/yr`);
      // income estimate: risk r% per trade → annual return ≈ avgYr-R × r% (0.25-0.5% is sane for a many-market book)
      console.log(`  → at 0.25%/trade ≈ ${(avgYr * 0.25).toFixed(0)}%/yr · at 0.5%/trade ≈ ${(avgYr * 0.5).toFixed(0)}%/yr (avg)`);
    }
  }
  console.log("\n" + "═".repeat(78) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
