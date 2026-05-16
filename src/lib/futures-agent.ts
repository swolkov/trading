import Anthropic from "@anthropic-ai/sdk";
import {
  checkTradovateAuth,
  findContract,
  placeBracketOrder,
  placeMarketOrder,
  placeStopOrder,
  getTradovatePositions,
  getTradovateAccountSummary,
  getOpenOrders,
  cancelOrder,
  TRADOVATE_CONTRACTS,
  type TradovatePosition,
} from "./tradovate";
import { sendNotification } from "./notifications";
import { getFuturesIntradayBars, getFuturesDailyBars } from "./futures-data";
import { detectMarketRegime } from "./market-regime";
import { getCrossAssetSignals } from "./cross-asset";
import { prisma } from "./db";
import { getVaultContextForAI, logTradeToJournal, logDecision, logObservation, updateMarketRegime, updateVolatilityEnvironment } from "./vault";
import { evaluateDrawdownState } from "./drawdown-protocol";
import { getSessionInfo, getETDateString, getRTHStartUTC, type Session } from "./session-time";

// Market data now flows through futures-data.ts (Tradovate primary, Yahoo fallback)

// Alias for backward compatibility
const FUTURES_CONTRACTS = TRADOVATE_CONTRACTS;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

// ============ EXPERT FUTURES TRADING SYSTEM ============
// Multi-timeframe analysis, key levels, VWAP bands, session awareness,
// bracket orders (stop + target placed with entry), equity-based sizing.

// ============ RULES — $7K ACCOUNT, ES-EQUIVALENT VIA MICROS ============
// Trade 6-10 MES per trade to match ES-level P&L ($50/pt at 10 MES).
// Aggressive sizing with ironclad daily/drawdown limits.
// Scale-out advantage: 10 MES lets you sell 5 at 1R, trail 5 for runners.

// Default futures rules — can be overridden from Agent Hub config
const FUTURES_RULES_DEFAULTS = {
  RISK_PER_TRADE_PCT: 0.05,
  DAILY_LOSS_LIMIT_PCT: 0.10,
  MAX_DRAWDOWN_PCT: 0.15,
  MAX_CONTRACTS_PER_TRADE: 6,
  MAX_TOTAL_CONTRACTS: 10,
  MAX_TRADES_PER_DAY: 3,
  MAX_TRADES_APLUS_OVERRIDE: 5,
  ATR_STOP_MULTIPLIER: 1.5,
  ATR_TARGET_MULTIPLIER: 3.5,
  RTH_START_ET: 9.5,
  RTH_END_ET: 16,
  AVOID_FIRST_MINUTES: 15,
  AVOID_LAST_MINUTES: 15,
  SIMULATED_EQUITY: 7_000,
};

// Mutable rules — populated from DB config at runtime, falls back to defaults
let FUTURES_RULES = { ...FUTURES_RULES_DEFAULTS };

/** Load futures config overrides from Agent Hub DB settings */
async function loadFuturesConfig() {
  try {
    const keyMap: Record<string, keyof typeof FUTURES_RULES_DEFAULTS> = {
      futures_risk_per_trade_pct: "RISK_PER_TRADE_PCT",
      futures_daily_loss_limit_pct: "DAILY_LOSS_LIMIT_PCT",
      futures_max_drawdown_pct: "MAX_DRAWDOWN_PCT",
      futures_max_contracts: "MAX_CONTRACTS_PER_TRADE",
      futures_max_total_contracts: "MAX_TOTAL_CONTRACTS",
      futures_max_trades_per_day: "MAX_TRADES_PER_DAY",
      futures_atr_stop_multiplier: "ATR_STOP_MULTIPLIER",
      futures_atr_target_multiplier: "ATR_TARGET_MULTIPLIER",
      futures_simulated_equity: "SIMULATED_EQUITY",
    };
    const configs = await prisma.agentConfig.findMany({
      where: { key: { in: Object.keys(keyMap) } },
    });
    for (const c of configs) {
      const ruleKey = keyMap[c.key];
      if (ruleKey) {
        const val = parseFloat(c.value);
        if (!isNaN(val) && val > 0) {
          // Percentage fields are stored as whole numbers in UI (e.g. 5 = 5%)
          if (ruleKey.endsWith("_PCT")) {
            (FUTURES_RULES as Record<string, number>)[ruleKey] = val / 100;
          } else {
            (FUTURES_RULES as Record<string, number>)[ruleKey] = val;
          }
        }
      }
    }
  } catch { /* use defaults */ }
}

// ============ WHICH CONTRACTS TO TRADE ============
// DEMO MODE: Force micros to mirror $5K live conditions.
// When live and scaled to $25k+, switch to full-size.
const FULL_SIZE_EQUITY_THRESHOLD = 25_000;

const FULL_SIZE_PRIORITY: { symbol: string; when: string }[] = [
  { symbol: "ES", when: "always" },     // $50/pt — primary money maker
  { symbol: "NQ", when: "trending" },   // $20/pt — best in trends, volatile
  { symbol: "GC", when: "always" },     // $100/pt — uncorrelated to equities
];
const MICRO_PRIORITY: { symbol: string; when: string }[] = [
  { symbol: "MES", when: "always" },    // $5/pt — S&P micro
  { symbol: "MNQ", when: "trending" },  // $2/pt — Nasdaq micro
  { symbol: "MGC", when: "always" },    // $10/pt — Gold micro
];

function getTradePriority(equity: number): { symbol: string; when: string }[] {
  // Force micros when simulating small account (demo or live under threshold)
  const effectiveEquity = FUTURES_RULES.SIMULATED_EQUITY || equity;
  return effectiveEquity >= FULL_SIZE_EQUITY_THRESHOLD ? FULL_SIZE_PRIORITY : MICRO_PRIORITY;
}

// ============ TECHNICAL INDICATORS ============

