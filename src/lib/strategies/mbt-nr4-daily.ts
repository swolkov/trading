/**
 * mbt-nr4-daily — Bitcoin micro (MBT) NR4 range-expansion edge.
 *
 * EDGE (from 4-yr Databento backtest, 2022-05 to 2026-05, scripts/edge-scan-crypto-deep.ts):
 *   136 trades, PF 2.03, +$4,177 net per contract, 54% win rate.
 *   Positive in 4 of 5 years (2022 +$108, 2024 +$2,106, 2025 +$1,003, 2026 +$1,026).
 *   2023 flat at -$65. Edge is BTC-specific: MET PF 0.18, BFF PF 0.69 (both failed).
 *
 * THEORY (pre-registered before backtest): volatility clusters. A narrow-range day
 * (range < 0.5x ATR-20) is volatility compression; the next day's break of that
 * day's H/L is the directional expansion. Per Linda Raschke's NR4/NR7 work.
 *
 * SIGNAL:
 *   - Aggregate to daily bars (CME session, ET-aligned).
 *   - At end-of-day: if today's range < 0.5x 20-day ATR -> arm an NR4 candle.
 *   - Next day: enter on first break of NR4 candle's high (long) or low (short).
 *   - Stop: 1x NR4 candle's range from entry.
 *   - Target: 3x NR4 candle's range from entry.
 *
 * CAVEATS:
 *   - Strategy is daily-bar; only fires once per day per direction.
 *   - Requires forward shadow execution before any live capital (Tier 2).
 *   - Needs >=$5K account margin to trade MBT safely (~$1.5-2.5k day margin per contract).
 */

import type { OHLCBar, Strategy, StrategySignal } from "./types";

const NR4_RANGE_RATIO = 0.5;
const ATR_LOOKBACK = 20;
const STOP_R_MULT = 1.0;
const TARGET_R_MULT = 3.0;

function dailyATR(daily: OHLCBar[], period = ATR_LOOKBACK): number {
  if (daily.length < period + 1) return 0;
  let sum = 0;
  for (let i = daily.length - period; i < daily.length; i++) {
    const tr = i === 0
      ? daily[i].h - daily[i].l
      : Math.max(
          daily[i].h - daily[i].l,
          Math.abs(daily[i].h - daily[i - 1].c),
          Math.abs(daily[i].l - daily[i - 1].c),
        );
    sum += tr;
  }
  return sum / period;
}

export const mbtNr4Daily: Strategy = {
  id: "mbt-nr4-daily",
  name: "MBT NR4 Range Expansion (daily)",
  applicableSymbols: ["MBT"],
  timeframe: "1d",
  tier: 2,
  description:
    "Narrow-range day on daily Bitcoin chart -> directional breakout next day. 4-yr backtest PF 2.03.",
  backtest: {
    pf: 2.03,
    trades: 136,
    netPerContract: 4177,
    winRate: 0.54,
    period: "2022-05 → 2026-05",
    yearsPositive: "4 of 5",
  },
  vaultDoc: "Strategies/mbt-nr4-range-expansion.md",
  codePath: "src/lib/strategies/mbt-nr4-daily.ts",

  /**
   * Caller is responsible for passing DAILY-aggregated bars (timeframe === "1d" is declared above
   * so the engine's strategy dispatcher knows to aggregate before invoking).
   * Last bar = today (in-progress); second-to-last = yesterday's completed candle (the NR4 anchor).
   */
  detect(bars, _context): StrategySignal | null {
    const daily = bars;
    if (daily.length < ATR_LOOKBACK + 2) return null;

    // The NR4 candle is yesterday (the last COMPLETED daily bar).
    const nr4 = daily[daily.length - 2];
    const today = daily[daily.length - 1];
    const atr = dailyATR(daily.slice(0, -1), ATR_LOOKBACK);
    if (atr <= 0) return null;

    const nr4Range = nr4.h - nr4.l;
    if (nr4Range >= atr * NR4_RANGE_RATIO) return null; // not narrow enough

    // Entry: break of NR4's H/L
    const price = bars[bars.length - 1].c;
    let direction: "long" | "short" | null = null;
    let entry = 0;
    if (today.h > nr4.h && price >= nr4.h) {
      direction = "long";
      entry = nr4.h;
    } else if (today.l < nr4.l && price <= nr4.l) {
      direction = "short";
      entry = nr4.l;
    }
    if (!direction) return null;

    const stopDist = nr4Range * STOP_R_MULT;
    const targetDist = nr4Range * TARGET_R_MULT;
    const stop = direction === "long" ? entry - stopDist : entry + stopDist;
    const target = direction === "long" ? entry + targetDist : entry - targetDist;

    return {
      direction,
      entryPrice: entry,
      stopPrice: stop,
      targetPrice: target,
      setupName: "NR4 range expansion",
      strategyId: "mbt-nr4-daily",
      reason:
        `Prior day was NR4 (range ${nr4Range.toFixed(0)} < 0.5x ATR ${atr.toFixed(0)}); ` +
        `${direction === "long" ? "broke above" : "broke below"} prior day ${direction === "long" ? "high" : "low"} at ${entry.toFixed(0)}. ` +
        `Stop ${stop.toFixed(0)} (1x range), target ${target.toFixed(0)} (3x range).`,
      confidence: 75,
    };
  },
};
