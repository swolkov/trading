import Anthropic from "@anthropic-ai/sdk";
import {
  checkAuth,
  searchFuturesContract,
  getFuturesSnapshot,
  getFuturesBars,
  placeBracketOrder,
  placeFuturesOrder,
  getIBKRPositions,
  getIBKRAccountSummary,
  FUTURES_CONTRACTS,
} from "./ibkr";
import { detectMarketRegime } from "./market-regime";
import { getCrossAssetSignals } from "./cross-asset";
import { prisma } from "./db";

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
  MAX_CONTRACTS_PER_TRADE: 10,
  MAX_TOTAL_CONTRACTS: 20,
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

function sma(data: number[], period: number): number | null {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
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

type Session = "pre_market" | "open" | "morning" | "midday" | "afternoon" | "close" | "after_hours";

function getSession(): { session: Session; isRTH: boolean; minutesSinceOpen: number } {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;

  const minutesSinceOpen = Math.max(0, (utcHour - FUTURES_RULES.RTH_START_UTC) * 60);
  const isRTH = utcHour >= FUTURES_RULES.RTH_START_UTC && utcHour < FUTURES_RULES.RTH_END_UTC;

  let session: Session;
  if (utcHour < 13) session = "after_hours";
  else if (utcHour < 13.5) session = "pre_market";
  else if (minutesSinceOpen < 15) session = "open";
  else if (utcHour < 16) session = "morning";       // 9:45 AM - 12 PM ET
  else if (utcHour < 18) session = "midday";         // 12 PM - 2 PM ET
  else if (utcHour < 19.75) session = "afternoon";   // 2 PM - 3:45 PM ET
  else if (utcHour < 20) session = "close";          // 3:45 PM - 4 PM ET
  else session = "after_hours";

  return { session, isRTH, minutesSinceOpen };
}

// ============ SETUP DETECTION ============

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
  confidence: number;   // 0-100
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
  regime: string
): Setup {
  const currentRSI = rsi(closes) || 50;
  const emaFast = ema(closes, 9);
  const emaSlow = ema(closes, 21);
  const currentATR = atr(bars);
  const avgVolume = bars.length >= 20 ? bars.slice(-20).reduce((s, b) => s + b.v, 0) / 20 : 0;
  const currentVolume = bars[bars.length - 1]?.v || 0;
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  const fastEMA = emaFast[emaFast.length - 1];
  const slowEMA = emaSlow[emaSlow.length - 1];
  const prevFastEMA = emaFast[emaFast.length - 2];
  const prevSlowEMA = emaSlow[emaSlow.length - 2];

  // === SETUP 1: OPENING RANGE BREAKOUT (first 30 min only) ===
  if (session === "morning" && levels.openingRangeHigh > 0) {
    if (price > levels.openingRangeHigh && volumeRatio > 1.2) {
      return {
        type: "opening_range_breakout", direction: "long", confidence: 75,
        reasoning: `Broke above opening range high ($${levels.openingRangeHigh.toFixed(2)}) with ${volumeRatio.toFixed(1)}x volume`,
        stopDistance: currentATR * 1.5,
        targetDistance: (price - levels.openingRangeLow) * 1.5, // 1.5x the range
      };
    }
    if (price < levels.openingRangeLow && volumeRatio > 1.2) {
      return {
        type: "opening_range_breakout", direction: "short", confidence: 75,
        reasoning: `Broke below opening range low ($${levels.openingRangeLow.toFixed(2)}) with ${volumeRatio.toFixed(1)}x volume`,
        stopDistance: currentATR * 1.5,
        targetDistance: (levels.openingRangeHigh - price) * 1.5,
      };
    }
  }

  // === SETUP 2: VWAP MEAN REVERSION (midday range-bound) ===
  if ((session === "midday" || session === "afternoon") && regime !== "bull" && regime !== "bear") {
    // Price at upper VWAP band + overbought RSI → short back to VWAP
    if (price > vwapData.upperBand && currentRSI > 70) {
      return {
        type: "vwap_mean_reversion", direction: "short", confidence: 70,
        reasoning: `Price at VWAP upper band ($${vwapData.upperBand.toFixed(2)}) + RSI ${currentRSI.toFixed(0)} overbought → fade to VWAP`,
        stopDistance: currentATR * 1.5,
        targetDistance: price - vwapData.vwap,
      };
    }
    // Price at lower VWAP band + oversold RSI → long back to VWAP
    if (price < vwapData.lowerBand && currentRSI < 30) {
      return {
        type: "vwap_mean_reversion", direction: "long", confidence: 70,
        reasoning: `Price at VWAP lower band ($${vwapData.lowerBand.toFixed(2)}) + RSI ${currentRSI.toFixed(0)} oversold → bounce to VWAP`,
        stopDistance: currentATR * 1.5,
        targetDistance: vwapData.vwap - price,
      };
    }
  }

  // === SETUP 3: TREND CONTINUATION (trending markets) ===
  if (regime === "bull" || regime === "bear") {
    const isTrendUp = fastEMA > slowEMA && price > fastEMA;
    const isTrendDown = fastEMA < slowEMA && price < fastEMA;

    // Pullback to EMA in uptrend → long
    if (isTrendUp && price <= fastEMA * 1.001 && price >= slowEMA && currentRSI > 40 && currentRSI < 60) {
      return {
        type: "trend_continuation", direction: "long", confidence: 80,
        reasoning: `Uptrend pullback to EMA9 ($${fastEMA.toFixed(2)}). Trend intact, RSI ${currentRSI.toFixed(0)} neutral`,
        stopDistance: currentATR * 1.5,
        targetDistance: currentATR * 3.0, // wider target in trending market
      };
    }
    // Pullback to EMA in downtrend → short
    if (isTrendDown && price >= fastEMA * 0.999 && price <= slowEMA && currentRSI > 40 && currentRSI < 60) {
      return {
        type: "trend_continuation", direction: "short", confidence: 80,
        reasoning: `Downtrend pullback to EMA9 ($${fastEMA.toFixed(2)}). Trend intact, RSI ${currentRSI.toFixed(0)} neutral`,
        stopDistance: currentATR * 1.5,
        targetDistance: currentATR * 3.0,
      };
    }
  }

  // === SETUP 4: KEY LEVEL BOUNCE ===
  if (levels.prevDayHigh > 0) {
    const nearPrevHigh = Math.abs(price - levels.prevDayHigh) / price < 0.001;
    const nearPrevLow = Math.abs(price - levels.prevDayLow) / price < 0.001;

    if (nearPrevLow && currentRSI < 35) {
      return {
        type: "key_level_bounce", direction: "long", confidence: 65,
        reasoning: `Bouncing off previous day low ($${levels.prevDayLow.toFixed(2)}) + RSI ${currentRSI.toFixed(0)} oversold`,
        stopDistance: currentATR * 2.0,
        targetDistance: currentATR * 2.5,
      };
    }
    if (nearPrevHigh && currentRSI > 65) {
      return {
        type: "key_level_bounce", direction: "short", confidence: 65,
        reasoning: `Rejecting previous day high ($${levels.prevDayHigh.toFixed(2)}) + RSI ${currentRSI.toFixed(0)} overbought`,
        stopDistance: currentATR * 2.0,
        targetDistance: currentATR * 2.5,
      };
    }
  }

  // === SETUP 5: EMA CROSSOVER (fallback — lowest priority) ===
  const isBullishCross = prevFastEMA <= prevSlowEMA && fastEMA > slowEMA;
  const isBearishCross = prevFastEMA >= prevSlowEMA && fastEMA < slowEMA;

  if (isBullishCross && price > vwapData.vwap && volumeRatio > 1.0) {
    return {
      type: "ema_crossover", direction: "long", confidence: 60,
      reasoning: `EMA9 crossed above EMA21, price above VWAP ($${vwapData.vwap.toFixed(2)})`,
      stopDistance: currentATR * FUTURES_RULES.ATR_STOP_MULTIPLIER,
      targetDistance: currentATR * FUTURES_RULES.ATR_TARGET_MULTIPLIER,
    };
  }
  if (isBearishCross && price < vwapData.vwap && volumeRatio > 1.0) {
    return {
      type: "ema_crossover", direction: "short", confidence: 60,
      reasoning: `EMA9 crossed below EMA21, price below VWAP ($${vwapData.vwap.toFixed(2)})`,
      stopDistance: currentATR * FUTURES_RULES.ATR_STOP_MULTIPLIER,
      targetDistance: currentATR * FUTURES_RULES.ATR_TARGET_MULTIPLIER,
    };
  }

  return { type: "none", direction: "long", confidence: 0, reasoning: "No setup", stopDistance: 0, targetDistance: 0 };
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

  // Check IBKR connection
  const auth = await checkAuth();
  if (!auth.authenticated) {
    details.push("IBKR not authenticated — cannot trade futures");
    return { trades, managed, details };
  }

  // Session check
  const { session, isRTH, minutesSinceOpen } = getSession();
  details.push(`SESSION: ${session.replace(/_/g, " ").toUpperCase()} | RTH: ${isRTH ? "YES" : "NO"} | ${minutesSinceOpen.toFixed(0)} min since open`);

  // Avoid first/last 15 min of RTH
  if (isRTH && minutesSinceOpen < FUTURES_RULES.AVOID_FIRST_MINUTES) {
    details.push("Skipping — first 15 min after open (too choppy)");
    return { trades, managed, details };
  }
  if (isRTH && minutesSinceOpen > (6.5 * 60 - FUTURES_RULES.AVOID_LAST_MINUTES)) {
    details.push("Skipping — last 15 min before close");
    return { trades, managed, details };
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

  // Macro context
  let macroContext = "";
  try {
    const signals = await getCrossAssetSignals();
    macroContext = `VIX: ${signals.vix.toFixed(1)} (${signals.vixSignal}) | Macro: ${signals.macroSignal}`;
    details.push(`MACRO: ${macroContext}`);
  } catch { /* ignore */ }

  // Account state
  let equity = 0;
  try {
    const summary = await getIBKRAccountSummary();
    equity = parseFloat(summary?.netliquidation?.amount || summary?.equity || "0");
    if (equity === 0) equity = 1000000; // paper trading default
    details.push(`ACCOUNT: $${equity.toLocaleString()}`);
  } catch (err) {
    details.push(`Account error: ${err}`);
    return { trades, managed, details };
  }

  // Calculate risk limits based on equity
  const maxRiskPerTrade = equity * FUTURES_RULES.RISK_PER_TRADE_PCT;
  const dailyLossLimit = equity * FUTURES_RULES.DAILY_LOSS_LIMIT_PCT;
  details.push(`RISK: $${maxRiskPerTrade.toFixed(0)} per trade | $${dailyLossLimit.toFixed(0)} daily limit`);

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
  const positions = await getIBKRPositions();
  const futuresPositions = positions.filter((p) => p.assetClass === "FUT");
  details.push(`POSITIONS: ${futuresPositions.length} futures open`);

  // ============ MANAGE EXISTING POSITIONS ============
  for (const pos of futuresPositions) {
    managed++;
    const unrealizedPnl = parseFloat(pos.unrealizedPnl || "0");
    const avgPrice = parseFloat(pos.avgCost || pos.avgPrice || "0");
    const mktPrice = parseFloat(pos.mktPrice || "0");
    const qty = parseInt(pos.position || pos.pos || "0");

    // Bracket orders handle stop/target automatically via IBKR.
    // We only intervene here for time-based or session-based exits.

    // Close all positions before market close (don't hold overnight unless strong trend)
    if (session === "close" && regime === "choppy") {
      details.push(`  ${pos.contractDesc || pos.symbol}: CLOSING before market close (choppy, not holding overnight)`);
      try {
        await placeFuturesOrder({
          conid: pos.conid,
          side: qty > 0 ? "SELL" : "BUY",
          quantity: Math.abs(qty),
          orderType: "MKT",
          tif: "IOC",
        });
        await prisma.autoTradeLog.create({
          data: {
            symbol: `FUT:${pos.contractDesc || pos.symbol}`,
            action: "futures_session_close",
            qty: Math.abs(qty),
            price: mktPrice,
            reason: `Session close: closing before EOD in choppy market. P&L: $${unrealizedPnl.toFixed(2)}`,
            pnl: unrealizedPnl,
            orderId: null,
          },
        });
      } catch (err) { details.push(`  Failed to close: ${err}`); }
      continue;
    }

    // Emergency stop: if somehow P&L exceeds 2x max risk (bracket order didn't trigger)
    if (unrealizedPnl < -maxRiskPerTrade * 2) {
      details.push(`  ${pos.contractDesc || pos.symbol}: EMERGENCY STOP — down $${Math.abs(unrealizedPnl).toFixed(2)} (>2x max risk)`);
      try {
        await placeFuturesOrder({
          conid: pos.conid,
          side: qty > 0 ? "SELL" : "BUY",
          quantity: Math.abs(qty),
          orderType: "MKT",
          tif: "IOC",
        });
      } catch (err) { details.push(`  Failed to close: ${err}`); }
      continue;
    }

    details.push(`  ${pos.contractDesc || pos.symbol}: ${qty > 0 ? "LONG" : "SHORT"} ${Math.abs(qty)}x @ $${avgPrice.toFixed(2)} | Mkt: $${mktPrice.toFixed(2)} | P&L: $${unrealizedPnl.toFixed(2)}`);
  }

  // ============ SCAN FOR NEW TRADES ============
  const totalContracts = futuresPositions.reduce((s, p) => s + Math.abs(parseInt(p.position || p.pos || "0")), 0);
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
    if (futuresPositions.some((p) => (p.contractDesc || "").includes(symbol))) {
      details.push(`${symbol}: Already have position — skipping`);
      continue;
    }

    const contractInfo = FUTURES_CONTRACTS[symbol];
    details.push(`\n--- ${symbol} (${contractInfo.name}) ---`);

    const contract = await searchFuturesContract(symbol);
    if (!contract) {
      details.push(`  Could not find contract`);
      continue;
    }

    // Get multi-timeframe data
    let bars5min: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    let bars15min: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    let barsDaily: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    let snapshot: { last: number; bid: number; ask: number };

    try {
      [bars5min, bars15min, barsDaily, snapshot] = await Promise.all([
        getFuturesBars(contract.conid, "1d", "5min"),
        getFuturesBars(contract.conid, "3d", "15min"),
        getFuturesBars(contract.conid, "1m", "1d"),
        getFuturesSnapshot(contract.conid),
      ]);
    } catch (err) {
      details.push(`  Data error: ${err}`);
      continue;
    }

    if (!snapshot.last || bars5min.length < 30) {
      details.push(`  Insufficient data (${bars5min.length} bars)`);
      continue;
    }

    const price = snapshot.last;
    const closes5 = bars5min.map((b) => b.c);
    const closes15 = bars15min.map((b) => b.c);

    // Calculate indicators
    const vwapData = vwap(bars5min.slice(-78)); // today's session
    const keyLevels = calcKeyLevels(barsDaily, bars5min);
    const currentATR = atr(bars5min);
    const currentRSI = rsi(closes5);

    // 15-min trend for confirmation
    const trend15 = bars15min.length >= 21 ? (ema(closes15, 9).slice(-1)[0] > ema(closes15, 21).slice(-1)[0] ? "up" : "down") : "flat";

    details.push(`  Price: $${price.toFixed(2)} | VWAP: $${vwapData.vwap.toFixed(2)} [${vwapData.lowerBand.toFixed(2)}-${vwapData.upperBand.toFixed(2)}]`);
    details.push(`  RSI: ${currentRSI?.toFixed(0) || "N/A"} | ATR: ${currentATR.toFixed(2)} | 15m Trend: ${trend15.toUpperCase()}`);
    details.push(`  Levels: PDH $${keyLevels.prevDayHigh.toFixed(2)} | PDL $${keyLevels.prevDayLow.toFixed(2)} | OR ${keyLevels.openingRangeLow.toFixed(2)}-${keyLevels.openingRangeHigh.toFixed(2)}`);

    // Detect setup
    const setup = detectSetup(price, closes5, bars5min, keyLevels, vwapData, session, regime);

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
15m trend: ${trend15} | Session: ${session} | Regime: ${regime}
Setup: ${setup.type} — ${setup.direction} — ${setup.reasoning}
Key levels: PDH $${keyLevels.prevDayHigh.toFixed(2)} PDL $${keyLevels.prevDayLow.toFixed(2)}

Reply ONLY with JSON: {"agree": true/false, "reasoning": "one sentence"}`;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
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
      continue;
    }

    // ============ POSITION SIZING (equity-based) ============
    const stopDistance = setup.stopDistance;
    const targetDistance = setup.targetDistance;
    const riskPerContract = stopDistance * contractInfo.multiplier;
    const contracts = Math.max(1, Math.min(
      FUTURES_RULES.MAX_CONTRACTS_PER_TRADE,
      Math.floor(maxRiskPerTrade / riskPerContract)
    ));

    const side = setup.direction === "long" ? "BUY" as const : "SELL" as const;
    const stopPrice = setup.direction === "long" ? price - stopDistance : price + stopDistance;
    const targetPrice = setup.direction === "long" ? price + targetDistance : price - targetDistance;
    const riskReward = targetDistance / stopDistance;

    details.push(`  TRADE: ${side} ${contracts}x ${symbol} @ $${price.toFixed(2)}`);
    details.push(`  Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R ${riskReward.toFixed(1)} | Risk: $${(riskPerContract * contracts).toFixed(0)}`);

    // ============ EXECUTE WITH BRACKET ORDER ============
    try {
      const order = await placeBracketOrder({
        conid: contract.conid,
        side,
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
          orderId: order.orderId,
        },
      });

      trades.push({
        symbol, action: setup.direction, contracts, price,
        stopLoss: stopPrice, target: targetPrice,
        reasoning: setup.reasoning, orderId: order.orderId, success: true,
      });

      details.push(`  ORDER PLACED with bracket (stop + target). Order ID: ${order.orderId}`);
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
