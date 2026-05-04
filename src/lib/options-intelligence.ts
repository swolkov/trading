import { getHistoricalBars } from "./yahoo";
import { getOptionsChain, getOptionsSnapshots, type OptionsContract } from "./alpaca";

// ============ IV RANK & VOLATILITY ANALYSIS ============

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

  // Calculate IV Rank: get current IV from options, compare to HV range over last year
  // We approximate IV rank by comparing current ATM option IV to historical volatility range
  let currentIV: number | null = null;
  try {
    const contracts = await getOptionsChain(symbol, undefined, "call");
    const currentPrice = closes[closes.length - 1];

    // Find ATM contracts expiring in 2-4 weeks
    const now = new Date();
    const atmContracts = contracts.filter((c) => {
      const strike = parseFloat(c.strike_price);
      const expDate = new Date(c.expiration_date);
      const dte = Math.floor((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return Math.abs(strike - currentPrice) / currentPrice < 0.03 && dte >= 14 && dte <= 30;
    });

    if (atmContracts.length > 0) {
      const snapshots = await getOptionsSnapshots(atmContracts.slice(0, 3).map((c) => c.symbol));
      const ivValues = Object.values(snapshots)
        .filter((s) => s.impliedVolatility && s.impliedVolatility > 0)
        .map((s) => s.impliedVolatility as number);
      if (ivValues.length > 0) {
        currentIV = ivValues.reduce((a, b) => a + b, 0) / ivValues.length;
      }
    }
  } catch {
    // IV not available
  }

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

export async function scanUnusualActivity(symbols: string[]): Promise<UnusualActivity[]> {
  const results: UnusualActivity[] = [];
  const now = new Date();

  for (const symbol of symbols.slice(0, 10)) { // limit to prevent rate limiting
    try {
      const contracts = await getOptionsChain(symbol);

      // Filter to contracts with decent liquidity (14-45 DTE)
      const relevant = contracts.filter((c) => {
        const expDate = new Date(c.expiration_date);
        const dte = Math.floor((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        return dte >= 7 && dte <= 45;
      });

      if (relevant.length === 0) continue;

      // Get snapshots for volume data
      const batchSize = 30;
      for (let i = 0; i < relevant.length; i += batchSize) {
        const batch = relevant.slice(i, i + batchSize);
        try {
          const snapshots = await getOptionsSnapshots(batch.map((c) => c.symbol));

          for (const contract of batch) {
            const snap = snapshots[contract.symbol];
            if (!snap) continue;

            const volume = snap.latestTrade ? 1 : 0; // approximate
            const oi = parseInt(contract.open_interest || "0");
            const premium = snap.latestQuote
              ? (snap.latestQuote.ap + snap.latestQuote.bp) / 2
              : snap.latestTrade?.p || 0;

            if (oi > 100 && premium > 0.5) {
              const strike = parseFloat(contract.strike_price);
              const expDate = new Date(contract.expiration_date);
              const dte = Math.floor((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
              const volumeOiRatio = oi > 0 ? volume / oi : 0;

              // Only flag if there's meaningful activity
              if (premium * 100 > 50) { // at least $50 per contract
                results.push({
                  symbol,
                  contractSymbol: contract.symbol,
                  type: contract.type,
                  strike,
                  expiry: contract.expiration_date,
                  dte,
                  volume,
                  openInterest: oi,
                  volumeOiRatio,
                  premium,
                  totalPremium: premium * 100,
                  signal: contract.type === "call" ? "bullish" : "bearish",
                  strength: volumeOiRatio > 3 ? "sweep" : volumeOiRatio > 2 ? "very_unusual" : volumeOiRatio > 1 ? "unusual" : "normal",
                });
              }
            }
          }
        } catch {
          // batch failed, continue
        }
      }
    } catch {
      // symbol failed, continue
    }
  }

  // Sort by total premium (biggest bets first)
  results.sort((a, b) => b.totalPremium - a.totalPremium);
  return results.slice(0, 20);
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
  symbol: string,
  daysOut: number = 7
): Promise<ExpectedMove | null> {
  try {
    const bars = await getHistoricalBars(symbol, 30);
    if (bars.length === 0) return null;
    const currentPrice = bars[bars.length - 1].c;

    // Find ATM straddle (call + put at closest strike)
    const contracts = await getOptionsChain(symbol);
    const now = new Date();
    const targetExpiry = new Date(now.getTime() + daysOut * 24 * 60 * 60 * 1000);

    // Find contracts near target expiry and ATM
    const nearExpiry = contracts.filter((c) => {
      const expDate = new Date(c.expiration_date);
      const daysDiff = Math.abs((expDate.getTime() - targetExpiry.getTime()) / (1000 * 60 * 60 * 24));
      const strikeDiff = Math.abs(parseFloat(c.strike_price) - currentPrice) / currentPrice;
      return daysDiff <= 3 && strikeDiff < 0.02;
    });

    const atmCall = nearExpiry.find((c) => c.type === "call");
    const atmPut = nearExpiry.find((c) => c.type === "put");

    if (!atmCall && !atmPut) return null;

    // Get prices
    const contractSymbols = [atmCall?.symbol, atmPut?.symbol].filter(Boolean) as string[];
    const snapshots = await getOptionsSnapshots(contractSymbols);

    let callPrice = 0;
    let putPrice = 0;
    if (atmCall && snapshots[atmCall.symbol]?.latestQuote) {
      const q = snapshots[atmCall.symbol].latestQuote;
      callPrice = (q.ap + q.bp) / 2;
    }
    if (atmPut && snapshots[atmPut.symbol]?.latestQuote) {
      const q = snapshots[atmPut.symbol].latestQuote;
      putPrice = (q.ap + q.bp) / 2;
    }

    const straddle = callPrice + putPrice;
    const expectedMovePct = straddle / currentPrice;

    const dte = atmCall
      ? Math.floor((new Date(atmCall.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      : daysOut;

    return {
      symbol,
      currentPrice,
      expectedMovePct,
      expectedMoveUp: currentPrice * (1 + expectedMovePct),
      expectedMoveDown: currentPrice * (1 - expectedMovePct),
      straddle,
      daysToExpiry: dte,
    };
  } catch {
    return null;
  }
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
