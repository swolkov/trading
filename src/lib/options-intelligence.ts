import { getHistoricalBars } from "./yahoo";

// ============ IV RANK & VOLATILITY ANALYSIS ============
// NOTE: the options-chain/snapshot brokerage feed was removed. Live IV, unusual
// activity and expected-move calculations that need an options chain now return
// no data; HV-based analysis (from Yahoo price history) still works.

// Minimal contract shape retained after the options brokerage feed was removed.
interface OptionsContract {
  symbol: string;
  strike_price: string;
  expiration_date: string;
  type: "call" | "put";
  open_interest?: string;
}

export interface VolatilityAnalysis {
  symbol: string;
  currentIV: number | null;        // from options market
  historicalVolatility20: number;   // 20-day realized vol
  historicalVolatility60: number;   // 60-day realized vol
  ivRank: number;                   // 0-100: where is IV vs its 52-week range
  ivVsHv: "cheap" | "fair" | "expensive"; // IV vs historical vol
  recommendation: string;
}

export async function analyzeVolatility(symbol: string): Promise<VolatilityAnalysis> {
  const bars = await getHistoricalBars(symbol, 365);
  const closes = bars.map((b) => b.c);

  // Calculate Historical Volatility (annualized std dev of daily returns)
  function calcHV(data: number[], period: number): number {
    if (data.length < period + 1) return 0;
    const returns: number[] = [];
    for (let i = data.length - period; i < data.length; i++) {
      returns.push(Math.log(data[i] / data[i - 1]));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    return Math.sqrt(variance * 252); // annualized
  }

  const hv20 = calcHV(closes, 20);
  const hv60 = calcHV(closes, 60);

  // Live IV requires the options-chain feed (removed) — fall back to HV-based
  // IV-rank approximation only.
  const currentIV: number | null = null;

  // Calculate IV Rank approximation
  // Use HV range as proxy for IV range (not perfect, but useful)
  const hvValues: number[] = [];
  for (let i = 30; i < closes.length; i += 5) {
    hvValues.push(calcHV(closes.slice(0, i + 1), 20));
  }
  const hvMin = Math.min(...hvValues);
  const hvMax = Math.max(...hvValues);
  const ivForRank = currentIV || hv20;
  const ivRank = hvMax > hvMin ? Math.round(((ivForRank - hvMin) / (hvMax - hvMin)) * 100) : 50;

  // Compare IV to HV
  const ivHvRatio = currentIV ? currentIV / hv20 : 1;
  const ivVsHv: "cheap" | "fair" | "expensive" =
    ivHvRatio < 0.85 ? "cheap" : ivHvRatio > 1.15 ? "expensive" : "fair";

  let recommendation: string;
  if (ivRank < 25) {
    recommendation = "IV RANK LOW — Options are cheap. GOOD time to BUY calls/puts. Long premium strategies favored.";
  } else if (ivRank < 50) {
    recommendation = "IV RANK MODERATE-LOW — Options are fairly priced. Buying is OK with strong conviction.";
  } else if (ivRank < 75) {
    recommendation = "IV RANK MODERATE-HIGH — Options are getting expensive. Be selective, consider spreads to reduce cost.";
  } else {
    recommendation = "IV RANK HIGH — Options are expensive. AVOID buying naked calls/puts. Sell premium or use spreads.";
  }

  return {
    symbol,
    currentIV,
    historicalVolatility20: hv20,
    historicalVolatility60: hv60,
    ivRank: Math.max(0, Math.min(100, ivRank)),
    ivVsHv,
    recommendation,
  };
}

// ============ UNUSUAL OPTIONS ACTIVITY SCANNER ============

export interface UnusualActivity {
  symbol: string;
  contractSymbol: string;
  type: "call" | "put";
  strike: number;
  expiry: string;
  dte: number;
  volume: number;
  openInterest: number;
  volumeOiRatio: number; // volume / OI — high = unusual
  premium: number;
  totalPremium: number; // volume * premium * 100
  signal: "bullish" | "bearish";
  strength: "normal" | "unusual" | "very_unusual" | "sweep";
}

export async function scanUnusualActivity(_symbols: string[]): Promise<UnusualActivity[]> {
  // Requires an options-chain/snapshot feed (removed with the equities brokerage).
  void _symbols;
  return [];
}

// ============ EXPECTED MOVE CALCULATOR ============

export interface ExpectedMove {
  symbol: string;
  currentPrice: number;
  expectedMovePct: number;
  expectedMoveUp: number;
  expectedMoveDown: number;
  straddle: number; // ATM straddle price
  daysToExpiry: number;
}

export async function calculateExpectedMove(
  _symbol: string,
  _daysOut: number = 7
): Promise<ExpectedMove | null> {
  // Requires an ATM straddle from the options-chain feed (removed).
  void _symbol; void _daysOut;
  return null;
}

// ============ OPTIMAL STRIKE SELECTOR BY TIMEFRAME ============

export interface StrikeRecommendation {
  timeframe: "day" | "week" | "swing" | "position";
  type: "call" | "put";
  strikePrice: number;
  expiry: string;
  dte: number;
  estimatedPremium: number;
  maxRisk: number; // premium * 100
  reasoning: string;
}

export function getOptimalStrikes(
  currentPrice: number,
  direction: "bullish" | "bearish",
  contracts: OptionsContract[],
  snapshots: Record<string, { latestQuote?: { ap: number; bp: number }; latestTrade?: { p: number } }>
): StrikeRecommendation[] {
  const recommendations: StrikeRecommendation[] = [];
  const now = new Date();
  const type = direction === "bullish" ? "call" : "put";

  const typeContracts = contracts.filter((c) => c.type === type);

  // Day trade: ATM, 0-2 DTE
  const dayContracts = typeContracts.filter((c) => {
    const dte = Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const strikeDiff = Math.abs(parseFloat(c.strike_price) - currentPrice) / currentPrice;
    return dte >= 0 && dte <= 2 && strikeDiff < 0.02;
  });
  if (dayContracts.length > 0) {
    const c = dayContracts[0];
    const snap = snapshots[c.symbol];
    const premium = snap?.latestQuote ? (snap.latestQuote.ap + snap.latestQuote.bp) / 2 : snap?.latestTrade?.p || currentPrice * 0.005;
    recommendations.push({
      timeframe: "day",
      type,
      strikePrice: parseFloat(c.strike_price),
      expiry: c.expiration_date,
      dte: Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      estimatedPremium: premium,
      maxRisk: premium * 100,
      reasoning: `Day trade: ATM ${type} for maximum gamma. Fast moves = big gains (or losses). Close same day.`,
    });
  }

  // Weekly: 1-2 strikes OTM, 5-7 DTE
  const weeklyOtmPct = direction === "bullish" ? 0.03 : -0.03;
  const weeklyTarget = currentPrice * (1 + weeklyOtmPct);
  const weeklyContracts = typeContracts.filter((c) => {
    const dte = Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const strikeDiff = Math.abs(parseFloat(c.strike_price) - weeklyTarget);
    return dte >= 4 && dte <= 10 && strikeDiff <= currentPrice * 0.02;
  });
  if (weeklyContracts.length > 0) {
    const c = weeklyContracts[0];
    const snap = snapshots[c.symbol];
    const premium = snap?.latestQuote ? (snap.latestQuote.ap + snap.latestQuote.bp) / 2 : snap?.latestTrade?.p || currentPrice * 0.01;
    recommendations.push({
      timeframe: "week",
      type,
      strikePrice: parseFloat(c.strike_price),
      expiry: c.expiration_date,
      dte: Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      estimatedPremium: premium,
      maxRisk: premium * 100,
      reasoning: `Weekly: Slightly OTM ${type} for leverage. Good for catalyst plays (earnings, news). Target 50-100% gain.`,
    });
  }

  // Swing: 2-4% OTM, 14-30 DTE
  const swingOtmPct = direction === "bullish" ? 0.04 : -0.04;
  const swingTarget = currentPrice * (1 + swingOtmPct);
  const swingContracts = typeContracts.filter((c) => {
    const dte = Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const strikeDiff = Math.abs(parseFloat(c.strike_price) - swingTarget);
    return dte >= 14 && dte <= 30 && strikeDiff <= currentPrice * 0.02;
  });
  if (swingContracts.length > 0) {
    const c = swingContracts[0];
    const snap = snapshots[c.symbol];
    const premium = snap?.latestQuote ? (snap.latestQuote.ap + snap.latestQuote.bp) / 2 : snap?.latestTrade?.p || currentPrice * 0.015;
    recommendations.push({
      timeframe: "swing",
      type,
      strikePrice: parseFloat(c.strike_price),
      expiry: c.expiration_date,
      dte: Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      estimatedPremium: premium,
      maxRisk: premium * 100,
      reasoning: `Swing trade: OTM ${type} with 2-4 weeks to work. Best risk/reward balance. Theta manageable.`,
    });
  }

  // Position: ATM or slightly ITM, 30-60 DTE
  const posContracts = typeContracts.filter((c) => {
    const dte = Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const strikeDiff = Math.abs(parseFloat(c.strike_price) - currentPrice) / currentPrice;
    return dte >= 30 && dte <= 60 && strikeDiff < 0.02;
  });
  if (posContracts.length > 0) {
    const c = posContracts[0];
    const snap = snapshots[c.symbol];
    const premium = snap?.latestQuote ? (snap.latestQuote.ap + snap.latestQuote.bp) / 2 : snap?.latestTrade?.p || currentPrice * 0.03;
    recommendations.push({
      timeframe: "position",
      type,
      strikePrice: parseFloat(c.strike_price),
      expiry: c.expiration_date,
      dte: Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      estimatedPremium: premium,
      maxRisk: premium * 100,
      reasoning: `Position trade: ATM ${type} with 30-60 days. High delta, moves like stock. Slow theta decay. Safest options play.`,
    });
  }

  return recommendations;
}
