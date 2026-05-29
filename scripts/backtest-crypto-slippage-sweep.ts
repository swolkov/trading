/**
 * BACKTEST — slippage + commission SENSITIVITY SWEEP for the validated MBT NR4 edge.
 *
 * The original backtest assumes 1 tick adverse slippage + $2.00/side commission. Real
 * execution may be worse. This script re-runs the SAME signal logic across a grid of
 * slippage and commission assumptions, so we can answer:
 *
 *   "At what slippage level does our PF 2.03 edge stop being profitable?"
 *
 * The answer determines whether the edge is execution-robust or execution-fragile.
 *
 * Methodology:
 *   - Same NR4 daily strategy as backtest-crypto.ts
 *   - Slippage swept: 0.5, 1.0, 1.5, 2.0, 3.0 ticks per side
 *   - Commission swept: $1, $2, $3 per side
 *   - PF, expectancy, net P&L computed for each combination
 *   - Break-even slippage identified
 *
 * Run: npx tsx scripts/backtest-crypto-slippage-sweep.ts
 */
import fs from "node:fs";

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }

const MULT: Record<string, number> = { MBT: 0.10, MET: 0.10, BFF: 0.01 };
const TICK: Record<string, number> = { MBT: 5, MET: 0.50, BFF: 5 };
const NR4_RANGE_RATIO = 0.5;
const ATR_LOOKBACK = 20;
const STOP_R_MULT = 1.0;
const TARGET_R_MULT = 3.0;

function load1m(sym: string): Bar[] {
  const path = new URL(`../data/${sym}_1m.csv`, import.meta.url);
  if (!fs.existsSync(path)) throw new Error(`missing data/${sym}_1m.csv`);
  const rows = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
  const m1: Bar[] = [];
  for (const r of rows) {
    const c = r.split(",");
    m1.push({ t: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] });
  }
  m1.sort((a, b) => a.t - b.t);
  return m1;
}

