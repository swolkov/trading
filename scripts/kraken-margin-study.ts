// Kraken margin study — what leverage actually does to the live strategy.
//
// Answers: "should we margin trade BTC/ETH/SOL at 10x (20x BTC), and would we be profitable?"
//
// Models Kraken's REAL spot-margin mechanics, not an approximation:
//   - initial margin = notional / leverage; used margin fixed at open
//   - margin call at margin level 80%, forced liquidation at 40% (from AssetPairs: margin_call/margin_stop)
//   - opening fee + rollover fee EVERY 4 HOURS charged on notional (this is the part that kills it)
//   - liquidation checked against the intraday LOW, not the close — a wick liquidates you
//
// Strategy under test = the one actually running live (kraken-agent.ts): long-only 50-day SMA
// trend follower, evaluated hourly, no look-ahead (uses PRIOR completed day's SMA).
//
// Data: data/crypto/{BTC,ETH,SOL}.csv, hourly OHLCV.
//
// Run: npx tsx scripts/kraken-margin-study.ts

import fs from "fs";
import path from "path";

type Bar = { t: number; o: number; h: number; l: number; c: number };

const DATA = path.join(process.cwd(), "data", "crypto");

// Kraken published margin fee ranges (fee schedule, verified Aug 2026).
// Rollover is charged per 4 hours on notional — annualise it and it dwarfs everything else.
const MARGIN_FEES: Record<string, { lo: number; hi: number }> = {
  BTC: { lo: 0.0001, hi: 0.0002 }, // 0.01% - 0.02%
  ETH: { lo: 0.0002, hi: 0.0004 }, // 0.02% - 0.04%
  SOL: { lo: 0.0002, hi: 0.0004 }, // 0.02% - 0.04%
};

const TAKER = 0.004; // 0.40%/side Kraken Pro entry tier — same figure used in prior crypto studies
const MARGIN_STOP = 40; // liquidate at margin level 40%
const MARGIN_CALL = 80;
const START_EQUITY = 3000; // Spencer's actual Kraken balance

// Kraken US retail margin (CFTC-regulated, launched Apr 2026): BTC 20x, most majors 10x.
const US_MAX_LEV: Record<string, number> = { BTC: 20, ETH: 10, SOL: 10 };

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

// Daily 50-SMA from hourly bars, mapped to each hour using the PRIOR completed day only.
function sma50ByHour(bars: Bar[]): (number | null)[] {
  const dayKey = (t: number) => Math.floor(t / 86400000);
  const dailyClose = new Map<number, number>();
  for (const b of bars) dailyClose.set(dayKey(b.t), b.c); // last close of each day wins
  const days = [...dailyClose.keys()].sort((a, b) => a - b);
  const smaOfDay = new Map<number, number>();
  for (let i = 49; i < days.length; i++) {
    let s = 0;
    for (let j = i - 49; j <= i; j++) s += dailyClose.get(days[j])!;
    smaOfDay.set(days[i], s / 50);
  }
  return bars.map((b) => {
    const prevDay = dayKey(b.t) - 1; // no look-ahead: yesterday's completed SMA
    return smaOfDay.has(prevDay) ? smaOfDay.get(prevDay)! : null;
  });
}

type Result = {
  leverage: number;
  finalEquity: number;
  maxDD: number;
  liquidations: number;
  marginCalls: number;
  financingPaid: number;
  tradingFeesPaid: number;
  hoursHeld: number;
  ruined: boolean;
};

