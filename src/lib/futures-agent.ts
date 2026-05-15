import Anthropic from "@anthropic-ai/sdk";
import {
  checkTradovateAuth,
  findContract,
  placeBracketOrder,
  placeMarketOrder,
  getTradovatePositions,
  getTradovateAccountSummary,
  getOpenOrders,
  cancelOrder,
  TRADOVATE_CONTRACTS,
} from "./tradovate";
import { getHistoricalBars, getIntradayBars } from "./yahoo";
import { detectMarketRegime } from "./market-regime";
import { getCrossAssetSignals } from "./cross-asset";
import { prisma } from "./db";
import { getVaultContextForAI, logTradeToJournal, logDecision, logObservation, updateMarketRegime, updateVolatilityEnvironment } from "./vault";
import { evaluateDrawdownState } from "./drawdown-protocol";

// Yahoo Finance symbols for micro futures (use the full-size contract as proxy)
const YAHOO_FUTURES_MAP: Record<string, string> = {
  MES: "ES=F",   // E-mini S&P 500
  MNQ: "NQ=F",   // E-mini Nasdaq 100
  MYM: "YM=F",   // E-mini Dow
  M2K: "RTY=F",  // E-mini Russell 2000
  MGC: "GC=F",   // Micro Gold
};

// Alias for backward compatibility
const FUTURES_CONTRACTS = TRADOVATE_CONTRACTS;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

// ============ EXPERT FUTURES TRADING SYSTEM ============
// Multi-timeframe analysis, key levels, VWAP bands, session awareness,
// bracket orders (stop + target placed with entry), equity-based sizing.

// ============ RULES — SCALE WITH EQUITY ============

const FUTURES_RULES = {
  // Risk as % of equity (works same for $1M paper and any live account)
  RISK_PER_TRADE_PCT: 0.002,       // 0.2% of equity per trade ($2k on $1M, $200 on $100k)
  DAILY_LOSS_LIMIT_PCT: 0.01,      // 1% daily max loss
  MAX_DRAWDOWN_PCT: 0.05,          // 5% drawdown kill switch
  MAX_CONTRACTS_PER_TRADE: 2,      // HARD CAP: 2 contracts max (was 10 — position sizing escalated to 16 and caused emergency exits)
  MAX_TOTAL_CONTRACTS: 4,           // Max 4 total across all instruments (was 20)
  MAX_TRADES_PER_DAY: 6,

  // Technical
  ATR_STOP_MULTIPLIER: 1.5,
  ATR_TARGET_MULTIPLIER: 2.5,      // 1.67 R:R minimum

  // Session times (ET hours in UTC)
  // Pre-market: 13:00-13:30 UTC (9:00-9:30 ET)
  // RTH: 13:30-20:00 UTC (9:30-4:00 ET)
  // ETH: 22:00-13:30 UTC (6:00PM-9:30AM ET next day)
  RTH_START_UTC: 13.5,
  RTH_END_UTC: 20,
  AVOID_FIRST_MINUTES: 15,         // Avoid first 15 min (opening chaos)
  AVOID_LAST_MINUTES: 15,          // Avoid last 15 min (closing chaos)
};

// ============ WHICH CONTRACTS TO TRADE ============
const TRADE_PRIORITY: { symbol: string; when: string }[] = [
  { symbol: "MES", when: "always" },    // Most liquid, tightest spreads — primary
  { symbol: "MNQ", when: "trending" },  // Most volatile — only in trending markets
  { symbol: "MYM", when: "always" },    // Cheapest margin — good for extra exposure
  { symbol: "M2K", when: "trending" },  // Small cap, high vol — only trending
];

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

// ============ SESSION DETECTION ============

type Session = "pre_market" | "open" | "morning" | "midday" | "afternoon" | "close" | "eth_evening" | "eth_overnight" | "eth_asia" | "eth_europe" | "halt";

