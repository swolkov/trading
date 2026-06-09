/**
 * CORRECTED MBT NR4 backtest — rebuilt after Fable 5's look-ahead/fill-bias audit
 * (June 9 2026). Gates a real-money decision, so every known optimistic bias from the
 * old harness (scripts/backtest-crypto-slippage-sweep.ts) is fixed here:
 *
 *   FIX 1 (look-ahead, direction): entry direction = whichever of the prior-day high/low
 *          is FIRST TOUCHED walking the day's 1m bars in time order. The old code decided
 *          long-first using the COMPLETED daily bar's H/L — forcing every both-sides-broke
 *          day long and making shorts structurally unable to stop out.
 *   FIX 2 (look-ahead, exit): the stop/target walk starts at the ENTRY bar, not the session
 *          open. The old code counted prints that happened before the breakout.
 *   FIX 3 (fill realism / gaps): if the session gaps open through the level, fill at the
 *          actual open (the price you could really get), not the untraded level. Stop/target
 *          are anchored to the strategy's level (entry=nr4 H/L) but P&L uses ACTUAL fills, so
 *          a worse fill correctly shows as realized risk > 1R.
 *   FIX 4 (day boundary): daily bars aggregated at 00:00 UTC to MATCH the live engine's
 *          buildTodayDailyBar(), so the backtest measures what live would actually trade.
 *   FIX 5 (slippage units): slippage swept in POINTS ($0.10/pt on MBT), spanning the
 *          realistic 5m-poll chase range (Fable 5: $5–$20/trade = 50–200 pts), not tiny ticks.
 *
 * Also reports: by-year P&L, win rate, expectancy, and a bootstrap 95% CI on PF.
 *
 * Run: node_modules/.bin/tsx scripts/backtest-mbt-nr4-corrected.ts
 */
import fs from "node:fs";

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }

const SYM = "MBT";
const MULT = 0.10;            // $ per point
const POINT = 1;             // 1 price point; MBT min tick = 5 pts ($0.50)
const NR4_RANGE_RATIO = 0.5;
const ATR_LOOKBACK = 20;
const STOP_R_MULT = 1.0;
const TARGET_R_MULT = 3.0;
const COMM_PER_SIDE = 2.0;    // $/side

function load1m(sym: string): Bar[] {
  const path = new URL(`../data/${sym}_1m.csv`, import.meta.url);
  if (!fs.existsSync(path)) throw new Error(`missing data/${sym}_1m.csv`);
  const rows = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
  const m1: Bar[] = [];
  for (const r of rows) {
    const c = r.split(",");
    const bar = { t: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] };
    if (isFinite(bar.c) && bar.c > 0 && isFinite(bar.t)) m1.push(bar);
  }
  m1.sort((a, b) => a.t - b.t);
  return m1;
}

// FIX 4: aggregate to daily at 00:00 UTC (matches live buildTodayDailyBar).
function groupByUtcDay(m1: Bar[]): { key: string; bars: Bar[]; daily: Bar }[] {
  const map = new Map<string, Bar[]>();
  for (const b of m1) {
    const key = new Date(b.t).toISOString().slice(0, 10); // UTC day
    (map.get(key) ?? map.set(key, []).get(key)!).push(b);
  }
  const days = [...map.entries()].map(([key, bars]) => {
    bars.sort((a, z) => a.t - z.t);
    const daily: Bar = {
      t: bars[0].t, o: bars[0].o,
      h: Math.max(...bars.map((x) => x.h)),
      l: Math.min(...bars.map((x) => x.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, x) => s + x.v, 0),
    };
    return { key, bars, daily };
  });
  days.sort((a, z) => a.daily.t - z.daily.t);
  return days;
}

// True-range ATR over `period` days ending at index i (matches live dailyATR).
function atrAt(daily: Bar[], i: number, period = ATR_LOOKBACK): number {
  if (i < period) return 0;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = j === 0
      ? daily[j].h - daily[j].l
      : Math.max(daily[j].h - daily[j].l, Math.abs(daily[j].h - daily[j - 1].c), Math.abs(daily[j].l - daily[j - 1].c));
    sum += tr;
  }
  return sum / period;
}