// dailyOnly: change position only at day boundaries (clean test of leverage — an hourly close
// evaluated against a daily SMA whipsaws ~120 round trips and buries the result in taker fees).
// Liquidation is ALWAYS checked on every hourly low regardless of decision cadence.
function simulate(
  bars: Bar[],
  sma: (number | null)[],
  lev: number,
  feeRate: number,
  useMargin: boolean,
  dailyOnly = false
): Result {
  let equity = START_EQUITY;
  let peak = equity;
  let maxDD = 0;
  let liquidations = 0;
  let marginCalls = 0;
  let financingPaid = 0;
  let tradingFeesPaid = 0;
  let hoursHeld = 0;

  // open position state
  let inPos = false;
  let units = 0;
  let entryPx = 0;
  let notional = 0;
  let usedMargin = 0;
  let equityAtOpen = 0;
  let accruedMargin = 0;
  let hoursInPos = 0;
  let calledThisPos = false;

  const markEquity = (px: number) =>
    equityAtOpen - accruedMargin + units * (px - entryPx);

  const dayOf = (t: number) => Math.floor(t / 86400000);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const ma = sma[i];
    if (ma === null) continue;
    if (equity <= 0) break;
    // A decision bar is the last hourly bar of a UTC day when running daily cadence.
    const canDecide = !dailyOnly || i === bars.length - 1 || dayOf(bars[i + 1].t) !== dayOf(b.t);

    if (inPos) {
      hoursHeld++;
      hoursInPos++;

      // Rollover fee every 4 hours on notional (Kraken charges on opening cost).
      if (useMargin && hoursInPos % 4 === 0) {
        const f = feeRate * notional;
        accruedMargin += f;
        financingPaid += f;
      }

      // Liquidation check on the intraday LOW — this is what a close-only sim misses.
      const eqLow = markEquity(b.l);
      const levelLow = (eqLow / usedMargin) * 100;
      if (useMargin && levelLow <= MARGIN_CALL && !calledThisPos) {
        marginCalls++;
        calledThisPos = true;
      }
      if (useMargin && levelLow <= MARGIN_STOP) {
        // Forced close. You retain roughly the stop-level equity, less a closing fee.
        const residual = Math.max(0, (MARGIN_STOP / 100) * usedMargin);
        const closeFee = TAKER * units * b.l;
        tradingFeesPaid += closeFee;
        equity = Math.max(0, residual - closeFee);
        liquidations++;
        inPos = false;
        units = 0;
        accruedMargin = 0;
        calledThisPos = false;
        if (equity > peak) peak = equity;
        maxDD = Math.max(maxDD, (peak - equity) / peak);
        continue;
      }

      // Signal exit
      if (canDecide && b.c < ma) {
        const eq = markEquity(b.c);
        const closeFee = TAKER * units * b.c;
        tradingFeesPaid += closeFee;
        equity = Math.max(0, eq - closeFee);
        inPos = false;
        units = 0;
        accruedMargin = 0;
        calledThisPos = false;
      } else {
        const eq = markEquity(b.c);
        if (eq > peak) peak = eq;
        maxDD = Math.max(maxDD, (peak - eq) / peak);
      }
    } else {
      // Entry
      if (canDecide && b.c > ma && equity > 0) {
        notional = equity * lev;
        units = notional / b.c;
        entryPx = b.c;
        usedMargin = notional / lev; // == equity
        const entryFee = TAKER * notional;
        const openFee = useMargin ? feeRate * notional : 0;
        tradingFeesPaid += entryFee;
        financingPaid += openFee;
        accruedMargin = openFee;
        equityAtOpen = equity - entryFee;
        inPos = true;
        hoursInPos = 0;
        calledThisPos = false;
      }
      if (equity > peak) peak = equity;
      maxDD = Math.max(maxDD, (peak - equity) / peak);
    }
  }

  if (inPos) {
    const last = bars[bars.length - 1];
    equity = Math.max(0, markEquity(last.c) - TAKER * units * last.c);
  }

  return {
    leverage: lev,
    finalEquity: equity,
    maxDD,
    liquidations,
    marginCalls,
    financingPaid,
    tradingFeesPaid,
    hoursHeld,
    ruined: equity < START_EQUITY * 0.05,
  };
}

// Buy-and-hold at leverage, for the benchmark memory says beats everything.
function buyHold(bars: Bar[], lev: number, feeRate: number): Result {
  const sma = bars.map(() => 0); // always long
  return simulate(bars, sma, lev, feeRate, lev > 1);
}

