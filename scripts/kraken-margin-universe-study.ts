// MARGIN UNIVERSE STUDY — is there ANY tradeable signal across horizons and directions?
//
// Scopes Spencer's question: "look at all the margins we could trade, build research and skill to
// get in and out in a day or a week or maybe longer, long or short."
//
// KEY INSIGHT THAT SHAPES THE DESIGN: margin financing is charged per-4h on NOTIONAL, so the cost
// per unit of notional is INDEPENDENT of leverage. That means "is there a signal?" and "how much
// leverage?" are separable questions. This script answers the first in notional terms; leverage
// then falls out as a Kelly sizing decision on whatever survives. Cost per trade:
//     net = direction * move  -  2 * taker  -  rolloverRate * 6 * days
//
// DESIGN
//   Universe : 7 Kraken margin pairs at the 10x tier (BTC ETH SOL AVAX DOGE LINK XRP), hourly.
//   Horizons : 4h, 1 day, 1 week, 1 month  ("in and out in a day or a week or maybe longer")
//   Direction: long and short tested SEPARATELY (shorting is enabled on ~all margin pairs)
//   Signals  : momentum, trend, mean-reversion, breakout, RSI + a RANDOM control
//   Entries  : NON-OVERLAPPING (step = horizon). Overlapping windows inflate t-stats badly.
//   Split    : IS 2024-01->2025-05, OOS 2025-06->2026-06. A cell only counts if it survives BOTH.
//   Pooled across coins is the PRIMARY test — per-coin cells overfit on 2.5 years.
//
// Run: npx tsx scripts/kraken-margin-universe-study.ts

import fs from "fs";
import path from "path";

type Bar = { t: number; o: number; h: number; l: number; c: number };

const DATA = path.join(process.cwd(), "data", "crypto");
const COINS = ["BTC", "ETH", "SOL", "AVAX", "DOGE", "LINK", "XRP"];
// Kraken rollover per 4h on notional: BTC cheapest tier, alts one step up.
const ROLL: Record<string, number> = { BTC: 0.0001, ETH: 0.0002, SOL: 0.0002, AVAX: 0.0002, DOGE: 0.0002, LINK: 0.0002, XRP: 0.0002 };
const SPLIT = new Date("2025-06-01T00:00:00Z").getTime();

const HORIZONS: [string, number][] = [["4h", 4], ["1d", 24], ["1w", 168], ["1mo", 720]];
const SIGNALS = ["momentum", "trend", "revert", "breakout", "rsi", "RANDOM"];

const TAKER_BASE = 0.004; // his current tier, 0.40%/side
const TAKER_TIER = 0.002; // what leveraged volume would earn him, 0.20%/side