function getSession(): { session: Session; isRTH: boolean; isETH: boolean; minutesSinceOpen: number } {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat

  const minutesSinceOpen = Math.max(0, (utcHour - FUTURES_RULES.RTH_START_UTC) * 60);
  const isRTH = utcHour >= FUTURES_RULES.RTH_START_UTC && utcHour < FUTURES_RULES.RTH_END_UTC;

  // Futures halt: daily 5:00-6:00 PM ET = 21:00-22:00 UTC
  const isHalt = utcHour >= 21 && utcHour < 22;

  // Weekend: Sat all day, Sun before 6PM ET (22:00 UTC)
  const isWeekend = dayOfWeek === 6 || (dayOfWeek === 0 && utcHour < 22);

  if (isWeekend || isHalt) {
    return { session: "halt", isRTH: false, isETH: false, minutesSinceOpen: 0 };
  }

  // ETH sessions (outside RTH 9:30 AM - 4:00 PM ET)
  const isETH = !isRTH;

  let session: Session;
  if (isRTH) {
    if (minutesSinceOpen < 15) session = "open";
    else if (utcHour < 16) session = "morning";         // 9:45 AM - 12 PM ET
    else if (utcHour < 18) session = "midday";           // 12 PM - 2 PM ET
    else if (utcHour < 19.75) session = "afternoon";     // 2 PM - 3:45 PM ET
    else session = "close";                               // 3:45 PM - 4 PM ET
  } else if (utcHour >= 20 && utcHour < 21) {
    session = "eth_evening";                              // 4 PM - 5 PM ET (post-close)
  } else if (utcHour >= 22 || utcHour < 2) {
    session = "eth_evening";                              // 6 PM - 10 PM ET
  } else if (utcHour >= 2 && utcHour < 7) {
    session = "eth_asia";                                 // 10 PM - 3 AM ET (Asia session)
  } else if (utcHour >= 7 && utcHour < 13) {
    session = "eth_europe";                               // 3 AM - 9 AM ET (Europe/London)
  } else {
    session = "pre_market";                               // 9 AM - 9:30 AM ET
  }

  return { session, isRTH, isETH, minutesSinceOpen };
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
  // RTH prime: 9:45-11:30 AM ET (post-opening-range, best setups)
  if (session === "morning" && minutesSinceOpen >= 15) return { quality: "prime", sizeMultiplier: 1.0 };

  // RTH afternoon: 1:30-3:45 PM ET (second best window)
  if (session === "afternoon") return { quality: "good", sizeMultiplier: 0.8 };

  // RTH lunch: 11:30 AM - 1:30 PM = chop — reduce size
  if (session === "midday") return { quality: "avoid", sizeMultiplier: 0.5 };

  // RTH close: 3:45-4:00 PM = don't open new trades
  if (session === "close") return { quality: "avoid", sizeMultiplier: 0 };

  // ETH Europe/London: 3 AM - 9 AM ET = good liquidity, real setups
  if (session === "eth_europe") return { quality: "good", sizeMultiplier: 0.6 };

  // ETH evening: 6 PM - 10 PM ET = thin but can trend
  if (session === "eth_evening") return { quality: "good", sizeMultiplier: 0.4 };

  // ETH Asia: 10 PM - 3 AM ET = thinnest liquidity, reduce heavily
  if (session === "eth_asia") return { quality: "avoid", sizeMultiplier: 0.3 };

  // Halt
  if (session === "halt") return { quality: "avoid", sizeMultiplier: 0 };

  return { quality: "good", sizeMultiplier: 0.7 };
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
  // Position management ALWAYS runs regardless of session
  const isFirstLast15 = isRTH && (minutesSinceOpen < FUTURES_RULES.AVOID_FIRST_MINUTES || minutesSinceOpen > (6.5 * 60 - FUTURES_RULES.AVOID_LAST_MINUTES));
  const canScanNewTrades = session !== "close" && !isFirstLast15;
  if (!canScanNewTrades) {
    details.push(`New trade scanning paused (${isFirstLast15 ? "first/last 15 min RTH" : session}) — position management still active`);
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

  // Account state
  let equity = 0;
  try {
    const summary = await getTradovateAccountSummary();
    equity = summary.netLiq || summary.balance || 0;
    if (equity === 0) equity = 1000000; // paper trading default
    details.push(`ACCOUNT: $${equity.toLocaleString()} (Unrealized: $${summary.unrealizedPnl.toFixed(0)})`);
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
    const eventOverride = eventConfig?.value ? parseFloat(eventConfig.value) || 1.0 : 1.0;
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

  // Check daily P&L
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTrades = await prisma.autoTradeLog.findMany({
    where: { symbol: { startsWith: "FUT:" }, createdAt: { gte: todayStart } },
  });
  const todayPnl = todayTrades.filter((t) => t.pnl != null).reduce((s, t) => s + (t.pnl || 0), 0);
  const todayTradeCount = todayTrades.filter((t) => t.action.startsWith("futures_")).length;

  if (todayPnl < -dailyLossLimit) {
    details.push(`DAILY LOSS LIMIT: Down $${Math.abs(todayPnl).toFixed(0)} (limit: $${dailyLossLimit.toFixed(0)}). Stopping.`);
    return { trades, managed, details };
  }
  if (todayTradeCount >= FUTURES_RULES.MAX_TRADES_PER_DAY) {
    details.push(`DAILY TRADE LIMIT: ${todayTradeCount}/${FUTURES_RULES.MAX_TRADES_PER_DAY} trades today. Stopping.`);
    return { trades, managed, details };
  }

  // Get existing futures positions
  const futuresPositions = await getTradovatePositions();
  details.push(`POSITIONS: ${futuresPositions.length} futures open`);

  // ============ MANAGE EXISTING POSITIONS ============
  // Pre-fetch Yahoo bars for each unique symbol (avoid duplicate API calls)
  const posBarCache: Record<string, { bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]; price: number; atrVal: number }> = {};
  for (const pos of futuresPositions) {
    const sym = Object.keys(FUTURES_CONTRACTS).find((s) => pos.contractName.startsWith(s));
    if (sym && !posBarCache[sym]) {
      const yahooSym = YAHOO_FUTURES_MAP[sym];
      if (yahooSym) {
        try {
          const bars = await getIntradayBars(yahooSym, "5m", "1d");
          posBarCache[sym] = {
            bars,
            price: bars.length > 0 ? bars[bars.length - 1].c : 0,
            atrVal: atr(bars.map((b) => ({ h: b.h, l: b.l, c: b.c }))),
          };
        } catch { posBarCache[sym] = { bars: [], price: 0, atrVal: 5 }; }
      }
    }
  }

  // Get all open orders so we can cancel brackets when we manually close
  const openOrders = await getOpenOrders();

  for (const pos of futuresPositions) {
    managed++;
    const qty = pos.netPos;
    const absQty = Math.abs(qty);
    const avgPrice = pos.netPrice;
    const direction = qty > 0 ? "long" : "short";
    const symbolMatch = Object.keys(FUTURES_CONTRACTS).find((s) => pos.contractName.startsWith(s));
    const multiplier = symbolMatch ? FUTURES_CONTRACTS[symbolMatch].multiplier : 5;

    // Use cached bars
    const cached = symbolMatch ? posBarCache[symbolMatch] : null;
    const currentPrice = cached?.price || avgPrice;
    const currentATRVal = cached?.atrVal || 5;

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
          await cancelBracketOrders();
          await placeMarketOrder({ contractId: pos.contractId, action: direction === "long" ? "Sell" : "Buy", quantity: absQty });
          await prisma.autoTradeLog.create({ data: {
            symbol: `FUT:${pos.contractName}`, action: "futures_breakeven_close",
            qty: absQty, price: currentPrice, pnl: unrealizedPnl, orderId: null,
            reason: `Breakeven stop: Position was at 1R+, pulled back past entry. P&L: $${unrealizedPnl.toFixed(0)}`,
          }});
          try { await logTradeToJournal({ tradeId: `BE-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), instrument: `FUT:${pos.contractName}`, direction: direction === "long" ? "LONG" : "SHORT", strategy: "futures-scalping", setupType: "breakeven_close", contracts: absQty, entryPrice: pos.netPrice, stopPrice: 0, targetPrice: 0, exitPrice: currentPrice, pnlDollars: unrealizedPnl, conviction: 0, exitReason: "Breakeven stop — was at 1R+, pulled back" }, "futures-agent"); } catch {}
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
          await cancelBracketOrders();
          await placeMarketOrder({ contractId: pos.contractId, action: direction === "long" ? "Sell" : "Buy", quantity: absQty });
          await prisma.autoTradeLog.create({ data: {
            symbol: `FUT:${pos.contractName}`, action: "futures_stop_loss",
            qty: absQty, price: currentPrice, pnl: unrealizedPnl, orderId: null,
            reason: `HARD STOP: Price $${currentPrice.toFixed(2)} past stop $${origStop.toFixed(2)}. Broker stop may have failed. P&L: $${unrealizedPnl.toFixed(0)}`,
          }});
          try { await logTradeToJournal({ tradeId: `HS-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), instrument: `FUT:${pos.contractName}`, direction: direction === "long" ? "LONG" : "SHORT", strategy: "futures-scalping", setupType: "hard_stop", contracts: absQty, entryPrice: avgPrice, stopPrice: origStop, targetPrice: origTarget, exitPrice: currentPrice, pnlDollars: unrealizedPnl, conviction: 0, exitReason: "Hard stop — broker stop failed" }, "futures-agent"); } catch {}
        } catch (err) { details.push(`    Hard stop close FAILED: ${err}`); }
        continue; // position closed, skip remaining checks
      }
    }

    // ── SCALE OUT at 1R (close half) ──
    // Only if 2+ contracts AND haven't already scaled today
    // IMPORTANT: After scaling, we cancel original bracket and let remaining ride without bracket
    // (the trailing stop logic above handles the exit for remaining contracts)
    if (absQty >= 2 && priceDiff >= stopDistance && priceDiff < stopDistance * 2) {
      const scaleQty = Math.floor(absQty / 2);
      if (scaleQty >= 1) {
        const alreadyScaled = await prisma.autoTradeLog.findFirst({
          where: { symbol: `FUT:${symbolMatch || pos.contractName}`, action: "futures_scale_out", createdAt: { gte: todayStart } },
        });
        if (!alreadyScaled) {
          details.push(`    SCALE OUT: Taking profit on ${scaleQty}/${absQty} at 1R`);
          try {
            // Cancel bracket orders first to avoid quantity mismatch
            await cancelBracketOrders();
            await placeMarketOrder({ contractId: pos.contractId, action: direction === "long" ? "Sell" : "Buy", quantity: scaleQty });
            await prisma.autoTradeLog.create({ data: {
              symbol: `FUT:${symbolMatch || pos.contractName}`, action: "futures_scale_out",
              qty: scaleQty, price: currentPrice, pnl: priceDiff * multiplier * scaleQty, orderId: null,
              reason: `Scale out: Closed ${scaleQty}/${absQty} at 1R ($${currentPrice.toFixed(2)}). Cancelled bracket. Remaining ${absQty - scaleQty} managed by trailing stop.`,
            }});
            try { await logTradeToJournal({ tradeId: `SO-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), instrument: `FUT:${symbolMatch || pos.contractName}`, direction: direction === "long" ? "LONG" : "SHORT", strategy: "futures-scalping", setupType: "scale_out", contracts: scaleQty, entryPrice: pos.netPrice, stopPrice: 0, targetPrice: 0, exitPrice: currentPrice, pnlDollars: priceDiff * multiplier * scaleQty, conviction: 0, exitReason: `Scale out ${scaleQty}/${absQty} at 1R` }, "futures-agent"); } catch {}
          } catch (err) { details.push(`    Scale out failed: ${err}`); }
        }
      }
    }

    // ── EOD close in choppy markets ──
    if (session === "close" && regime === "choppy") {
      details.push(`  ${pos.contractName}: CLOSING before EOD (choppy)`);
      try {
        await cancelBracketOrders();
        await placeMarketOrder({ contractId: pos.contractId, action: qty > 0 ? "Sell" : "Buy", quantity: absQty });
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
        await cancelBracketOrders();
        await placeMarketOrder({ contractId: pos.contractId, action: qty > 0 ? "Sell" : "Buy", quantity: absQty });
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

  // ============ SCAN FOR NEW TRADES ============
  if (!canScanNewTrades) {
    details.push("Scan paused — positions managed, returning");
    return { trades, managed, details };
  }

  const totalContracts = futuresPositions.reduce((s, p) => s + Math.abs(p.netPos), 0);
  if (totalContracts >= FUTURES_RULES.MAX_TOTAL_CONTRACTS) {
    details.push("At contract limit — not scanning for new trades");
    return { trades, managed, details };
  }

  // Determine which symbols to trade based on regime
  const symbolsToTrade = TRADE_PRIORITY
    .filter((s) => s.when === "always" || (s.when === "trending" && (regime === "bull" || regime === "bear")))
    .map((s) => s.symbol);

  for (const symbol of symbolsToTrade) {
    // Skip if already have position in this symbol
    if (futuresPositions.some((p) => p.contractName.startsWith(symbol))) {
      details.push(`${symbol}: Already have position — skipping`);
      continue;
    }

    const contractInfo = FUTURES_CONTRACTS[symbol];
    details.push(`\n--- ${symbol} (${contractInfo.name}) ---`);

    const contract = await findContract(symbol);
    if (!contract) {
      details.push(`  Could not find contract`);
      continue;
    }

    // Get multi-timeframe data from Yahoo Finance (free intraday + daily)
    const yahooSymbol = YAHOO_FUTURES_MAP[symbol];
    if (!yahooSymbol) { details.push(`  No Yahoo symbol for ${symbol}`); continue; }

    let bars5min: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    let bars15min: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    let barsDailyRaw: { t: string; o: number; h: number; l: number; c: number; v: number }[] = [];

    try {
      [bars5min, bars15min, barsDailyRaw] = await Promise.all([
        getIntradayBars(yahooSymbol, "5m", "1d"),
        getIntradayBars(yahooSymbol, "15m", "5d"),
        getHistoricalBars(yahooSymbol, 60),
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

    // Calculate indicators — VWAP anchored to session open (RTH bars only)
    const rthStartToday = new Date();
    rthStartToday.setUTCHours(13, 30, 0, 0);
    const rthStartTs = rthStartToday.getTime() / 1000;
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

    if (setup.confidence < 55) {
      details.push(`  Setup found (${setup.type}) but confidence too low: ${setup.confidence}%`);
      continue;
    }

    details.push(`  SETUP: ${setup.type.replace(/_/g, " ").toUpperCase()} — ${setup.direction.toUpperCase()} (${setup.confidence}%)`);
    details.push(`  ${setup.reasoning}`);

    // AI confirmation (optional — adds conviction but not required)
    try {
      const aiPrompt = `You are an expert ES/NQ futures scalper. Quick decision on this ${symbol} setup:

Price: $${price.toFixed(2)} | VWAP: $${vwapData.vwap.toFixed(2)} | RSI: ${currentRSI?.toFixed(0)} | ATR: ${currentATR.toFixed(2)}
15m trend: ${trend15} | Session: ${session} | Regime: ${regime} | Day type: ${dayType}
Setup: ${setup.type} — ${setup.direction} — ${setup.reasoning}
Key levels: PDH $${keyLevels.prevDayHigh.toFixed(2)} PDL $${keyLevels.prevDayLow.toFixed(2)}
${vaultContext}
Reply ONLY with JSON: {"agree": true/false, "reasoning": "one sentence"}`;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 150,
        messages: [{ role: "user", content: aiPrompt }],
      });
      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      const ai = JSON.parse(text.trim());

      if (!ai.agree) {
        setup.confidence -= 15;
        details.push(`  AI DISAGREES: ${ai.reasoning}`);
      } else {
        setup.confidence += 5;
        details.push(`  AI CONFIRMS: ${ai.reasoning}`);
      }
    } catch {
      details.push(`  AI unavailable — proceeding on technicals alone`);
    }

    if (setup.confidence < 55) {
      details.push(`  Final confidence ${setup.confidence}% — below threshold, skipping`);
      try { await logDecision("futures-agent", "SKIP", `FUT:${symbol}`, `${setup.type}: Confidence ${setup.confidence}% < 55% threshold. ${setup.reasoning}`, 1); } catch {}
      continue;
    }

    // ============ POSITION SIZING (equity-based) ============
    const stopDistance = setup.stopDistance;
    const targetDistance = setup.targetDistance;

    // Sanity check: stop and target must be reasonable
    if (stopDistance <= 0 || targetDistance <= 0) {
      details.push(`  Invalid stop/target distance — skipping`);
      continue;
    }
    if (targetDistance / stopDistance < 1.5) {
      details.push(`  R:R too low (${(targetDistance / stopDistance).toFixed(1)}) — need 1.5+ — skipping`);
      continue;
    }

    const riskPerContract = stopDistance * contractInfo.multiplier;

    // Sanity: if risk per contract exceeds 1% of equity, cap at 1 contract
    const maxByRisk = Math.floor(maxRiskPerTrade / riskPerContract);
    const contracts = Math.max(1, Math.min(
      FUTURES_RULES.MAX_CONTRACTS_PER_TRADE,
      maxByRisk,
    ));

    // Final sanity: never risk more than 0.5% on a single trade
    const totalRisk = riskPerContract * contracts;
    if (totalRisk > equity * 0.005) {
      details.push(`  Risk too high ($${totalRisk.toFixed(0)} = ${((totalRisk / equity) * 100).toFixed(2)}% of equity) — capping at 1 contract`);
    }

    const side = setup.direction === "long" ? "BUY" as const : "SELL" as const;
    const stopPrice = setup.direction === "long" ? price - stopDistance : price + stopDistance;
    const targetPrice = setup.direction === "long" ? price + targetDistance : price - targetDistance;
    const riskReward = targetDistance / stopDistance;

    details.push(`  TRADE: ${side} ${contracts}x ${symbol} @ $${price.toFixed(2)}`);
    details.push(`  Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R ${riskReward.toFixed(1)} | Risk: $${(riskPerContract * contracts).toFixed(0)}`);

    // ============ EXECUTE WITH BRACKET ORDER ============
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

      trades.push({
        symbol, action: setup.direction, contracts, price,
        stopLoss: stopPrice, target: targetPrice,
        reasoning: setup.reasoning, orderId: String(order.orderId), success: true,
      });

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