function pct(x: number) {
  return (x * 100).toFixed(1) + "%";
}
function usd(x: number) {
  return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function main() {
  const symbols = ["BTC", "ETH", "SOL"];
  const levels = [1, 2, 3, 5, 10, 20];

  for (const sym of symbols) {
    const bars = loadBars(sym);
    const sma = sma50ByHour(bars);
    const start = new Date(bars[0].t).toISOString().slice(0, 10);
    const end = new Date(bars[bars.length - 1].t).toISOString().slice(0, 10);
    const years = (bars[bars.length - 1].t - bars[0].t) / (365.25 * 86400000);

    console.log(`\n${"=".repeat(96)}`);
    console.log(`${sym}  ${start} → ${end}  (${years.toFixed(2)} yrs, ${bars.length} hourly bars)`);
    console.log(`spot ${bars[0].c.toFixed(2)} → ${bars[bars.length - 1].c.toFixed(2)}  (buy & hold unlevered ${pct(bars[bars.length - 1].c / bars[0].c - 1)})`);
    console.log("=".repeat(96));

    for (const feeLabel of ["lo", "hi"] as const) {
      const feeRate = MARGIN_FEES[sym][feeLabel];
      const annualCarry = feeRate * 6 * 365; // 6 rollovers/day
      console.log(
        `\n  margin fee ${feeLabel === "lo" ? "BEST case" : "WORST case"}: ${(feeRate * 100).toFixed(2)}%/4h  ` +
          `= ${(feeRate * 6 * 100).toFixed(2)}%/day of notional = ${(annualCarry * 100).toFixed(0)}%/yr of notional`
      );
      console.log(
        "  lev |   final equity |  return | maxDD  | liq | calls | financing paid | % of start | days held"
      );
      console.log("  " + "-".repeat(92));

      for (const lev of levels) {
        const r = simulate(bars, sma, lev, feeRate, lev > 1, true);
        const ret = r.finalEquity / START_EQUITY - 1;
        const overMax = lev > US_MAX_LEV[sym];
        const flag = (r.ruined ? "  << WIPED OUT" : "") + (overMax ? "  (above US max)" : "");
        console.log(
          `  ${String(lev).padStart(3)}x | ${usd(r.finalEquity).padStart(14)} | ${pct(ret).padStart(7)} | ` +
            `${pct(r.maxDD).padStart(6)} | ${String(r.liquidations).padStart(3)} | ${String(r.marginCalls).padStart(5)} | ` +
            `${usd(r.financingPaid).padStart(14)} | ${pct(r.financingPaid / START_EQUITY).padStart(10)} | ${(r.hoursHeld / 24).toFixed(0).padStart(9)}${flag}`
        );
      }
    }

    // Benchmark: unlevered buy & hold (no strategy, no margin)
    const bh = buyHold(bars, 1, 0);
    console.log(`\n  BENCHMARK unlevered buy & hold: ${usd(bh.finalEquity)} (${pct(bh.finalEquity / START_EQUITY - 1)}), maxDD ${pct(bh.maxDD)}`);

    // How big an adverse move kills each leverage, and how often that move happens.
    console.log("\n  LIQUIDATION DISTANCE — how far price must fall from your entry to wipe the position:");
    for (const lev of levels) {
      // equity(P)/usedMargin = 40%  =>  loss = 0.6 * usedMargin = 0.6 * notional/lev
      // loss = units * dP = (notional/entry) * dP  =>  dP/entry = 0.6/lev
      const dist = 0.6 / lev;
      // How often does a drawdown that deep occur from a rolling entry, within 30 days?
      let hits = 0;
      let windows = 0;
      for (let i = 0; i < bars.length - 720; i += 24) {
        windows++;
        const e = bars[i].c;
        let worst = 0;
        for (let j = i; j < i + 720; j++) worst = Math.min(worst, bars[j].l / e - 1);
        if (worst <= -dist) hits++;
      }
      console.log(
        `    ${String(lev).padStart(3)}x → a ${pct(dist)} drop liquidates you. ` +
          `Happened within 30 days of ${pct(hits / windows)} of entry points.`
      );
    }
  }

  console.log(`\n${"=".repeat(96)}`);
  console.log("Carry check on a $3,000 account (the number that decides this):");
  for (const sym of symbols) {
    for (const lev of [10, 20]) {
      const f = MARGIN_FEES[sym];
      const notional = START_EQUITY * lev;
      const lo = f.lo * 6 * notional;
      const hi = f.hi * 6 * notional;
      console.log(
        `  ${sym} @ ${lev}x: ${usd(notional)} notional → financing ${usd(lo)}–${usd(hi)}/DAY ` +
          `= ${pct((lo / START_EQUITY) * 365)}–${pct((hi / START_EQUITY) * 365)} of your account per YEAR`
      );
    }
  }
  console.log("=".repeat(96));
}

main();