function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map((c) => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(bars: { h: number; l: number; c: number }[], period: number = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function vwap(bars: { h: number; l: number; c: number; v: number }[]): { vwap: number; upperBand: number; lowerBand: number } {
  let cumPV = 0;
  let cumV = 0;
  let cumPV2 = 0;
  for (const bar of bars) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    cumPV += typical * bar.v;
    cumPV2 += typical * typical * bar.v;
    cumV += bar.v;
  }
  const vwapVal = cumV > 0 ? cumPV / cumV : 0;
  const variance = cumV > 0 ? (cumPV2 / cumV) - (vwapVal * vwapVal) : 0;
  const stdDev = Math.sqrt(Math.max(0, variance));
  return { vwap: vwapVal, upperBand: vwapVal + stdDev, lowerBand: vwapVal - stdDev };
}

// ============ KEY LEVELS ============

interface KeyLevels {
  prevDayHigh: number;
  prevDayLow: number;
  prevDayClose: number;
  overnightHigh: number;
  overnightLow: number;
  openingRangeHigh: number;  // first 15 min
  openingRangeLow: number;
}

function calcKeyLevels(dailyBars: { h: number; l: number; c: number }[], intradayBars: { h: number; l: number; c: number; t: number }[]): KeyLevels {
  const prevDay = dailyBars.length >= 2 ? dailyBars[dailyBars.length - 2] : null;
  const todayBars = intradayBars.slice(-78); // ~6.5 hrs of 5min bars

  // Opening range = first 3 bars (15 min of 5-min data)
  const openBars = todayBars.slice(0, 3);
  const orHigh = openBars.length > 0 ? Math.max(...openBars.map((b) => b.h)) : 0;
  const orLow = openBars.length > 0 ? Math.min(...openBars.map((b) => b.l)) : 0;

  // Overnight = bars from previous close to today's open
  const onHigh = intradayBars.length > 3 ? Math.max(...intradayBars.slice(-100, -78).map((b) => b.h)) : 0;
  const onLow = intradayBars.length > 3 ? Math.min(...intradayBars.slice(-100, -78).map((b) => b.l).filter((l) => l > 0)) : 0;

  return {
    prevDayHigh: prevDay?.h || 0,
    prevDayLow: prevDay?.l || 0,
    prevDayClose: prevDay?.c || 0,
    overnightHigh: onHigh || prevDay?.h || 0,
    overnightLow: onLow || prevDay?.l || 0,
    openingRangeHigh: orHigh,
    openingRangeLow: orLow,
  };
}

// ============ SESSION DETECTION (DST-aware via session-time.ts) ============
// Session type imported from session-time.ts

function getSession(): { session: Session; isRTH: boolean; isETH: boolean; minutesSinceOpen: number } {
  return getSessionInfo();
}

// ============ DAY TYPE CLASSIFIER ============
// The #1 determinant of profitability: is today a TREND day or a RANGE day?
// This drives which setups we look for.

type DayType = "trend" | "range" | "unknown";

function classifyDayType(
  dailyBars: { o: number; h: number; l: number; c: number; v: number }[],
  todayBars: { o: number; h: number; l: number; c: number; v: number }[],
  levels: KeyLevels,
): { dayType: DayType; confidence: number; reasoning: string } {
  let trendScore = 0;
  const reasons: string[] = [];

  // 1. Gap size — gap > 0.3% of prev close = trend day signal
  if (levels.prevDayClose > 0 && todayBars.length > 0) {
    const openPrice = todayBars[0].o;
    const gapPct = Math.abs(openPrice - levels.prevDayClose) / levels.prevDayClose * 100;
    if (gapPct > 0.5) { trendScore += 3; reasons.push(`large gap ${gapPct.toFixed(2)}%`); }
    else if (gapPct > 0.3) { trendScore += 2; reasons.push(`gap ${gapPct.toFixed(2)}%`); }
    else if (gapPct < 0.1) { trendScore -= 2; reasons.push(`tiny gap ${gapPct.toFixed(2)}%`); }
  }

  // 2. Opening range size vs average — wide OR = trend day
  if (levels.openingRangeHigh > 0 && levels.openingRangeLow > 0) {
    const orSize = levels.openingRangeHigh - levels.openingRangeLow;
    const avgATR = dailyBars.length >= 14 ? atr(dailyBars.slice(-15)) : 0;
    if (avgATR > 0) {
      const orRatio = orSize / avgATR;
      if (orRatio > 0.5) { trendScore += 2; reasons.push(`wide OR (${(orRatio * 100).toFixed(0)}% of ATR)`); }
      else if (orRatio < 0.25) { trendScore -= 2; reasons.push(`narrow OR (${(orRatio * 100).toFixed(0)}% of ATR)`); }
    }
  }

  // 3. Price relative to previous day range — outside = trend
  if (todayBars.length > 0 && levels.prevDayHigh > 0) {
    const current = todayBars[todayBars.length - 1].c;
    if (current > levels.prevDayHigh) { trendScore += 2; reasons.push("trading above prev day high"); }
    else if (current < levels.prevDayLow) { trendScore += 2; reasons.push("trading below prev day low"); }
    else { trendScore -= 1; reasons.push("inside prev day range"); }
  }

  // 4. Volume in first 30 min vs average — high volume = trend
  if (todayBars.length >= 6) {
    const first30vol = todayBars.slice(0, 6).reduce((s, b) => s + b.v, 0);
    const avgDailyVol = dailyBars.length >= 5 ? dailyBars.slice(-5).reduce((s, b) => s + b.v, 0) / 5 : 0;
    if (avgDailyVol > 0) {
      // First 30 min typically = ~15-20% of daily volume
      const volRatio = (first30vol / avgDailyVol) * 100;
      if (volRatio > 25) { trendScore += 2; reasons.push(`high early volume (${volRatio.toFixed(0)}% of daily avg)`); }
      else if (volRatio < 12) { trendScore -= 1; reasons.push(`low early volume`); }
    }
  }

  // 5. Consecutive daily bars in same direction = trending regime
  if (dailyBars.length >= 3) {
    const last3 = dailyBars.slice(-3);
    const allUp = last3.every((b) => b.c > b.o);
    const allDown = last3.every((b) => b.c < b.o);
    if (allUp || allDown) { trendScore += 1; reasons.push(`3-day directional streak`); }
  }

  const dayType: DayType = trendScore >= 3 ? "trend" : trendScore <= -1 ? "range" : "unknown";
  const confidence = Math.min(95, 50 + Math.abs(trendScore) * 8);

  return { dayType, confidence, reasoning: `${dayType.toUpperCase()} day (score ${trendScore}): ${reasons.join(", ")}` };
}

// ============ TIME-OF-DAY QUALITY ============
// Not all hours are equal. This adjusts confidence and position size.

function getTimeQuality(session: Session, minutesSinceOpen: number): { quality: "prime" | "good" | "avoid"; sizeMultiplier: number } {
  // ============ TWO WINDOWS ONLY ============
  // The edge lives in two places. Everything else is noise that bleeds money.
  //
  // WINDOW 1: 9:45-11:30 AM ET — Morning prime. 80% of daily P&L comes from here.
  //   Volume is highest, setups follow through, institutions are active.
  //
  // WINDOW 2: 2:00-3:30 PM ET — Afternoon flow. Second best window.
  //   Institutional rebalancing, trend resumption after lunch chop.
  //
  // EVERYTHING ELSE: Manage existing positions only. No new entries.
  //   Lunch (11:30-2:00) = chop that erases morning gains.
  //   Overnight = thin liquidity, wide spreads, fake moves, not worth $490 risk.

  // WINDOW 1: Morning prime — FULL SIZE
  if (session === "morning" && minutesSinceOpen >= 15) return { quality: "prime", sizeMultiplier: 1.0 };

  // WINDOW 2: Afternoon — 80% size (slightly less reliable than morning)
  if (session === "afternoon") return { quality: "good", sizeMultiplier: 0.8 };

  // WINDOW 3: Late afternoon (3:30-3:45 PM) — 60% size
  // Data shows last_30_min has BEST win rate (36% on 25 trades).
  // Institutional MOC rebalancing creates clean, directional moves.
  if (session === "close") return { quality: "good", sizeMultiplier: 0.6 };

  // ── BLOCKED SESSIONS — position management only, no new entries ──

  // Lunch: the account killer. Volume drops 40-60%, everything mean-reverts.
  if (session === "midday") return { quality: "avoid", sizeMultiplier: 0 };

  // All ETH sessions: not worth the risk on a $7K account.
  // The agent still manages positions (trailing stops, scale-outs) during ETH,
  // but will not open new trades.
  if (session === "eth_europe") return { quality: "avoid", sizeMultiplier: 0 };
  if (session === "eth_evening") return { quality: "avoid", sizeMultiplier: 0 };
  if (session === "eth_asia") return { quality: "avoid", sizeMultiplier: 0 };

  // Halt
  if (session === "halt") return { quality: "avoid", sizeMultiplier: 0 };

  return { quality: "avoid", sizeMultiplier: 0 };
}

// ============ VOLUME ANALYSIS ============

function analyzeVolume(bars: { v: number; c: number }[]): {
  ratio: number;       // current vs 20-bar avg
  trend: "surge" | "rising" | "normal" | "declining" | "dry";
  buyPressure: number; // 0-1 (up bars close vs prev close)
} {
  if (bars.length < 20) return { ratio: 1, trend: "normal", buyPressure: 0.5 };

  const last20 = bars.slice(-20);
  const avgVol = last20.reduce((s, b) => s + b.v, 0) / 20;
  const current = bars[bars.length - 1].v;
  const ratio = avgVol > 0 ? current / avgVol : 1;

  // Volume trend over last 5 bars
  const last5 = bars.slice(-5);
  const first5avg = last20.slice(0, 5).reduce((s, b) => s + b.v, 0) / 5;
  const last5avg = last5.reduce((s, b) => s + b.v, 0) / 5;
  const volChange = first5avg > 0 ? last5avg / first5avg : 1;

  let trend: "surge" | "rising" | "normal" | "declining" | "dry";
  if (ratio > 2.0) trend = "surge";
  else if (volChange > 1.3) trend = "rising";
  else if (volChange < 0.6) trend = "dry";
  else if (volChange < 0.8) trend = "declining";
  else trend = "normal";

  // Buy pressure: proportion of volume on up bars (close > prev close)
  let upVol = 0, totalVol = 0;
  for (let i = 1; i < last20.length; i++) {
    totalVol += last20[i].v;
    if (last20[i].c > last20[i - 1].c) upVol += last20[i].v;
  }
  const buyPressure = totalVol > 0 ? upVol / totalVol : 0.5;

  return { ratio, trend, buyPressure };
}

// ============ SETUP DETECTION v2 ============
// Rebuilt from first principles:
// - Day type drives setup selection
// - Trend days: Opening Range Breakout + Trend Continuation (go WITH the move)
// - Range days: VWAP Mean Reversion ONLY (fade extremes)
// - KILLED: Key Level Bounce (too noisy), EMA Crossover (too lagging)
// - Added: time-of-day filter, volume profile, adaptive confidence

type SetupType =
  | "opening_range_breakout"
  | "vwap_mean_reversion"
  | "trend_continuation"
  | "key_level_bounce"
  | "ema_crossover"
  | "none";

interface Setup {
  type: SetupType;
  direction: "long" | "short";
  confidence: number;
  reasoning: string;
  stopDistance: number;
  targetDistance: number;
}

function detectSetup(
  price: number,
  closes: number[],
  bars: { h: number; l: number; c: number; v: number }[],
  levels: KeyLevels,
  vwapData: { vwap: number; upperBand: number; lowerBand: number },
  session: Session,
  regime: string,
  dayType: DayType = "unknown",
  minutesSinceOpen: number = 60,
): Setup {
  if (closes.length < 25) return { type: "none", direction: "long", confidence: 0, reasoning: "Insufficient data", stopDistance: 0, targetDistance: 0 };

  const currentRSI = rsi(closes) || 50;
  const emaFast = ema(closes, 9);
  const emaSlow = ema(closes, 21);
  const currentATR = atr(bars);
  if (currentATR <= 0) return { type: "none", direction: "long", confidence: 0, reasoning: "ATR is zero", stopDistance: 0, targetDistance: 0 };

  const fastEMA = emaFast[emaFast.length - 1];
  const slowEMA = emaSlow[emaSlow.length - 1];

  const volume = analyzeVolume(bars);
  const timeQ = getTimeQuality(session, minutesSinceOpen);

  // ── DON'T TRADE during lunch chop unless perfect setup ──
  if (timeQ.quality === "avoid") {
    return { type: "none", direction: "long", confidence: 0, reasoning: `Avoiding ${session} session (low quality)`, stopDistance: 0, targetDistance: 0 };
  }

  // ── SETUP 1: OPENING RANGE BREAKOUT ──
  // ONLY on trend days. Requires: wide OR, volume surge, within first 90 min.
  if ((dayType === "trend" || dayType === "unknown") && session === "morning" && levels.openingRangeHigh > 0 && levels.openingRangeLow > 0) {
    const orSize = levels.openingRangeHigh - levels.openingRangeLow;

    // Must have meaningful OR (> 30% of ATR) to avoid noise breakouts
    if (orSize > currentATR * 0.3) {
      if (price > levels.openingRangeHigh && volume.ratio > 1.5) {
        let conf = 72;
        // Boost: volume surge on breakout
        if (volume.trend === "surge") conf += 8;
        // Boost: price already above prev day high = strong trend
        if (price > levels.prevDayHigh && levels.prevDayHigh > 0) conf += 5;
        // Boost: buy pressure dominant
        if (volume.buyPressure > 0.6) conf += 3;
        // Penalty: thin breakout (barely above OR)
        if (price - levels.openingRangeHigh < currentATR * 0.1) conf -= 5;

        return {
          type: "opening_range_breakout", direction: "long", confidence: conf,
          reasoning: `OR breakout long: price $${price.toFixed(2)} > OR high $${levels.openingRangeHigh.toFixed(2)}, vol ${volume.ratio.toFixed(1)}x (${volume.trend})`,
          stopDistance: Math.max(orSize * 0.5, currentATR * 1.0), // stop at mid-range or 1 ATR
          targetDistance: orSize * 1.5, // 1.5x the OR size
        };
      }
      if (price < levels.openingRangeLow && volume.ratio > 1.5) {
        let conf = 72;
        if (volume.trend === "surge") conf += 8;
        if (price < levels.prevDayLow && levels.prevDayLow > 0) conf += 5;
        if (volume.buyPressure < 0.4) conf += 3;
        if (levels.openingRangeLow - price < currentATR * 0.1) conf -= 5;

        return {
          type: "opening_range_breakout", direction: "short", confidence: conf,
          reasoning: `OR breakout short: price $${price.toFixed(2)} < OR low $${levels.openingRangeLow.toFixed(2)}, vol ${volume.ratio.toFixed(1)}x (${volume.trend})`,
          stopDistance: Math.max(orSize * 0.5, currentATR * 1.0),
          targetDistance: orSize * 1.5,
        };
      }
    }
  }

  // ── SETUP 2: TREND CONTINUATION ──
  // ONLY on trend days or in trending regime. Pullback to EMA zone (within 0.3%, not exact touch).
  // Requires: volume declining on pullback (healthy), RSI not extreme.
  if ((dayType === "trend" || regime === "bull" || regime === "bear") &&
      (session === "morning" || session === "afternoon")) {
    const isTrendUp = fastEMA > slowEMA;
    const isTrendDown = fastEMA < slowEMA;
    const nearEMA9 = Math.abs(price - fastEMA) / price < 0.003; // within 0.3%
    const aboveEMA21 = price > slowEMA;
    const belowEMA21 = price < slowEMA;

    if (isTrendUp && nearEMA9 && aboveEMA21 && currentRSI > 35 && currentRSI < 65) {
      let conf = 75;
      // Boost: volume declining on pullback (healthy pullback, not selling pressure)
      if (volume.trend === "declining" || volume.trend === "dry") conf += 8;
      // Boost: price above VWAP (intraday trend confirmation)
      if (price > vwapData.vwap) conf += 5;
      // Boost: strong prior trend (EMA gap widening)
      if ((fastEMA - slowEMA) / price > 0.002) conf += 3;
      // Penalty: volume surge on pullback = selling, not healthy
      if (volume.trend === "surge") conf -= 10;
      // Penalty: RSI already high = late entry
      if (currentRSI > 60) conf -= 5;

      return {
        type: "trend_continuation", direction: "long", confidence: conf,
        reasoning: `Trend pullback long: near EMA9 $${fastEMA.toFixed(2)}, RSI ${currentRSI.toFixed(0)}, vol ${volume.trend}`,
        stopDistance: Math.max(currentATR * 1.2, Math.abs(price - slowEMA) * 1.1), // stop below EMA21
        targetDistance: currentATR * 2.5,
      };
    }
    if (isTrendDown && nearEMA9 && belowEMA21 && currentRSI > 35 && currentRSI < 65) {
      let conf = 75;
      if (volume.trend === "declining" || volume.trend === "dry") conf += 8;
      if (price < vwapData.vwap) conf += 5;
      if ((slowEMA - fastEMA) / price > 0.002) conf += 3;
      if (volume.trend === "surge") conf -= 10;
      if (currentRSI < 40) conf -= 5;

      return {
        type: "trend_continuation", direction: "short", confidence: conf,
        reasoning: `Trend pullback short: near EMA9 $${fastEMA.toFixed(2)}, RSI ${currentRSI.toFixed(0)}, vol ${volume.trend}`,
        stopDistance: Math.max(currentATR * 1.2, Math.abs(slowEMA - price) * 1.1),
        targetDistance: currentATR * 2.5,
      };
    }
  }

  // ── SETUP 3: VWAP MEAN REVERSION ──
  // ONLY on range days or choppy regime. Requires: declining volume at extreme + RSI confirmation.
  // This is the highest-probability setup when conditions are right.
  if ((dayType === "range" || regime === "choppy" || regime === "neutral") &&
      (session === "morning" || session === "midday" || session === "afternoon")) {
    // Short from VWAP upper band
    if (price > vwapData.upperBand && currentRSI > 65) {
      let conf = 68;
      // Boost: declining volume at extreme = exhaustion
      if (volume.trend === "declining" || volume.trend === "dry") conf += 10;
      // Boost: strong RSI extreme
      if (currentRSI > 75) conf += 5;
      // Boost: inside previous day range (range confirmation)
      if (price < levels.prevDayHigh && price > levels.prevDayLow) conf += 3;
      // Penalty: volume surge at extreme = breakout, not reversion
      if (volume.trend === "surge") conf -= 15;
      // Penalty: price breaking prev day high = trend, not range
      if (levels.prevDayHigh > 0 && price > levels.prevDayHigh) conf -= 10;

      const targetDist = price - vwapData.vwap;
      if (targetDist > currentATR * 0.3) { // only if target is meaningful
        return {
          type: "vwap_mean_reversion", direction: "short", confidence: conf,
          reasoning: `VWAP fade short: $${price.toFixed(2)} > upper band $${vwapData.upperBand.toFixed(2)}, RSI ${currentRSI.toFixed(0)}, vol ${volume.trend}`,
          stopDistance: currentATR * 1.2, // tighter stop for mean reversion
          targetDistance: targetDist * 0.8, // target 80% of the way to VWAP (don't hold for exact touch)
        };
      }
    }
    // Long from VWAP lower band
    if (price < vwapData.lowerBand && currentRSI < 35) {
      let conf = 68;
      if (volume.trend === "declining" || volume.trend === "dry") conf += 10;
      if (currentRSI < 25) conf += 5;
      if (price < levels.prevDayHigh && price > levels.prevDayLow) conf += 3;
      if (volume.trend === "surge") conf -= 15;
      if (levels.prevDayLow > 0 && price < levels.prevDayLow) conf -= 10;

      const targetDist = vwapData.vwap - price;
      if (targetDist > currentATR * 0.3) {
        return {
          type: "vwap_mean_reversion", direction: "long", confidence: conf,
          reasoning: `VWAP fade long: $${price.toFixed(2)} < lower band $${vwapData.lowerBand.toFixed(2)}, RSI ${currentRSI.toFixed(0)}, vol ${volume.trend}`,
          stopDistance: currentATR * 1.2,
          targetDistance: targetDist * 0.8,
        };
      }
    }
  }

  // ── NO SETUP ──
  // Key Level Bounce: KILLED — prev day H/L are magnets, not reliable bounces
  // EMA Crossover: KILLED — lagging signal, move is often exhausted by the time it triggers

  return { type: "none", direction: "long", confidence: 0, reasoning: "No valid setup", stopDistance: 0, targetDistance: 0 };
}

// ============ MAIN FUTURES AGENT ============

interface FuturesTradeResult {
  symbol: string;
  action: string;
  contracts: number;
  price: number;
  stopLoss: number;
  target: number;
  reasoning: string;
  orderId: string | null;
  success: boolean;
}

export async function runFuturesAgent(): Promise<{
  trades: FuturesTradeResult[];
  managed: number;
  details: string[];
}> {
  const details: string[] = [];
  const trades: FuturesTradeResult[] = [];
  let managed = 0;

  // Load config overrides from Agent Hub
  await loadFuturesConfig();

  // Check Tradovate connection
  const auth = await checkTradovateAuth();
  if (!auth.authenticated) {
    details.push("Tradovate not authenticated — set TRADOVATE_USERNAME, TRADOVATE_PASSWORD, TRADOVATE_CID, TRADOVATE_SEC env vars");
    return { trades, managed, details };
  }
  // Verify trading mode — default is DEMO, must be explicitly changed to live
  const tradingMode = await (await import("./trading-mode")).getTradingMode("futures");
  details.push(`TRADOVATE: Connected — Account ${auth.accountName} (#${auth.accountId}) — MODE: ${tradingMode.toUpperCase()}`);
  if (tradingMode === "live") {
    details.push("⚠ LIVE MODE — real money at risk");
  }

  // Session check
  const { session, isRTH, isETH, minutesSinceOpen } = getSession();
  details.push(`SESSION: ${session.replace(/_/g, " ").toUpperCase()} | RTH: ${isRTH ? "YES" : "NO"} | ETH: ${isETH ? "YES" : "NO"} | ${minutesSinceOpen.toFixed(0)} min since open`);

  // Halt = market closed (weekend or daily 5-6 PM ET break)
  if (session === "halt") {
    details.push("Market halted — no action");
    return { trades, managed, details };
  }

  // Determine if we should scan for NEW trades (vs just managing positions)
  // Position management ALWAYS runs regardless of session.
  // New entries ONLY during the two prime windows (morning + afternoon).
  const totalRTHMinutes = (FUTURES_RULES.RTH_END_ET - FUTURES_RULES.RTH_START_ET) * 60; // 390 min
  const isFirstLast15 = isRTH && (minutesSinceOpen < FUTURES_RULES.AVOID_FIRST_MINUTES || minutesSinceOpen > (totalRTHMinutes - FUTURES_RULES.AVOID_LAST_MINUTES));
  const timeQuality = getTimeQuality(session, minutesSinceOpen);
  const canScanNewTrades = timeQuality.sizeMultiplier > 0 && !isFirstLast15;
  if (!canScanNewTrades) {
    const reason = timeQuality.sizeMultiplier === 0
      ? `outside trading windows (${session}) — only morning 9:45-11:30 + afternoon 2:00-3:30`
      : "first/last 15 min RTH";
    details.push(`New trade scanning BLOCKED (${reason}) — position management still active`);
  }

  // Market regime
  let regime = "choppy";
  try {
    const r = await detectMarketRegime();
    regime = r.regime;
    details.push(`REGIME: ${r.regime.toUpperCase()} — ${r.recommendation}`);
  } catch {
    details.push("REGIME: Unknown — using conservative defaults");
  }

  // Macro context + vault brain update
  let vixValue = 0;
  try {
    const signals = await getCrossAssetSignals();
    vixValue = signals.vix;
    details.push(`MACRO: VIX: ${signals.vix.toFixed(1)} (${signals.vixSignal}) | Macro: ${signals.macroSignal}`);

    // Update vault brain with live data
    try {
      await updateMarketRegime(regime, {
        trend: regime === "bull" ? "Uptrend" : regime === "bear" ? "Downtrend" : "Sideways/Choppy",
        volatility: `VIX ${signals.vix.toFixed(1)}`,
        implications: `Macro signal: ${signals.macroSignal}. VIX signal: ${signals.vixSignal}.`,
      });
      const volRegime = signals.vix > 30 ? "HIGH" : signals.vix > 25 ? "ELEVATED" : signals.vix > 18 ? "NORMAL" : "LOW";
      await updateVolatilityEnvironment(signals.vix, "", signals.vixSignal, volRegime);
    } catch { /* vault update optional */ }
  } catch { /* ignore */ }

  // Load vault intelligence for AI context
  let vaultContext = "";
  try {
    vaultContext = await getVaultContextForAI("futures-agent", "futures-scalping.md");
    if (vaultContext) details.push("VAULT: Loaded brain context (regime, lessons, anti-patterns)");
  } catch { /* vault optional */ }

  // Account state — use simulated equity for risk sizing, actual for monitoring
  let equity = 0;
  let actualEquity = 0;
  try {
    const summary = await getTradovateAccountSummary();
    actualEquity = summary.netLiq || summary.balance || 0;
    if (actualEquity <= 0 || actualEquity > 10_000_000) {
      actualEquity = 50_000;
      details.push(`WARNING: Equity anomaly — using $50k actual default`);
    }
    // Use simulated equity for all risk calculations (mirrors $5K live)
    equity = FUTURES_RULES.SIMULATED_EQUITY || actualEquity;
    details.push(`ACCOUNT: Actual $${actualEquity.toLocaleString()} | Risk-sizing as $${equity.toLocaleString()} (Unrealized: $${summary.unrealizedPnl.toFixed(0)})`);
  } catch (err) {
    details.push(`Account error: ${err}`);
    return { trades, managed, details };
  }

  // Load regime transition + event catalyst overrides
  let sizeOverride = 1.0;
  try {
    const [regimeConfig, eventConfig] = await Promise.all([
      prisma.agentConfig.findUnique({ where: { key: "regime_size_override" } }),
      prisma.agentConfig.findUnique({ where: { key: "event_size_override" } }),
    ]);
    const regimeOverride = regimeConfig?.value ? parseFloat(regimeConfig.value) || 1.0 : 1.0;
    // Event override now stored as JSON with TTL — fall back to plain number for backward compat
    let eventOverride = 1.0;
    if (eventConfig?.value) {
      try {
        const parsed = JSON.parse(eventConfig.value);
        const expired = parsed.expiresAt && new Date(parsed.expiresAt) < new Date();
        eventOverride = expired ? 1.0 : (parsed.multiplier || 1.0);
      } catch {
        eventOverride = parseFloat(eventConfig.value) || 1.0;
      }
    }
    sizeOverride = regimeOverride * eventOverride;
    if (sizeOverride !== 1.0) {
      details.push(`OVERRIDES: regime ${regimeOverride}x × event ${eventOverride}x = ${sizeOverride.toFixed(2)}x sizing`);
    }
  } catch { /* use defaults */ }

  // Evaluate drawdown protocol
  try {
    const ddState = await evaluateDrawdownState();
    if (ddState.mode !== "NORMAL") {
      sizeOverride *= ddState.overrides.sizeMultiplier;
      details.push(`DRAWDOWN: ${ddState.mode} — sizing ${(ddState.overrides.sizeMultiplier * 100).toFixed(0)}%`);
      if (ddState.mode === "LOCKDOWN") {
        details.push("LOCKDOWN: No new futures trades");
        return { trades, managed, details };
      }
    }
  } catch { /* use defaults */ }

  // Calculate risk limits based on equity (adjusted by overrides)
  const maxRiskPerTrade = equity * FUTURES_RULES.RISK_PER_TRADE_PCT * sizeOverride;
  const dailyLossLimit = equity * FUTURES_RULES.DAILY_LOSS_LIMIT_PCT;
  details.push(`RISK: $${maxRiskPerTrade.toFixed(0)} per trade${sizeOverride !== 1.0 ? ` (${sizeOverride.toFixed(2)}x adjusted)` : ""} | $${dailyLossLimit.toFixed(0)} daily limit`);

  // Check daily P&L (ET-aware day boundary — force ET interpretation regardless of server timezone)
  const etDateStr = getETDateString();
  const isDST = new Date().toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).includes("EDT");
  const todayStart = new Date(`${etDateStr}T00:00:00${isDST ? "-04:00" : "-05:00"}`);
  const todayTrades = await prisma.autoTradeLog.findMany({
    where: { symbol: { startsWith: "FUT:" }, createdAt: { gte: todayStart } },
  });
  const todayPnl = todayTrades.filter((t) => t.pnl != null).reduce((s, t) => s + (t.pnl || 0), 0);
  const todayTradeCount = todayTrades.filter((t) => t.action.startsWith("futures_")).length;

  // These limits block REAL trades but the agent keeps scanning in paper/learning mode
  // Daily loss limit is absolute — no override
  if (todayPnl < -dailyLossLimit) {
    details.push(`DAILY LOSS LIMIT: Down $${Math.abs(todayPnl).toFixed(0)} (limit: $${dailyLossLimit.toFixed(0)}). Real trades blocked — learning mode active.`);
  }
  // Trade count limit: base cap of 3, but A+ setups can push to 5
  const atBaseTradeLimit = todayTradeCount >= FUTURES_RULES.MAX_TRADES_PER_DAY;
  const atHardTradeLimit = todayTradeCount >= FUTURES_RULES.MAX_TRADES_APLUS_OVERRIDE;
  if (atHardTradeLimit) {
    details.push(`HARD TRADE LIMIT: ${todayTradeCount}/${FUTURES_RULES.MAX_TRADES_APLUS_OVERRIDE} trades today (including A+ overrides). All trades blocked.`);
  } else if (atBaseTradeLimit) {
    details.push(`BASE TRADE LIMIT: ${todayTradeCount}/${FUTURES_RULES.MAX_TRADES_PER_DAY} trades today. Only A+ setups can still execute (up to ${FUTURES_RULES.MAX_TRADES_APLUS_OVERRIDE} total).`);
  }

  // Get existing futures positions
  let futuresPositions: TradovatePosition[] = [];
  try {
    futuresPositions = await getTradovatePositions();
  } catch (err) {
    details.push(`CRITICAL: Failed to fetch positions from Tradovate: ${err}`);
    try { await sendNotification(`FUTURES AGENT: Cannot fetch positions — ${err}. Position management skipped.`, "futures"); } catch {}
    return { trades, managed, details };
  }
  details.push(`POSITIONS: ${futuresPositions.length} futures open`);

  // ============ MANAGE EXISTING POSITIONS ============
  // Pre-fetch bars for each unique symbol (Tradovate primary, Yahoo fallback)
  const posBarCache: Record<string, { bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]; price: number; atrVal: number }> = {};
  for (const pos of futuresPositions) {
    const sym = Object.keys(FUTURES_CONTRACTS).find((s) => pos.contractName.startsWith(s));
    if (sym && !posBarCache[sym]) {
      try {
        const bars = await getFuturesIntradayBars(sym, "5m", "1d");
        posBarCache[sym] = {
          bars,
          price: bars.length > 0 ? bars[bars.length - 1].c : 0,
          atrVal: atr(bars.map((b) => ({ h: b.h, l: b.l, c: b.c }))),
        };
      } catch { posBarCache[sym] = { bars: [], price: 0, atrVal: 5 }; }
    }
  }

  // Get all open orders so we can cancel brackets when we manually close
  let openOrders: { id: number; action: string; orderType: string; orderQty: number; orderStatus: string; contractId: number }[] = [];
  try {
    openOrders = await getOpenOrders();
  } catch (err) {
    details.push(`WARNING: Failed to fetch open orders: ${err}. Bracket cancellation may fail.`);
  }

  // ── AGGREGATE DRAWDOWN CHECK (all positions combined) ──
  const aggregateUnrealizedPnl = futuresPositions.reduce((sum, pos) => {
    const sym = Object.keys(FUTURES_CONTRACTS).find((s) => pos.contractName.startsWith(s));
    const cached = sym ? posBarCache[sym] : null;
    if (!cached || cached.price === 0) return sum;
    const multiplier = sym ? FUTURES_CONTRACTS[sym].multiplier : 5;
    const pnl = (cached.price - pos.netPrice) * Math.abs(pos.netPos) * multiplier * (pos.netPos > 0 ? 1 : -1);
    return sum + pnl;
  }, 0);
  const aggregateDrawdown = aggregateUnrealizedPnl + todayPnl; // unrealized + realized today
  if (aggregateDrawdown < -(equity * FUTURES_RULES.MAX_DRAWDOWN_PCT)) {
    details.push(`AGGREGATE DRAWDOWN KILL SWITCH: Combined P&L $${aggregateDrawdown.toFixed(0)} exceeds ${(FUTURES_RULES.MAX_DRAWDOWN_PCT * 100).toFixed(0)}% of equity — CLOSING ALL`);
    for (const pos of futuresPositions) {
      const absQty = Math.abs(pos.netPos);
      try {
        await placeMarketOrder({ contractId: pos.contractId, action: pos.netPos > 0 ? "Sell" : "Buy", quantity: absQty });
        await prisma.autoTradeLog.create({ data: {
          symbol: `FUT:${pos.contractName}`, action: "futures_emergency_close",
          qty: absQty, price: posBarCache[Object.keys(FUTURES_CONTRACTS).find((s) => pos.contractName.startsWith(s)) || ""]?.price || 0,
          pnl: null, orderId: null,
          reason: `AGGREGATE DRAWDOWN KILL: Combined P&L $${aggregateDrawdown.toFixed(0)} exceeded ${(FUTURES_RULES.MAX_DRAWDOWN_PCT * 100).toFixed(0)}% equity limit. Closed all positions.`,
        }});
      } catch (err) { details.push(`  Emergency close ${pos.contractName} failed: ${err}`); }
    }
    try { for (const o of openOrders) { await cancelOrder(o.id); } } catch {}
    try { await sendNotification(`🚨 AGGREGATE DRAWDOWN KILL: All futures closed. Combined P&L: $${aggregateDrawdown.toFixed(0)}`, "futures"); } catch {}
    return { trades, managed, details };
  }

  for (const pos of futuresPositions) {
    managed++;
    const qty = pos.netPos;
    const absQty = Math.abs(qty);
    const avgPrice = pos.netPrice;
    const direction = qty > 0 ? "long" : "short";
    const symbolMatch = Object.keys(FUTURES_CONTRACTS).find((s) => pos.contractName.startsWith(s));
    const multiplier = symbolMatch ? FUTURES_CONTRACTS[symbolMatch].multiplier : 5;

    // Use cached bars (guard: ATR must be positive, default to 5 if zero/missing)
    const cached = symbolMatch ? posBarCache[symbolMatch] : null;
    const currentPrice = cached?.price || avgPrice;
    const currentATRVal = cached?.atrVal && cached.atrVal > 0 ? cached.atrVal : 5;

    const priceDiff = direction === "long" ? currentPrice - avgPrice : avgPrice - currentPrice;
    const unrealizedPnl = priceDiff * multiplier * absQty;

    details.push(`  ${pos.contractName}: ${direction.toUpperCase()} ${absQty}x @ $${avgPrice.toFixed(2)} → $${currentPrice.toFixed(2)} (${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(0)})`);

    // Find the trade log for stop/target reference
    const tradeLog = await prisma.autoTradeLog.findFirst({
      where: { symbol: `FUT:${symbolMatch || pos.contractName}`, action: { startsWith: "futures_" }, orderId: { not: null } },
      orderBy: { createdAt: "desc" },
    });

    let origStop = 0, origTarget = 0;
    if (tradeLog?.reason) {
      const sm = tradeLog.reason.match(/Stop:\s*\$?([\d,.]+)/);
      const tm = tradeLog.reason.match(/Target:\s*\$?([\d,.]+)/);
      if (sm) origStop = parseFloat(sm[1].replace(",", ""));
      if (tm) origTarget = parseFloat(tm[1].replace(",", ""));
    }

    // SANITY: Stop must be on correct side of entry (slippage can push fill past calculated stop)
    if (origStop > 0 && direction === "long" && origStop >= avgPrice) {
      const corrected = avgPrice - currentATRVal * 1.5;
      details.push(`    WARNING: Stop $${origStop.toFixed(2)} was ABOVE entry $${avgPrice.toFixed(2)} for LONG — corrected to $${corrected.toFixed(2)}`);
      origStop = corrected;
    }
    if (origStop > 0 && direction === "short" && origStop <= avgPrice) {
      const corrected = avgPrice + currentATRVal * 1.5;
      details.push(`    WARNING: Stop $${origStop.toFixed(2)} was BELOW entry $${avgPrice.toFixed(2)} for SHORT — corrected to $${corrected.toFixed(2)}`);
      origStop = corrected;
    }

    const stopDistance = origStop > 0 ? Math.abs(avgPrice - origStop) : currentATRVal * 1.5;

    // Helper: cancel bracket orders for this contract before manual close
    const cancelBracketOrders = async () => {
      const relatedOrders = openOrders.filter((o) => o.contractId === pos.contractId);
      for (const order of relatedOrders) {
        try { await cancelOrder(order.id); } catch { /* ignore — may already be filled */ }
      }
    };

    // ── TRAILING STOP LOGIC ──
    // Bracket orders handle the original stop/target. We layer on top:
    // - At 2R+ profit: if price reverses past 1 ATR trailing level, close manually
    if (priceDiff >= stopDistance * 2 && currentATRVal > 0) {
      const trailStop = direction === "long"
        ? currentPrice - currentATRVal
        : currentPrice + currentATRVal;

      // Only trail if trail level is tighter than original stop
      const isTrailTighter = origStop > 0
        ? (direction === "long" ? trailStop > origStop : trailStop < origStop)
        : true;

      if (isTrailTighter) {
        details.push(`    TRAILING: ${(priceDiff / stopDistance).toFixed(1)}R profit — trail at $${trailStop.toFixed(2)}`);

        // Check if we should record that this position reached 2R (for breakeven tracking)
        const reached2R = await prisma.autoTradeLog.findFirst({
          where: { symbol: `FUT:${symbolMatch || pos.contractName}`, action: "futures_reached_2r", createdAt: { gte: todayStart } },
        });
        if (!reached2R) {
          await prisma.autoTradeLog.create({ data: {
            symbol: `FUT:${symbolMatch || pos.contractName}`, action: "futures_reached_2r",
            qty: absQty, price: currentPrice, pnl: null, orderId: null,
            reason: `Position reached ${(priceDiff / stopDistance).toFixed(1)}R. Trail stop active at $${trailStop.toFixed(2)}.`,
          }});
        }
      }
    }

    // ── BREAKEVEN STOP ──
    // If position previously reached 1R+ (tracked in DB) but has now pulled back to entry, close
    if (priceDiff <= 0 && priceDiff > -stopDistance * 0.5) {
      // Check if this position ever reached 1R
      const everReached1R = await prisma.autoTradeLog.findFirst({
        where: {
          symbol: `FUT:${symbolMatch || pos.contractName}`,
          action: { in: ["futures_reached_2r", "futures_scale_out"] },
          createdAt: { gte: todayStart },
        },
      });
      if (everReached1R) {
        details.push(`    BREAKEVEN STOP: Was at 1R+, pulled back to ${(priceDiff / stopDistance).toFixed(2)}R — closing to protect`);
        try {
          // Close FIRST, then cancel brackets (if close fails, brackets still protect)
          await placeMarketOrder({ contractId: pos.contractId, action: direction === "long" ? "Sell" : "Buy", quantity: absQty });
          await cancelBracketOrders();
          await prisma.autoTradeLog.create({ data: {
            symbol: `FUT:${pos.contractName}`, action: "futures_breakeven_close",
            qty: absQty, price: currentPrice, pnl: unrealizedPnl, orderId: null,
            reason: `Breakeven stop: Position was at 1R+, pulled back past entry. P&L: $${unrealizedPnl.toFixed(0)}`,
          }});
          try {
            await logTradeToJournal({ tradeId: `BE-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), instrument: `FUT:${pos.contractName}`, direction: direction === "long" ? "LONG" : "SHORT", strategy: "futures-scalping", setupType: "breakeven_close", contracts: absQty, entryPrice: pos.netPrice, stopPrice: 0, targetPrice: 0, exitPrice: currentPrice, pnlDollars: unrealizedPnl, conviction: 0, exitReason: "Breakeven stop — was at 1R+, pulled back" }, "futures-agent");
            await logObservation("futures-agent", `BREAKEVEN EXIT ${pos.contractName} | Was at 1R+ but pulled back to ${(priceDiff / stopDistance).toFixed(2)}R | P&L: $${unrealizedPnl.toFixed(0)} | Review: was the target too ambitious?`);
          } catch {}
        } catch (err) { details.push(`    Breakeven close failed: ${err}`); }
        continue; // position closed, skip remaining checks
      }
    }

    // ── HARD STOP: Fallback when broker stop order fails or was never placed ──
    if (origStop > 0) {
      const pastStop = direction === "long" ? currentPrice <= origStop : currentPrice >= origStop;
      if (pastStop) {
        details.push(`    HARD STOP: Price $${currentPrice.toFixed(2)} past stop $${origStop.toFixed(2)} — broker stop may have failed. P&L: $${unrealizedPnl.toFixed(0)}`);
        try {
          // Close FIRST, then cancel brackets (if close fails, brackets still protect)
          await placeMarketOrder({ contractId: pos.contractId, action: direction === "long" ? "Sell" : "Buy", quantity: absQty });
          await cancelBracketOrders();
          await prisma.autoTradeLog.create({ data: {
            symbol: `FUT:${pos.contractName}`, action: "futures_stop_loss",
            qty: absQty, price: currentPrice, pnl: unrealizedPnl, orderId: null,
            reason: `HARD STOP: Price $${currentPrice.toFixed(2)} past stop $${origStop.toFixed(2)}. Broker stop may have failed. P&L: $${unrealizedPnl.toFixed(0)}`,
          }});
          try {
            await logTradeToJournal({ tradeId: `HS-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), instrument: `FUT:${pos.contractName}`, direction: direction === "long" ? "LONG" : "SHORT", strategy: "futures-scalping", setupType: "hard_stop", contracts: absQty, entryPrice: avgPrice, stopPrice: origStop, targetPrice: origTarget, exitPrice: currentPrice, pnlDollars: unrealizedPnl, conviction: 0, exitReason: "Hard stop — broker stop failed" }, "futures-agent");
            await logObservation("futures-agent", `HARD STOP ${pos.contractName} — broker stop FAILED at $${origStop.toFixed(2)}, closed at $${currentPrice.toFixed(2)} | P&L: $${unrealizedPnl.toFixed(0)} | INVESTIGATE: broker order reliability`);
          } catch {}
        } catch (err) { details.push(`    Hard stop close FAILED: ${err}`); }
        continue; // position closed, skip remaining checks
      }
    }

    // ── SCALE OUT at 1.5R (close half, or full close if only 1 contract) ──
    // Moved from 1R → 1.5R: at sub-35% WR, we need winners to run bigger.
    // Breakeven stop protects the remaining contracts.
    // If 2+ contracts: close half, breakeven stop on rest (classic scale-out)
    // If 1 contract: close entire position at 1.5R (can't split 1 contract)
    if (priceDiff >= stopDistance * 1.5 && priceDiff < stopDistance * 2) {
      const scaleQty = absQty === 1 ? 1 : Math.floor(absQty / 2);
      if (scaleQty >= 1) {
        const alreadyScaled = await prisma.autoTradeLog.findFirst({
          where: { symbol: `FUT:${symbolMatch || pos.contractName}`, action: "futures_scale_out", createdAt: { gte: todayStart } },
        });
        if (!alreadyScaled) {
          details.push(`    SCALE OUT: Taking profit on ${scaleQty}/${absQty} at 1R`);
          try {
            // Close partial FIRST, then cancel old brackets, then place new stop for remaining
            await placeMarketOrder({ contractId: pos.contractId, action: direction === "long" ? "Sell" : "Buy", quantity: scaleQty });
            await cancelBracketOrders();
            // Place breakeven stop for remaining contracts
            const remainingQty = absQty - scaleQty;
            try {
              await placeStopOrder({
                contractId: pos.contractId,
                action: direction === "long" ? "Sell" : "Buy",
                quantity: remainingQty,
                stopPrice: parseFloat(avgPrice.toFixed(2)),
              });
              details.push(`    Placed breakeven stop for remaining ${remainingQty}x at $${avgPrice.toFixed(2)}`);
            } catch (stopErr) {
              details.push(`    WARNING: Failed to place breakeven stop for remaining: ${stopErr}`);
              try { await sendNotification(`Scale-out stop FAILED for ${pos.contractName}. ${remainingQty}x UNPROTECTED.`, "futures"); } catch {}
            }
            await prisma.autoTradeLog.create({ data: {
              symbol: `FUT:${symbolMatch || pos.contractName}`, action: "futures_scale_out",
              qty: scaleQty, price: currentPrice, pnl: priceDiff * multiplier * scaleQty, orderId: null,
              reason: `Scale out: Closed ${scaleQty}/${absQty} at 1R ($${currentPrice.toFixed(2)}). Remaining ${remainingQty} protected with breakeven stop.`,
            }});
            try {
              await logTradeToJournal({ tradeId: `SO-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), instrument: `FUT:${symbolMatch || pos.contractName}`, direction: direction === "long" ? "LONG" : "SHORT", strategy: "futures-scalping", setupType: "scale_out", contracts: scaleQty, entryPrice: pos.netPrice, stopPrice: 0, targetPrice: 0, exitPrice: currentPrice, pnlDollars: priceDiff * multiplier * scaleQty, conviction: 0, exitReason: `Scale out ${scaleQty}/${absQty} at 1R` }, "futures-agent");
              await logObservation("futures-agent", `SCALE OUT ${scaleQty}/${absQty} ${pos.contractName} at 1R | P&L: $${(priceDiff * multiplier * scaleQty).toFixed(0)} | Remaining ${absQty - scaleQty}x protected at breakeven`);
            } catch {}
          } catch (err) { details.push(`    Scale out failed: ${err}`); }
        }
      }
    }

    // ── EOD close in choppy markets ──
    if (session === "close" && regime === "choppy") {
      details.push(`  ${pos.contractName}: CLOSING before EOD (choppy)`);
      try {
        // Close FIRST, then cancel brackets
        await placeMarketOrder({ contractId: pos.contractId, action: qty > 0 ? "Sell" : "Buy", quantity: absQty });
        await cancelBracketOrders();
        await prisma.autoTradeLog.create({ data: {
          symbol: `FUT:${pos.contractName}`, action: "futures_session_close",
          qty: absQty, price: currentPrice, pnl: unrealizedPnl, orderId: null,
          reason: `Session close: EOD in choppy market. P&L: $${unrealizedPnl.toFixed(0)}`,
        }});
        try { await logTradeToJournal({ tradeId: `EOD-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), instrument: `FUT:${pos.contractName}`, direction: direction === "long" ? "LONG" : "SHORT", strategy: "futures-scalping", setupType: "session_close", contracts: absQty, entryPrice: pos.netPrice, stopPrice: 0, targetPrice: 0, exitPrice: currentPrice, pnlDollars: unrealizedPnl, conviction: 0, exitReason: "EOD close — choppy market" }, "futures-agent"); } catch {}
      } catch (err) { details.push(`  Failed to close: ${err}`); }
      continue;
    }

    // ── MAX DRAWDOWN KILL SWITCH ──
    if (unrealizedPnl < -(equity * FUTURES_RULES.MAX_DRAWDOWN_PCT)) {
      details.push(`  EMERGENCY: ${(FUTURES_RULES.MAX_DRAWDOWN_PCT * 100).toFixed(0)}% drawdown kill switch — CLOSING`);
      try {
        // Close FIRST, then cancel brackets
        await placeMarketOrder({ contractId: pos.contractId, action: qty > 0 ? "Sell" : "Buy", quantity: absQty });
        await cancelBracketOrders();
        await prisma.autoTradeLog.create({ data: {
          symbol: `FUT:${pos.contractName}`, action: "futures_emergency_close",
          qty: absQty, price: currentPrice, pnl: unrealizedPnl, orderId: null,
          reason: `EMERGENCY: Drawdown kill switch. P&L: $${unrealizedPnl.toFixed(0)} exceeds ${(FUTURES_RULES.MAX_DRAWDOWN_PCT * 100).toFixed(0)}% equity.`,
        }});
        try {
          await logTradeToJournal({ tradeId: `EMRG-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), instrument: `FUT:${pos.contractName}`, direction: direction === "long" ? "LONG" : "SHORT", strategy: "futures-scalping", setupType: "emergency_close", contracts: absQty, entryPrice: pos.netPrice, stopPrice: 0, targetPrice: 0, exitPrice: currentPrice, pnlDollars: unrealizedPnl, conviction: 0, exitReason: `EMERGENCY: Drawdown kill switch` }, "futures-agent");
          await logObservation("futures-agent", `EMERGENCY CLOSE: ${pos.contractName} drawdown $${Math.abs(unrealizedPnl).toFixed(0)} exceeded ${(FUTURES_RULES.MAX_DRAWDOWN_PCT * 100).toFixed(0)}% equity limit`);
        } catch {}
      } catch (err) { details.push(`  Emergency close failed: ${err}`); }
    }
  }

  // ============ SCAN FOR NEW TRADES (or paper-track if outside windows) ============
  // LEARNING MODE: Even when we can't trade (lunch, overnight, daily limit hit, tilt),
  // we still scan for setups and log them as "paper trades" with hypothetical entry/stop/target.
  // The post-market review tracks whether these would have won or lost.
  // This is how the brain learns 24/7 — studying setups even when it can't act.
  // ── TILT PROTECTION: No re-entry on recently stopped symbols ──
  // Query today's stops to build stopped-symbol set and consecutive-stop count
  const stoppedSymbols = new Set<string>();
  let consecutiveStops = 0;
  {
    const recentCloses = todayTrades
      .filter((t) => t.action.startsWith("futures_") && t.action !== "futures_long" && t.action !== "futures_short")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Track symbols that were stopped out today — no re-entry
    for (const t of recentCloses) {
      const sym = t.symbol.replace("FUT:", "");
      if (t.action.includes("stop_loss") || t.action.includes("emergency")) {
        stoppedSymbols.add(sym);
      }
    }

    // Count consecutive stops from the tail (most recent trades)
    for (let i = recentCloses.length - 1; i >= 0; i--) {
      const a = recentCloses[i].action;
      if (a.includes("stop_loss") || a.includes("emergency")) {
        consecutiveStops++;
      } else {
        break; // streak broken by a profitable exit
      }
    }
  }

  // Tilt pause: 2+ consecutive stops = paper mode only (still scans for learning)
  const isTilted = consecutiveStops >= 2;
  if (consecutiveStops >= 3) {
    details.push(`TILT L2: ${consecutiveStops} consecutive stops today — real trades blocked, learning mode`);
  } else if (consecutiveStops >= 2) {
    details.push(`TILT L1: ${consecutiveStops} consecutive stops — real trades blocked, learning mode`);
  }

  if (stoppedSymbols.size > 0) {
    details.push(`STOPPED SYMBOLS (no re-entry): ${[...stoppedSymbols].join(", ")}`);
  }

  // Paper mode for non-trade-count reasons (session, loss limit, tilt). Trade count is checked per-trade with A+ override.
  const paperTradeBase = !canScanNewTrades || todayPnl < -dailyLossLimit || atHardTradeLimit || isTilted;
  if (paperTradeBase && !canScanNewTrades) {
    details.push(`LEARNING MODE: Scanning for paper trades (${session} session) — no real entries`);
  }

  const totalContracts = futuresPositions.reduce((s, p) => s + Math.abs(p.netPos), 0);
  if (totalContracts >= FUTURES_RULES.MAX_TOTAL_CONTRACTS) {
    details.push("At contract limit — not scanning for new trades");
    return { trades, managed, details };
  }

  // Determine which symbols to trade based on equity + regime
  const tradePriority = getTradePriority(equity);
  details.push(`CONTRACTS: ${equity >= FULL_SIZE_EQUITY_THRESHOLD ? "FULL-SIZE" : "MICROS"} (equity $${equity.toLocaleString()})`);
  const symbolsToTrade = tradePriority
    .filter((s) => s.when === "always" || (s.when === "trending" && (regime === "bull" || regime === "bear")))
    .map((s) => s.symbol);

  for (const symbol of symbolsToTrade) {
    // Skip if already have position in this symbol
    if (futuresPositions.some((p) => p.contractName.startsWith(symbol))) {
      details.push(`${symbol}: Already have position — skipping`);
      continue;
    }

    // Skip if stopped out of this symbol today
    if (stoppedSymbols.has(symbol)) {
      details.push(`${symbol}: Stopped out today — no re-entry`);
      continue;
    }

    const contractInfo = FUTURES_CONTRACTS[symbol];
    details.push(`\n--- ${symbol} (${contractInfo.name}) ---`);

    const contract = await findContract(symbol);
    if (!contract) {
      details.push(`  Could not find contract`);
      continue;
    }

    // Get multi-timeframe data (Tradovate primary, Yahoo fallback via futures-data)
    let bars5min: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    let bars15min: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    let barsDailyRaw: { t: string; o: number; h: number; l: number; c: number; v: number }[] = [];

    try {
      [bars5min, bars15min, barsDailyRaw] = await Promise.all([
        getFuturesIntradayBars(symbol, "5m", "1d"),
        getFuturesIntradayBars(symbol, "15m", "5d"),
        getFuturesDailyBars(symbol, 60),
      ]);
    } catch (err) {
      details.push(`  Data error: ${err}`);
      continue;
    }

    const barsDaily = barsDailyRaw.map((b) => ({ ...b, t: new Date(b.t).getTime() / 1000 }));

    // Need at least some data to trade
    if (bars5min.length < 10 && barsDaily.length < 20) {
      details.push(`  Insufficient data (5min: ${bars5min.length}, daily: ${barsDaily.length})`);
      continue;
    }

    // Use 5min data if available, fall back to daily
    const primaryBars = bars5min.length >= 20 ? bars5min : barsDaily;
    const price = primaryBars[primaryBars.length - 1].c;
    details.push(`  Data: ${bars5min.length} 5min bars, ${bars15min.length} 15min bars, ${barsDaily.length} daily bars`);
    const closes5 = bars5min.map((b) => b.c);
    const closes15 = bars15min.map((b) => b.c);

    // Calculate indicators — VWAP anchored to session open (RTH bars only, DST-aware)
    const rthStartTs = getRTHStartUTC() / 1000;
    const sessionBars = bars5min.filter((b) => b.t >= rthStartTs);
    const vwapData = vwap(sessionBars.length >= 3 ? sessionBars : bars5min.slice(-78));
    const keyLevels = calcKeyLevels(barsDaily, bars5min);
    const currentATR = atr(bars5min);
    const currentRSI = rsi(closes5);

    // 15-min trend for confirmation
    const trend15 = bars15min.length >= 21 ? (ema(closes15, 9).slice(-1)[0] > ema(closes15, 21).slice(-1)[0] ? "up" : "down") : "flat";

    // Day type classification
    const dayClassification = classifyDayType(barsDaily, bars5min, keyLevels);
    const dayType = dayClassification.dayType;

    details.push(`  Price: $${price.toFixed(2)} | VWAP: $${vwapData.vwap.toFixed(2)} [${vwapData.lowerBand.toFixed(2)}-${vwapData.upperBand.toFixed(2)}]`);
    details.push(`  RSI: ${currentRSI?.toFixed(0) || "N/A"} | ATR: ${currentATR.toFixed(2)} | 15m Trend: ${trend15.toUpperCase()}`);
    details.push(`  DAY TYPE: ${dayClassification.reasoning}`);
    details.push(`  Levels: PDH $${keyLevels.prevDayHigh.toFixed(2)} | PDL $${keyLevels.prevDayLow.toFixed(2)} | OR ${keyLevels.openingRangeLow.toFixed(2)}-${keyLevels.openingRangeHigh.toFixed(2)}`);

    // Detect setup
    const setup = detectSetup(price, closes5, bars5min, keyLevels, vwapData, session, regime, dayType, minutesSinceOpen);

    if (setup.type === "none") {
      details.push(`  No setup — holding`);
      continue;
    }

    // 15-min trend confirmation: don't go against the higher timeframe
    if ((setup.direction === "long" && trend15 === "down") || (setup.direction === "short" && trend15 === "up")) {
      // Reduce confidence for counter-trend trades
      setup.confidence -= 20;
      details.push(`  Counter-trend warning: 15m trend is ${trend15}, setup is ${setup.direction}`);
    }

    if (setup.confidence < 60) {
      details.push(`  Setup found (${setup.type}) but pre-AI confidence too low: ${setup.confidence}% — not worth AI call`);
      continue;
    }

    details.push(`  SETUP: ${setup.type.replace(/_/g, " ").toUpperCase()} — ${setup.direction.toUpperCase()} (${setup.confidence}%)`);
    details.push(`  ${setup.reasoning}`);

    // AI confirmation — Opus with extended thinking for decisive, opinionated calls
    let aiConviction = "";
    try {
      const aiPrompt = `You are an elite futures scalper trading a $7K account with up to 6 MES contracts per trade. Every trade risks ~$350. Base limit: 3 trades/day, but A+ setups can override up to 5. Only A+ and A execute — B and C are killed.

CRITICAL CONTEXT: Current win rate is ~30%. We MUST be selective. Only approve trades with clear edge, strong R:R (2:1+), and alignment across timeframes. The math: at 30% WR we need 2.3+ R:R to make money. Kill anything marginal — a skipped trade costs $0, a bad trade costs $350.

${symbol} setup:
Price: $${price.toFixed(2)} | VWAP: $${vwapData.vwap.toFixed(2)} | RSI: ${currentRSI?.toFixed(0)} | ATR: ${currentATR.toFixed(2)}
15m trend: ${trend15} | Session: ${session} | Regime: ${regime} | Day type: ${dayType}
Setup: ${setup.type} — ${setup.direction} — ${setup.reasoning}
Key levels: PDH $${keyLevels.prevDayHigh.toFixed(2)} PDL $${keyLevels.prevDayLow.toFixed(2)}
Stop distance: ${setup.stopDistance.toFixed(2)} pts ($${(setup.stopDistance * contractInfo.multiplier).toFixed(0)}/contract) | Target: ${setup.targetDistance.toFixed(2)} pts | R:R: ${(setup.targetDistance / setup.stopDistance).toFixed(1)}
${vaultContext}

A+ = textbook, high conviction. A = solid edge, clear R:R. B = marginal, will be KILLED. C = no edge, will be KILLED.
Reply ONLY with JSON: {"agree": true/false, "conviction": "A+"|"A"|"B"|"C", "reasoning": "one sentence"}`;

      const response = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 8000,
        thinking: { type: "enabled", budget_tokens: 5000 },
        messages: [{ role: "user", content: aiPrompt }],
      });
      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      // Handle Claude sometimes wrapping JSON in markdown code blocks
      let jsonText = text.trim();
      const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) jsonText = jsonMatch[1].trim();
      const ai = JSON.parse(jsonText);

      if (!ai.agree) {
        setup.confidence -= 30;
        details.push(`  AI KILLS TRADE: ${ai.reasoning}`);
      } else if (ai.conviction === "C") {
        // C-grade = not worth the risk at any WR
        setup.confidence -= 25;
        details.push(`  AI WEAK CONFIRM (C): ${ai.reasoning} — killing, not worth the risk`);
      } else if (ai.conviction === "B") {
        // B-grade = marginal. At sub-35% WR, only A/A+ setups have edge. Kill B.
        setup.confidence -= 15;
        details.push(`  AI MARGINAL (B): ${ai.reasoning} — killing, only A/A+ setups trade`);
      } else {
        // Only A+ and A pass — these are the setups that justify $350 risk
        aiConviction = ai.conviction || "A";
        const convictionBoost = aiConviction === "A+" ? 30 : 20; // A+ or A only
        setup.confidence += convictionBoost;
        details.push(`  AI CONFIRMS (${aiConviction}): ${ai.reasoning} [+${convictionBoost}]`);
      }
    } catch {
      details.push(`  AI unavailable — proceeding on technicals alone`);
    }

    if (setup.confidence < 72) {
      details.push(`  Final confidence ${setup.confidence}% — below 72% threshold, skipping`);
      try { await logDecision("futures-agent", "SKIP", `FUT:${symbol}`, `${setup.type}: Confidence ${setup.confidence}% < 72% threshold. ${setup.reasoning}`, 1); } catch {}
      continue;
    }

    // ============ TRADE COUNT CHECK (A+ override) ============
    // Base limit: 3 trades/day for A/A+ setups
    // A+ override: if past base limit, only A+ can trade (up to hard cap of 5)
    if (atBaseTradeLimit && aiConviction !== "A+") {
      details.push(`  BASE LIMIT HIT (${todayTradeCount}/${FUTURES_RULES.MAX_TRADES_PER_DAY}) — need A+ to override, got ${aiConviction || "no AI grade"}. Paper mode.`);
      // Fall through to paper trade logging below
    }
    const isAplusOverride = atBaseTradeLimit && aiConviction === "A+";
    if (isAplusOverride) {
      details.push(`  A+ OVERRIDE: Past base limit (${todayTradeCount}/${FUTURES_RULES.MAX_TRADES_PER_DAY}) but AI says A+ — allowing trade ${todayTradeCount + 1}/${FUTURES_RULES.MAX_TRADES_APLUS_OVERRIDE}`);
    }

    // ============ POSITION SIZING (equity-based) ============
    const stopDistance = setup.stopDistance;
    const targetDistance = setup.targetDistance;

    // Sanity check: stop and target must be reasonable
    if (stopDistance <= 0 || targetDistance <= 0) {
      details.push(`  Invalid stop/target distance — skipping`);
      continue;
    }
    if (targetDistance / stopDistance < 2.0) {
      details.push(`  R:R too low (${(targetDistance / stopDistance).toFixed(1)}) — need 2.0+ — skipping`);
      continue;
    }

    const riskPerContract = stopDistance * contractInfo.multiplier;

    // Size by risk budget: how many contracts fit within maxRiskPerTrade?
    const maxByRisk = Math.floor(maxRiskPerTrade / riskPerContract);
    let contracts = Math.max(1, Math.min(
      FUTURES_RULES.MAX_CONTRACTS_PER_TRADE,
      maxByRisk,
    ));

    // Hard ceiling: never risk more than 10% on a single trade (absolute safety net)
    const totalRisk = riskPerContract * contracts;
    if (totalRisk > equity * 0.10) {
      contracts = Math.max(1, Math.floor((equity * 0.10) / riskPerContract));
      details.push(`  HARD CAP: Risk $${totalRisk.toFixed(0)} (${((totalRisk / equity) * 100).toFixed(1)}%) exceeds 10% ceiling — capped to ${contracts} contract(s)`);
    }

    const side = setup.direction === "long" ? "BUY" as const : "SELL" as const;
    const stopPrice = setup.direction === "long" ? price - stopDistance : price + stopDistance;
    const targetPrice = setup.direction === "long" ? price + targetDistance : price - targetDistance;
    const riskReward = targetDistance / stopDistance;

    // Per-trade paper mode: base reasons OR hit base limit without A+ override
    const paperTradeMode = paperTradeBase || (atBaseTradeLimit && aiConviction !== "A+");

    details.push(`  ${paperTradeMode ? "PAPER " : ""}TRADE: ${side} ${contracts}x ${symbol} @ $${price.toFixed(2)}`);
    details.push(`  Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R ${riskReward.toFixed(1)} | Risk: $${(riskPerContract * contracts).toFixed(0)}`);

    // ============ PAPER TRADE MODE — LOG FOR LEARNING, DON'T EXECUTE ============
    // The brain tracks these hypothetical trades. The post-market review checks if
    // price hit the target or stop, scoring the setup's accuracy over time.
    // This is how the agent learns 24/7 — even during lunch, overnight, after tilt, after daily limit.
    if (paperTradeMode) {
      details.push(`  PAPER TRADE LOGGED — would have entered ${side} ${contracts}x ${symbol}`);
      const paperReason = `[PAPER] ${setup.type.replace(/_/g, " ").toUpperCase()}: ${side} ${contracts}x @ $${price.toFixed(2)}. Stop: $${stopPrice.toFixed(2)}, Target: $${targetPrice.toFixed(2)}. R:R ${riskReward.toFixed(1)}. Session: ${session}. ${setup.reasoning}`;
      try {
        await prisma.autoTradeLog.create({ data: {
          symbol: `FUT:${symbol}`, action: `paper_${setup.direction}`,
          qty: contracts, price,
          reason: paperReason,
          aiScore: setup.confidence, aiSignal: setup.direction,
        }});
      } catch {}
      try {
        await logDecision("futures-agent", "PAPER", `FUT:${symbol}`, paperReason, setup.confidence);
        await logObservation("futures-agent", `PAPER TRADE: ${side} ${contracts}x ${symbol} @ $${price.toFixed(2)} | Stop $${stopPrice.toFixed(2)} Target $${targetPrice.toFixed(2)} | Session: ${session} | Setup: ${setup.type} | Would check at EOD if target/stop hit`);
        await logTradeToJournal({
          tradeId: `PAPER-${Date.now().toString(36)}`,
          timestamp: new Date().toISOString(),
          instrument: `FUT:${symbol}`,
          direction: setup.direction === "long" ? "LONG" : "SHORT",
          strategy: "futures-scalping",
          setupType: `paper_${setup.type}`,
          contracts,
          entryPrice: price,
          stopPrice,
          targetPrice,
          conviction: setup.confidence,
          lesson: "PAPER — not executed, tracking outcome at EOD",
        }, "futures-agent");
      } catch {}
      continue; // Don't execute — just log and move to next symbol
    }

    // ============ EXECUTE WITH BRACKET ORDER (real trade) ============
    try {
      const order = await placeBracketOrder({
        contractId: contract.id,
        action: side === "BUY" ? "Buy" : "Sell",
        quantity: contracts,
        stopLoss: parseFloat(stopPrice.toFixed(2)),
        takeProfit: parseFloat(targetPrice.toFixed(2)),
      });

      await prisma.autoTradeLog.create({
        data: {
          symbol: `FUT:${symbol}`,
          action: `futures_${setup.direction}`,
          qty: contracts,
          price,
          reason: `[FUTURES ${symbol}] ${setup.type.replace(/_/g, " ").toUpperCase()}: ${side} ${contracts}x @ $${price.toFixed(2)}. Stop: $${stopPrice.toFixed(2)}, Target: $${targetPrice.toFixed(2)}. R:R ${riskReward.toFixed(1)}. Risk: $${(riskPerContract * contracts).toFixed(0)} (${(FUTURES_RULES.RISK_PER_TRADE_PCT * 100).toFixed(1)}% of equity). ${setup.reasoning}`,
          aiScore: setup.confidence,
          aiSignal: setup.direction,
          orderId: String(order.orderId),
        },
      });

      if (order.status === "entry_not_filled") {
        details.push(`  ORDER CANCELLED — entry did not fill within 2s`);
        trades.push({
          symbol, action: setup.direction, contracts, price,
          stopLoss: stopPrice, target: targetPrice,
          reasoning: setup.reasoning, orderId: String(order.orderId), success: false,
        });
        continue;
      }

      trades.push({
        symbol, action: setup.direction, contracts, price,
        stopLoss: stopPrice, target: targetPrice,
        reasoning: setup.reasoning, orderId: String(order.orderId), success: true,
      });

      // Alert if broker stop/target failed
      if (order.warnings?.length) {
        for (const w of order.warnings) {
          details.push(`  WARNING: ${w}`);
        }
        try { await sendNotification(`Bracket warning for ${symbol}: ${order.warnings.join("; ")}`, "futures"); } catch {}
      }

      details.push(`  ORDER PLACED with bracket (stop + target). Order ID: ${order.orderId}`);

      // Log to Obsidian vault
      try {
        await logTradeToJournal({
          tradeId: `${new Date().toISOString().slice(0, 10)}-FUT-${String(order.orderId).slice(-4)}`,
          timestamp: new Date().toISOString(),
          instrument: `FUT:${symbol}`,
          direction: setup.direction === "long" ? "LONG" : "SHORT",
          strategy: "futures-scalping",
          setupType: setup.type,
          contracts,
          entryPrice: price,
          stopPrice,
          targetPrice,
          conviction: Math.round(setup.confidence / 20), // convert 0-100 to 1-5
        }, "futures-agent");

        await logDecision(
          "futures-agent", "ENTRY", `FUT:${symbol}`,
          `${setup.type}: ${setup.reasoning}. R:R ${riskReward.toFixed(1)}, Risk $${(riskPerContract * contracts).toFixed(0)}`,
          Math.round(setup.confidence / 20),
        );

        await logObservation("futures-agent",
          `ENTRY ${side} ${contracts}x ${symbol} @ $${price.toFixed(2)} | Setup: ${setup.type} | Confidence: ${setup.confidence}% | Risk: $${(riskPerContract * contracts).toFixed(0)} | R:R ${riskReward.toFixed(1)} | Regime: ${regime} | Session: ${session}`);
      } catch { /* vault logging optional */ }
    } catch (err) {
      details.push(`  ORDER FAILED: ${err}`);
      trades.push({
        symbol, action: setup.direction, contracts, price,
        stopLoss: stopPrice, target: targetPrice,
        reasoning: `Failed: ${err}`, orderId: null, success: false,
      });
    }
  }

  return { trades, managed, details };
}