interface Trade {
  dir: "long" | "short";
  entryBase: number;   // actual fill before slippage (incl. gap)
  exitBase: number;    // actual exit price before slippage
  outcome: "target" | "stop" | "time";
  year: number;
  nr4Range: number;
}

function backtest(m1: Bar[]): Trade[] {
  const days = groupByUtcDay(m1);
  const daily = days.map((d) => d.daily);
  const trades: Trade[] = [];

  // trade on day i; NR4 anchor = day i-1; ATR over the 20 days ending at i-1
  for (let i = ATR_LOOKBACK + 1; i < days.length; i++) {
    const nr4 = daily[i - 1];
    const atr = atrAt(daily, i - 1);
    if (atr <= 0) continue;
    const nr4Range = nr4.h - nr4.l;
    if (nr4Range <= 0 || nr4Range >= atr * NR4_RANGE_RATIO) continue; // not narrow enough

    const dayBars = days[i].bars;
    if (dayBars.length === 0) continue;

    // FIX 1: first-touch determines direction. Walk 1m bars in time order.
    let dir: "long" | "short" | null = null;
    let entryIdx = -1;
    let entryBase = 0;
    for (let k = 0; k < dayBars.length; k++) {
      const b = dayBars[k];
      const touchHigh = b.h >= nr4.h;
      const touchLow = b.l <= nr4.l;
      if (touchHigh && touchLow) { dir = null; entryIdx = -2; break; } // single bar straddles both → unresolvable, skip
      if (touchHigh) {
        dir = "long";
        entryIdx = k;
        entryBase = Math.max(nr4.h, b.o); // FIX 3: gap-open fills worse than the level
        break;
      }
      if (touchLow) {
        dir = "short";
        entryIdx = k;
        entryBase = Math.min(nr4.l, b.o);
        break;
      }
    }
    if (!dir || entryIdx < 0) continue;

    // Stop/target anchored to the strategy's level (nr4 H/L), per spec.
    const entryLevel = dir === "long" ? nr4.h : nr4.l;
    const stopDist = nr4Range * STOP_R_MULT;
    const targetDist = nr4Range * TARGET_R_MULT;
    const stop = dir === "long" ? entryLevel - stopDist : entryLevel + stopDist;
    const target = dir === "long" ? entryLevel + targetDist : entryLevel - targetDist;

    // FIX 2: exit walk starts at the ENTRY bar, not the session open.
    let outcome: "target" | "stop" | "time" = "time";
    let exitBase = dayBars[dayBars.length - 1].c; // time exit at session end
    for (let k = entryIdx; k < dayBars.length; k++) {
      const b = dayBars[k];
      const hitStop = dir === "long" ? b.l <= stop : b.h >= stop;
      const hitTarget = dir === "long" ? b.h >= target : b.l <= target;
      if (hitStop) { outcome = "stop"; exitBase = stop; break; }   // both-in-bar → stop (conservative)
      if (hitTarget) { outcome = "target"; exitBase = target; break; }
    }

    trades.push({ dir, entryBase, exitBase, outcome, year: new Date(days[i].daily.t).getUTCFullYear(), nr4Range });
  }
  return trades;
}

function pnlOf(t: Trade, slipPts: number): number {
  const long = t.dir === "long";
  const entry = long ? t.entryBase + slipPts * POINT : t.entryBase - slipPts * POINT; // adverse
  const exit = long ? t.exitBase - slipPts * POINT : t.exitBase + slipPts * POINT;     // adverse
  return (long ? exit - entry : entry - exit) * MULT - COMM_PER_SIDE * 2;
}

function stats(trades: Trade[], slipPts: number) {
  let net = 0, wins = 0, gw = 0, gl = 0;
  for (const t of trades) {
    const p = pnlOf(t, slipPts);
    net += p;
    if (p > 0) { wins++; gw += p; } else gl += Math.abs(p);
  }
  const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  return { n: trades.length, net, pf, wr: trades.length ? wins / trades.length : 0, exp: trades.length ? net / trades.length : 0 };
}

