// "Can we make HUNDREDS OF THOUSANDS with crypto margin trading?" — the honest distribution.
//
// The $1M question was settled by a Markov ceiling. $200-500k is a genuinely different ask, ~5x
// smaller, so it gets a real Monte Carlo rather than a bound.
//
// METHOD — deliberately GENEROUS to the leveraged case:
//   - Always long. No signal required, no forecast to get wrong. (Our 16 tested edge families are
//     dead, so assuming ANY skill would be dishonest; assuming permanent long exposure is the
//     most favourable assumption we can actually defend.)
//   - BLOCK BOOTSTRAP of real BTC hourly history in 5-day blocks, so fat tails, momentum and
//     volatility clustering are preserved rather than assumed away by a normal distribution.
//   - Cheapest Kraken financing tier (BTC, 0.01%/4h).
//   - Daily rebalance back to target leverage, which is the *best case* for compounding.
//   - Liquidation checked against each day's true intraday LOW, not its close.
//
// The number that matters is not the upside alone — it is P(hit target) set against P(ruin).
//
// Run: npx tsx scripts/kraken-hundreds-of-thousands.ts

import fs from "fs";
import path from "path";

const START = 7000;
const TARGETS = [100_000, 200_000, 500_000, 1_000_000];
const LEVELS = [1, 2, 3, 5, 10, 20];
const SIMS = 20000;
const HORIZONS: [string, number][] = [["1 year", 365], ["2 years", 730]];
const DAILY_FIN = 0.0006;   // 0.01%/4h x 6 = BTC's cheapest rate, on notional
const MARGIN_STOP = 0.4;    // Kraken liquidates at 40% margin level
const RUIN = 1000;          // below this the account is done in any practical sense

type Day = { ret: number; dip: number };

function loadDays(sym: string): Day[] {
  const raw = fs.readFileSync(path.join(process.cwd(), "data", "crypto", `${sym}.csv`), "utf8").trim().split("\n");
  const byDay = new Map<number, { o: number; c: number; lo: number }>();
  for (let i = 1; i < raw.length; i++) {
    const p = raw[i].split(",");
    const t = +p[0], o = +p[1], l = +p[3], c = +p[4];
    if (!Number.isFinite(c) || c <= 0) continue;
    const k = Math.floor(t / 86400000);
    const cur = byDay.get(k);
    if (!cur) byDay.set(k, { o, c, lo: l });
    else { cur.c = c; cur.lo = Math.min(cur.lo, l); }
  }
  return [...byDay.values()].map((d) => ({ ret: d.c / d.o - 1, dip: d.lo / d.o - 1 }));
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function simulate(days: Day[], lev: number, horizon: number, rnd: () => number): number {
  let eq = START;
  const BLOCK = 5;
  let d = 0;
  while (d < horizon) {
    // block bootstrap: take a contiguous run of real days, preserving clustering
    let idx = Math.floor(rnd() * (days.length - BLOCK));
    for (let b = 0; b < BLOCK && d < horizon; b++, d++, idx++) {
      if (eq < RUIN) return eq;
      const day = days[idx];
      const fin = lev * eq * DAILY_FIN;
      // intraday liquidation on the day's true low, before the close is known
      const eqAtLow = eq * (1 + lev * day.dip) - fin;
      if (lev > 1 && eqAtLow <= MARGIN_STOP * eq) { eq = MARGIN_STOP * eq; continue; }
      eq = eq * (1 + lev * day.ret) - fin;
      if (eq <= 0) return 0;
    }
  }
  return eq;
}

function main() {
  const days = loadDays("BTC");
  console.log("=".repeat(104));
  console.log(`CAN $${START.toLocaleString()} BECOME HUNDREDS OF THOUSANDS? — ${SIMS.toLocaleString()} simulated paths per cell`);
  console.log("=".repeat(104));
  console.log(`Real BTC daily paths (${days.length} days), 5-day block bootstrap, always long, cheapest financing,`);
  console.log("daily rebalance to target leverage, liquidation on each day's true intraday low.\n");

  for (const [hname, horizon] of HORIZONS) {
    console.log(`\n${"─".repeat(104)}`);
    console.log(`OVER ${hname.toUpperCase()}`);
    console.log("─".repeat(104));
    console.log("  lev |   median |  P($100k) |  P($200k) |  P($500k) |    P($1M) |  P(RUIN <$1k) | P(lose money)");
    console.log("  " + "-".repeat(100));
    for (const lev of LEVELS) {
      const outs: number[] = [];
      for (let s = 0; s < SIMS; s++) outs.push(simulate(days, lev, horizon, lcg(s * 2654435761 + lev * 97 + horizon)));
      outs.sort((a, b) => a - b);
      const median = outs[Math.floor(outs.length / 2)];
      const pAbove = (t: number) => (outs.filter((x) => x >= t).length / outs.length) * 100;
      const pRuin = (outs.filter((x) => x < RUIN).length / outs.length) * 100;
      const pLose = (outs.filter((x) => x < START).length / outs.length) * 100;
      console.log(
        `  ${String(lev).padStart(3)}x | ${("$" + Math.round(median).toLocaleString()).padStart(8)} | ` +
          TARGETS.map((t) => (pAbove(t).toFixed(2) + "%").padStart(9)).join(" | ") +
          ` | ${(pRuin.toFixed(1) + "%").padStart(13)} | ${(pLose.toFixed(1) + "%").padStart(12)}`
      );
    }
  }

  // The trade you are actually making: upside odds vs ruin odds.
  console.log(`\n${"=".repeat(104)}`);
  console.log("THE REAL TRADE — for every 1 path that reaches $200k in 2 years, how many are wiped out?");
  console.log("=".repeat(104));
  for (const lev of LEVELS) {
    const outs: number[] = [];
    for (let s = 0; s < SIMS; s++) outs.push(simulate(days, lev, 730, lcg(s * 2654435761 + lev * 97 + 730)));
    const win = outs.filter((x) => x >= 200_000).length;
    const ruin = outs.filter((x) => x < RUIN).length;
    const ratio = win === 0 ? "no winning paths at all" : `${(ruin / win).toFixed(0)} wiped out for every 1 that gets there`;
    console.log(`  ${String(lev).padStart(3)}x: ${String(win).padStart(5)} of ${SIMS} reach $200k, ${String(ruin).padStart(5)} are ruined  →  ${ratio}`);
  }
}

main();
