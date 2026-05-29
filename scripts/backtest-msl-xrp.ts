/**
 * Backtest patterns on MSL (micro SOL) + XRP daily bars.
 * Patterns tested:
 *   1. NR4 range expansion (same logic as MBT — breakout from narrow-range day)
 *   2. 3-day momentum continuation
 *   3. Mean reversion (3 consecutive down days → long)
 *   4. Simple breakout (prior day H/L)
 *
 * Cost assumptions per contract per round-trip:
 *   MSL: 1 tick ($0.0625) slippage each side + $2 commission ≈ $2.13
 *   XRP: 1 tick ($1.25 per tick = $0.025 × 50) + $2 commission ≈ $3.25
 */
import fs from "node:fs";

interface Bar { date: string; o: number; h: number; l: number; c: number; v: number; }

function loadCsv(path: string): Bar[] {
  const csv = fs.readFileSync(path, "utf8");
  return csv.trim().split("\n").slice(1).map((line) => {
    const [ts, , , , o, h, l, c, v] = line.split(",");
    return {
      date: ts.slice(0, 10),
      o: parseFloat(o), h: parseFloat(h), l: parseFloat(l), c: parseFloat(c),
      v: parseFloat(v || "0"),
    };
  }).filter((b) => isFinite(b.c) && b.c > 0);
}

function dailyATR(bars: Bar[], i: number, period = 20): number {
  if (i < period) return 0;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const tr = k === 0
      ? bars[k].h - bars[k].l
      : Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
    sum += tr;
  }
  return sum / period;
}

interface Trade { date: string; dir: "long" | "short"; entry: number; exit: number; rMult: number; pnlPts: number; reason: string; }

function runNR4(bars: Bar[], symbol: string): Trade[] {
  const trades: Trade[] = [];
  for (let i = 21; i < bars.length - 1; i++) {
    const nr4 = bars[i];
    const atr = dailyATR(bars, i - 1, 20);
    if (atr <= 0) continue;
    const nr4Range = nr4.h - nr4.l;
    if (nr4Range >= atr * 0.5) continue;

    const next = bars[i + 1];
    const stopDist = nr4Range * 1.0;
    const targetDist = nr4Range * 3.0;

    // Long: break of nr4.h next day
    if (next.h >= nr4.h) {
      const entry = nr4.h;
      const stop = entry - stopDist;
      const target = entry + targetDist;
      // Check whether stop or target hit first using next-day H/L
      let exit = next.c;
      let rMult = 0;
      let reason = "EOD";
      if (next.l <= stop && next.h >= target) {
        // Both hit same day — assume stop first (conservative)
        exit = stop; rMult = -1; reason = "stop-then-target";
      } else if (next.l <= stop) {
        exit = stop; rMult = -1; reason = "stop";
      } else if (next.h >= target) {
        exit = target; rMult = 3; reason = "target";
      } else {
        // Time exit at close
        rMult = (next.c - entry) / stopDist;
        reason = "EOD";
      }
      trades.push({ date: next.date, dir: "long", entry, exit, rMult, pnlPts: exit - entry, reason });
    }
    // Short: break of nr4.l next day
    if (next.l <= nr4.l) {
      const entry = nr4.l;
      const stop = entry + stopDist;
      const target = entry - targetDist;
      let exit = next.c;
      let rMult = 0;
      let reason = "EOD";
      if (next.h >= stop && next.l <= target) {
        exit = stop; rMult = -1; reason = "stop-then-target";
      } else if (next.h >= stop) {
        exit = stop; rMult = -1; reason = "stop";
      } else if (next.l <= target) {
        exit = target; rMult = 3; reason = "target";
      } else {
        rMult = (entry - next.c) / stopDist;
        reason = "EOD";
      }
      trades.push({ date: next.date, dir: "short", entry, exit, rMult, pnlPts: entry - exit, reason });
    }
  }
  return trades;
}

function runMomentum3D(bars: Bar[]): Trade[] {
  // Long if last 3 days all higher closes; short if last 3 days all lower closes.
  // Enter at next open, exit at next close. ATR-based stop.
  const trades: Trade[] = [];
  for (let i = 21; i < bars.length - 1; i++) {
    const atr = dailyATR(bars, i, 20);
    if (atr <= 0) continue;
    const last3Up = bars[i].c > bars[i - 1].c && bars[i - 1].c > bars[i - 2].c;
    const last3Down = bars[i].c < bars[i - 1].c && bars[i - 1].c < bars[i - 2].c;
    if (!last3Up && !last3Down) continue;

    const next = bars[i + 1];
    const dir = last3Up ? "long" : "short";
    const entry = next.o;
    const stopDist = atr * 1.5;
    const targetDist = atr * 3.0;
    const stop = dir === "long" ? entry - stopDist : entry + stopDist;
    const target = dir === "long" ? entry + targetDist : entry - targetDist;

    let exit = next.c;
    let rMult = 0;
    let reason = "EOD";
    if (dir === "long") {
      if (next.l <= stop) { exit = stop; rMult = -1; reason = "stop"; }
      else if (next.h >= target) { exit = target; rMult = 3; reason = "target"; }
      else { rMult = (next.c - entry) / stopDist; reason = "EOD"; }
    } else {
      if (next.h >= stop) { exit = stop; rMult = -1; reason = "stop"; }
      else if (next.l <= target) { exit = target; rMult = 3; reason = "target"; }
      else { rMult = (entry - next.c) / stopDist; reason = "EOD"; }
    }
    trades.push({ date: next.date, dir, entry, exit, rMult, pnlPts: dir === "long" ? exit - entry : entry - exit, reason });
  }
  return trades;
}