// Bootstrap 95% CI on PF (resample trades with replacement). Deterministic LCG seed.
function bootstrapPF(trades: Trade[], slipPts: number, iters = 2000): [number, number] {
  const pnls = trades.map((t) => pnlOf(t, slipPts));
  let seed = 1234567;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pfs: number[] = [];
  for (let it = 0; it < iters; it++) {
    let gw = 0, gl = 0;
    for (let k = 0; k < pnls.length; k++) {
      const p = pnls[(rand() * pnls.length) | 0];
      if (p > 0) gw += p; else gl += Math.abs(p);
    }
    pfs.push(gl > 0 ? gw / gl : gw > 0 ? 99 : 0);
  }
  pfs.sort((a, b) => a - b);
  return [pfs[Math.floor(iters * 0.025)], pfs[Math.floor(iters * 0.975)]];
}

function main() {
  const m1 = load1m(SYM);
  const trades = backtest(m1);
  const money = (x: number) => (x >= 0 ? "+$" : "-$") + Math.abs(x).toFixed(0);

  console.log(`\n  CORRECTED MBT NR4 BACKTEST  (data: ${new Date(m1[0].t).toISOString().slice(0,10)} → ${new Date(m1[m1.length-1].t).toISOString().slice(0,10)}, ${(m1.length/1000).toFixed(0)}k 1m bars)`);
  console.log(`  Fixes: first-touch direction, exit-from-entry, gap-aware fills, UTC day boundary, dollar slippage.\n`);

  const longs = trades.filter((t) => t.dir === "long").length;
  const stopCount = trades.filter((t) => t.outcome === "stop").length;
  const targetCount = trades.filter((t) => t.outcome === "target").length;
  console.log(`  Trades: ${trades.length}  (long ${longs} / short ${trades.length - longs})  |  outcomes: target ${targetCount}, stop ${stopCount}, time ${trades.length - stopCount - targetCount}`);

  console.log(`\n  PF / expectancy / net across slippage (commission $${COMM_PER_SIDE}/side):`);
  console.log(`  slip(pts)  $/trade-slip    n     PF      exp/trade     net`);
  for (const slip of [0, 5, 25, 50, 100, 150, 200]) {
    const r = stats(trades, slip);
    const dollarSlip = (slip * MULT * 2).toFixed(2); // both sides
    console.log(`   ${String(slip).padStart(4)}      $${dollarSlip.padStart(6)}/rt   ${String(r.n).padStart(4)}   ${(r.pf === Infinity ? "INF" : r.pf.toFixed(2)).padStart(5)}   ${money(r.exp).padStart(9)}   ${money(r.net).padStart(9)}`);
  }

  // Headline: a realistic-but-not-pessimistic 25-pt ($2.50/side) slippage case
  const head = stats(trades, 25);
  const [lo, hi] = bootstrapPF(trades, 25);
  console.log(`\n  HEADLINE @ 25pt slip ($2.50/side): n=${head.n}, PF ${head.pf.toFixed(2)}, win ${(head.wr*100).toFixed(0)}%, exp ${money(head.exp)}/trade, net ${money(head.net)}/contract`);
  console.log(`  Bootstrap 95% CI on PF: [${lo.toFixed(2)}, ${hi.toFixed(2)}]   ${lo > 1.3 ? "✓ floor > 1.3" : lo > 1.0 ? "~ floor > 1.0 but < 1.3" : "✗ floor ≤ 1.0 (not demonstrated)"}`);

  console.log(`\n  By year (at 25pt slip):`);
  const years = [...new Set(trades.map((t) => t.year))].sort();
  for (const y of years) {
    const yt = trades.filter((t) => t.year === y);
    const r = stats(yt, 25);
    console.log(`    ${y}:  n=${String(r.n).padStart(3)}   PF ${(r.pf===Infinity?"INF":r.pf.toFixed(2)).padStart(5)}   ${money(r.net).padStart(9)}   win ${(r.wr*100).toFixed(0)}%`);
  }
  console.log("");
}

main();