function loadBars(sym: string): Bar[] {
  const raw = fs.readFileSync(path.join(DATA, `${sym}.csv`), "utf8").trim().split("\n");
  const out: Bar[] = [];
  for (let i = 1; i < raw.length; i++) {
    const p = raw[i].split(",");
    const b = { t: +p[0], o: +p[1], h: +p[2], l: +p[3], c: +p[4] };
    if (Number.isFinite(b.c) && b.c > 0) out.push(b);
  }
  return out.sort((a, b) => a.t - b.t);
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function rsi(bars: Bar[], i: number, L: number): number {
  let g = 0, l = 0;
  for (let j = i - L + 1; j <= i; j++) {
    const d = bars[j].c - bars[j - 1].c;
    if (d > 0) g += d; else l -= d;
  }
  if (g + l === 0) return 50;
  return (100 * g) / (g + l);
}

// Returns +1 (long), -1 (short) or 0 (no trade) for a signal at bar i with lookback L.
function signalAt(name: string, bars: Bar[], i: number, L: number, rnd: () => number): number {
  if (i - L - 1 < 0) return 0;
  const c = bars[i].c;
  if (name === "RANDOM") {
    const u = rnd();
    return u < 0.333 ? 1 : u < 0.666 ? -1 : 0;
  }
  if (name === "momentum") {
    const r = c / bars[i - L].c - 1;
    return r > 0 ? 1 : r < 0 ? -1 : 0;
  }
  let sum = 0;
  for (let j = i - L + 1; j <= i; j++) sum += bars[j].c;
  const sma = sum / L;
  if (name === "trend") return c > sma ? 1 : c < sma ? -1 : 0;
  if (name === "revert") {
    let v = 0;
    for (let j = i - L + 1; j <= i; j++) v += (bars[j].c - sma) ** 2;
    const sd = Math.sqrt(v / L);
    if (sd === 0) return 0;
    const z = (c - sma) / sd;
    return z < -1 ? 1 : z > 1 ? -1 : 0; // fade the extreme
  }
  if (name === "breakout") {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - L; j < i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
    return c >= hi ? 1 : c <= lo ? -1 : 0;
  }
  if (name === "rsi") {
    const r = rsi(bars, i, L);
    return r < 30 ? 1 : r > 70 ? -1 : 0;
  }
  return 0;
}

type Stat = { n: number; mean: number; t: number; sd: number };
function stat(a: number[]): Stat {
  if (a.length < 12) return { n: a.length, mean: 0, t: 0, sd: 0 };
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  return { n: a.length, mean: m, t: sd === 0 ? 0 : m / (sd / Math.sqrt(a.length)), sd };
}

function main() {
  const data: Record<string, Bar[]> = {};
  for (const c of COINS) data[c] = loadBars(c);

  console.log("=".repeat(112));
  console.log("MARGIN UNIVERSE STUDY — 7 coins (all Kraken 10x-tier), 4 horizons, long AND short, IS/OOS split");
  console.log("=".repeat(112));
  console.log("Net edge is PER UNIT OF NOTIONAL, so it is leverage-independent. Costs = 2x taker + rollover*6*days.");
  console.log("A cell SURVIVES only if net t > 2 in BOTH halves. RANDOM is the control — treat its best cell as the noise floor.\n");

  type Cell = { sig: string; hz: string; dir: string; is: Stat; oos: Stat; oosTier: Stat; days: number };
  const cells: Cell[] = [];

  for (const [hzName, H] of HORIZONS) {
    const days = H / 24;
    for (const sig of SIGNALS) {
      for (const dir of [1, -1]) {
        const isR: number[] = [], oosR: number[] = [], oosT: number[] = [];
        for (const coin of COINS) {
          const bars = data[coin];
          const rnd = lcg(1234 + coin.length * 31 + H);
          const cost = ROLL[coin] * 6 * days;
          for (let i = H; i + H < bars.length; i += H) {
            const s = signalAt(sig, bars, i, H, rnd);
            if (s !== dir) continue;
            const entry = bars[i + 1].o || bars[i].c;
            const exit = bars[i + H].c;
            const gross = dir * (exit / entry - 1);
            const net = gross - 2 * TAKER_BASE - cost;
            const netT = gross - 2 * TAKER_TIER - cost;
            if (bars[i].t < SPLIT) isR.push(net);
            else { oosR.push(net); oosT.push(netT); }
          }
        }
        cells.push({ sig, hz: hzName, dir: dir > 0 ? "LONG" : "SHORT", is: stat(isR), oos: stat(oosR), oosTier: stat(oosT), days });
      }
    }
  }

  // ---- report
  console.log("  signal     hz    dir   |  IS: n / net%/trade / t   |  OOS: n / net%/trade / t  | OOS@0.20% fee t");
  console.log("  " + "-".repeat(108));
  for (const c of cells) {
    const f = (s: Stat) => `${String(s.n).padStart(5)} ${(s.mean * 100).toFixed(2).padStart(7)}% ${s.t.toFixed(2).padStart(6)}`;
    const survives = c.is.t > 2 && c.oos.t > 2;
    const mark = survives ? "  <== SURVIVES BOTH" : "";
    const dim = c.sig === "RANDOM" ? "  (control)" : "";
    console.log(`  ${c.sig.padEnd(10)} ${c.hz.padEnd(5)} ${c.dir.padEnd(5)} | ${f(c.is)} | ${f(c.oos)} | ${c.oosTier.t.toFixed(2).padStart(6)}${mark}${dim}`);
  }

  const real = cells.filter((c) => c.sig !== "RANDOM");
  const ctrl = cells.filter((c) => c.sig === "RANDOM");
  const survivors = real.filter((c) => c.is.t > 2 && c.oos.t > 2);
  const oosOnly = real.filter((c) => c.oos.t > 2);
  const isOnly = real.filter((c) => c.is.t > 2);

  console.log("\n" + "=".repeat(112));
  console.log("VERDICT");
  console.log("=".repeat(112));
  console.log(`  Real cells tested          : ${real.length}  (${SIGNALS.length - 1} signals x ${HORIZONS.length} horizons x 2 directions)`);
  console.log(`  Expected false positives   : ${(real.length * 0.05).toFixed(1)} at p<0.05 by pure chance`);
  console.log(`  Positive in-sample (t>2)   : ${isOnly.length}`);
  console.log(`  Positive out-of-sample     : ${oosOnly.length}`);
  console.log(`  SURVIVED BOTH HALVES       : ${survivors.length}`);
  console.log(`  Best RANDOM control cell   : OOS t = ${Math.max(...ctrl.map((c) => c.oos.t)).toFixed(2)}  <- the noise floor`);

  if (survivors.length) {
    console.log("\n  Survivors, and what leverage they would justify:");
    for (const c of survivors) {
      const kelly = c.oos.sd > 0 ? c.oos.mean / c.oos.sd ** 2 : 0;
      console.log(
        `    ${c.sig} ${c.hz} ${c.dir}: OOS net ${(c.oos.mean * 100).toFixed(2)}%/trade over ${c.oos.n} trades, ` +
          `per-trade swing ${(c.oos.sd * 100).toFixed(1)}% -> Kelly ${kelly.toFixed(1)}x (half-Kelly ${(kelly / 2).toFixed(1)}x)`
      );
    }
  } else {
    console.log("\n  No signal survived both halves net of costs, in either direction, at any horizon.");
  }

  // Long vs short beta check — is there money in simply being short the alt complex?
  console.log("\n  DIRECTIONAL BASELINE (no signal, always in the market, net of costs):");
  for (const [hzName, H] of HORIZONS) {
    const days = H / 24;
    for (const dir of [1, -1]) {
      const arr: number[] = [];
      for (const coin of COINS) {
        const bars = data[coin];
        const cost = ROLL[coin] * 6 * days;
        for (let i = H; i + H < bars.length; i += H) {
          if (bars[i].t < SPLIT) continue;
          const entry = bars[i + 1].o || bars[i].c;
          arr.push(dir * (bars[i + H].c / entry - 1) - 2 * TAKER_BASE - cost);
        }
      }
      const s = stat(arr);
      console.log(`    ${hzName.padEnd(4)} ${(dir > 0 ? "LONG" : "SHORT").padEnd(5)} OOS: ${(s.mean * 100).toFixed(2).padStart(7)}%/trade  t=${s.t.toFixed(2).padStart(6)}  (n=${s.n})`);
    }
  }
}

main();