function runMeanRev3D(bars: Bar[]): Trade[] {
  // After 3 consecutive DOWN days → enter LONG at next open
  // (also short version after 3 UP days)
  const trades: Trade[] = [];
  for (let i = 21; i < bars.length - 1; i++) {
    const atr = dailyATR(bars, i, 20);
    if (atr <= 0) continue;
    const down3 = bars[i].c < bars[i].o && bars[i - 1].c < bars[i - 1].o && bars[i - 2].c < bars[i - 2].o;
    const up3 = bars[i].c > bars[i].o && bars[i - 1].c > bars[i - 1].o && bars[i - 2].c > bars[i - 2].o;
    if (!down3 && !up3) continue;

    const next = bars[i + 1];
    const dir = down3 ? "long" : "short";
    const entry = next.o;
    const stopDist = atr * 1.5;
    const targetDist = atr * 2.5;
    const stop = dir === "long" ? entry - stopDist : entry + stopDist;
    const target = dir === "long" ? entry + targetDist : entry - targetDist;

    let exit = next.c;
    let rMult = 0;
    let reason = "EOD";
    if (dir === "long") {
      if (next.l <= stop) { exit = stop; rMult = -1; reason = "stop"; }
      else if (next.h >= target) { exit = target; rMult = 2.5; reason = "target"; }
      else { rMult = (next.c - entry) / stopDist; reason = "EOD"; }
    } else {
      if (next.h >= stop) { exit = stop; rMult = -1; reason = "stop"; }
      else if (next.l <= target) { exit = target; rMult = 2.5; reason = "target"; }
      else { rMult = (entry - next.c) / stopDist; reason = "EOD"; }
    }
    trades.push({ date: next.date, dir, entry, exit, rMult, pnlPts: dir === "long" ? exit - entry : entry - exit, reason });
  }
  return trades;
}

function summarize(name: string, trades: Trade[], costR = 0.1) {
  if (trades.length === 0) { console.log(`  ${name.padEnd(20)} no trades`); return null; }
  const adjusted = trades.map((t) => t.rMult - costR);
  const wins = adjusted.filter((r) => r > 0).length;
  const losses = adjusted.filter((r) => r < 0).length;
  const grossProfit = adjusted.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(adjusted.filter((r) => r < 0).reduce((s, r) => s + r, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const netR = adjusted.reduce((s, r) => s + r, 0);
  const wr = wins / trades.length;
  const avgR = netR / trades.length;
  console.log(`  ${name.padEnd(20)} n=${String(trades.length).padStart(3)} WR=${(100 * wr).toFixed(0)}% PF=${pf.toFixed(2)} netR=${netR.toFixed(1)} avgR=${avgR.toFixed(2)} W:${wins} L:${losses}`);
  return { name, n: trades.length, wr, pf, netR, avgR };
}

function yearlyBreakdown(name: string, trades: Trade[], costR = 0.1) {
  const byYear: Record<string, number[]> = {};
  for (const t of trades) {
    const yr = t.date.slice(0, 4);
    if (!byYear[yr]) byYear[yr] = [];
    byYear[yr].push(t.rMult - costR);
  }
  const lines: string[] = [];
  for (const yr of Object.keys(byYear).sort()) {
    const arr = byYear[yr];
    const net = arr.reduce((s, r) => s + r, 0);
    const wr = arr.filter((r) => r > 0).length / arr.length;
    lines.push(`    ${yr}: n=${arr.length} netR=${net.toFixed(1)} WR=${(100 * wr).toFixed(0)}%`);
  }
  if (lines.length > 1) {
    console.log(`  ${name} by year:`);
    lines.forEach((l) => console.log(l));
  }
}

function main() {
  const symbols = [
    { sym: "MSL", path: "/Users/user/trading/data/daily/MSL_1d.csv", desc: "Micro SOL (25 SOL/contract)" },
    { sym: "XRP", path: "/Users/user/trading/data/daily/XRP_1d.csv", desc: "XRP full (50,000 XRP/contract)" },
  ];

  for (const { sym, path, desc } of symbols) {
    if (!fs.existsSync(path)) { console.log(`${sym}: no data file`); continue; }
    const bars = loadCsv(path);
    console.log(`\n=== ${sym} — ${desc} ===`);
    console.log(`Bars: ${bars.length} | ${bars[0]?.date} → ${bars[bars.length - 1]?.date}`);
    console.log(`Costs assumed: 0.1R per round-trip (slippage + commission)\n`);

    const nr4 = runNR4(bars, sym);
    const mom = runMomentum3D(bars);
    const mr = runMeanRev3D(bars);

    console.log(`  STRATEGY              STATS`);
    summarize("NR4 range expansion", nr4);
    summarize("3-day momentum", mom);
    summarize("3-day mean reversion", mr);

    if (nr4.length >= 10) yearlyBreakdown("NR4", nr4);
    if (mom.length >= 10) yearlyBreakdown("Momentum 3D", mom);
    if (mr.length >= 10) yearlyBreakdown("MeanRev 3D", mr);
  }
}

main();