function aggregateDaily(m1: Bar[]): Bar[] {
  const buckets = new Map<string, Bar>();
  for (const b of m1) {
    const sessTs = b.t - 5 * 3600_000;
    const key = new Date(sessTs).toISOString().slice(0, 10);
    const ex = buckets.get(key);
    if (!ex) buckets.set(key, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

function dailyATR(daily: Bar[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < daily.length; i++) {
    if (i < period) { out.push(0); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tr = j === 0 ? daily[j].h - daily[j].l : Math.max(daily[j].h - daily[j].l, Math.abs(daily[j].h - daily[j - 1].c), Math.abs(daily[j].l - daily[j - 1].c));
      sum += tr;
    }
    out.push(sum / period);
  }
  return out;
}

interface Trade { sym: string; dir: "long" | "short"; entry: number; exit: number; outcome: "target" | "stop" | "time"; entryTime: number; stopDist: number; }

function detectAndExecuteNR4(sym: string, m1: Bar[]): Trade[] {
  const daily = aggregateDaily(m1);
  const atrs = dailyATR(daily, ATR_LOOKBACK);
  const trades: Trade[] = [];

  for (let i = ATR_LOOKBACK + 1; i < daily.length - 1; i++) {
    const nr4 = daily[i - 1]; // yesterday's candle (the NR4 anchor)
    const today = daily[i];
    const atr = atrs[i - 1];
    if (atr <= 0) continue;
    const nr4Range = nr4.h - nr4.l;
    if (nr4Range >= atr * NR4_RANGE_RATIO) continue;

    // Determine direction & entry from today's first break
    let dir: "long" | "short" | null = null;
    let entryPrice = 0;
    if (today.h > nr4.h && today.l < nr4.h) { dir = "long"; entryPrice = nr4.h; }
    else if (today.l < nr4.l && today.h > nr4.l) { dir = "short"; entryPrice = nr4.l; }
    if (!dir) continue;

    const stopDist = nr4Range * STOP_R_MULT;
    const targetDist = nr4Range * TARGET_R_MULT;
    const stop = dir === "long" ? entryPrice - stopDist : entryPrice + stopDist;
    const target = dir === "long" ? entryPrice + targetDist : entryPrice - targetDist;

    // Walk the 1m bars within this daily session to find outcome
    const dayStart = today.t;
    const dayEnd = today.t + 23 * 3600_000;
    let outcome: "target" | "stop" | "time" = "time";
    let exitPx = today.c;
    for (const b of m1) {
      if (b.t < dayStart) continue;
      if (b.t > dayEnd) break;
      const hitStop = dir === "long" ? b.l <= stop : b.h >= stop;
      const hitTarget = dir === "long" ? b.h >= target : b.l <= target;
      if (hitStop && hitTarget) { outcome = "stop"; exitPx = stop; break; }
      if (hitStop) { outcome = "stop"; exitPx = stop; break; }
      if (hitTarget) { outcome = "target"; exitPx = target; break; }
    }
    trades.push({ sym, dir, entry: entryPrice, exit: exitPx, outcome, entryTime: today.t, stopDist });
  }
  return trades;
}

function applyCosts(trades: Trade[], sym: string, slipTicks: number, commPerSide: number) {
  const mult = MULT[sym];
  const tick = TICK[sym];
  let net = 0;
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const t of trades) {
    const long = t.dir === "long";
    const slipEntry = long ? t.entry + slipTicks * tick : t.entry - slipTicks * tick;
    const slipExit = long ? t.exit - slipTicks * tick : t.exit + slipTicks * tick;
    const pnl = (long ? slipExit - slipEntry : slipEntry - slipExit) * mult - commPerSide * 2;
    net += pnl;
    if (pnl > 0) { wins++; grossWin += pnl; }
    else grossLoss += Math.abs(pnl);
  }
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  return { n: trades.length, net, pf, wr: trades.length ? wins / trades.length : 0, exp: trades.length ? net / trades.length : 0 };
}

const money = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(0)}`;

async function main() {
  console.log("\n" + "═".repeat(94));
  console.log("  MBT NR4 SLIPPAGE + COMMISSION SENSITIVITY SWEEP");
  console.log("  Tests how robust the PF 2.03 edge is to worse-than-assumed execution.");
  console.log("═".repeat(94));

  const SYMS = ["MBT", "MET", "BFF"];
  for (const sym of SYMS) {
    try {
      console.log(`\n${sym}:`);
      const m1 = load1m(sym);
      const trades = detectAndExecuteNR4(sym, m1);
      console.log(`  raw NR4 trades detected: ${trades.length}`);
      const targets = trades.filter(t => t.outcome === "target").length;
      const stops = trades.filter(t => t.outcome === "stop").length;
      const times = trades.filter(t => t.outcome === "time").length;
      console.log(`  outcomes: ${targets} targets / ${stops} stops / ${times} time-exits`);

      // Header row
      console.log("\n  Slip→  | " + ["0.5 tick", "1.0 tick", "1.5 tick", "2.0 tick", "3.0 tick"].map(s => s.padStart(12)).join(" | "));
      console.log("  " + "─".repeat(86));
      for (const comm of [1.0, 2.0, 3.0]) {
        const row = [`$${comm.toFixed(0)}/side`.padEnd(8)];
        for (const slip of [0.5, 1.0, 1.5, 2.0, 3.0]) {
          const r = applyCosts(trades, sym, slip, comm);
          const pfStr = r.pf === Infinity ? "INF" : r.pf.toFixed(2);
          const cell = `PF ${pfStr} ${money(r.net)}`.padStart(12);
          row.push(cell);
        }
        console.log("  " + row.join(" | "));
      }

      // Break-even slippage at $2 commission (the realistic mid-case)
      console.log("\n  Break-even slippage (at $2/side commission):");
      for (let slip = 0.5; slip <= 5.0; slip += 0.1) {
        const r = applyCosts(trades, sym, slip, 2.0);
        if (r.pf < 1.0) {
          console.log(`    PF crosses below 1.0 at ${slip.toFixed(1)} ticks`);
          break;
        }
        if (slip >= 4.9) console.log(`    Still PF >= 1.0 at 5 ticks slippage — edge is execution-robust`);
      }

      // Per-trade economics at our standard (1 tick + $2)
      const r1 = applyCosts(trades, sym, 1.0, 2.0);
      console.log(`\n  At our standard (1 tick + $2 comm): n=${r1.n}, PF ${r1.pf === Infinity ? "INF" : r1.pf.toFixed(2)}, exp ${money(r1.exp)}/trade, net ${money(r1.net)}, win ${(r1.wr * 100).toFixed(0)}%`);
    } catch (e) {
      console.log(`  ${sym} — ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log("\n" + "═".repeat(94));
  console.log("  Interpretation guide:");
  console.log("    PF >= 1.3 at 1 tick slip = solid edge");
  console.log("    PF holds >= 1.0 at 2+ ticks = execution-robust (recommended for live)");
  console.log("    PF drops below 1.0 at < 1.5 ticks = execution-fragile (paper only)");
  console.log("═".repeat(94) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
