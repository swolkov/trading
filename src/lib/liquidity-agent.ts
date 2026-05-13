import { getQuote, getOptionsChain, getOptionsSnapshots, type OptionsContract, type OptionsSnapshot } from "./alpaca";

// ============ LIQUIDITY AGENT ============
// Pre-trade liquidity scoring. Rejects illiquid setups BEFORE entry.
// Also warns about exit liquidity — can you actually close this position?
// Eliminates the #1 retail trader mistake: trading illiquid options.

export interface LiquidityScore {
  symbol: string;
  score: number; // 0-100 (0 = completely illiquid, 100 = deep book)
  grade: "A" | "B" | "C" | "D" | "F";
  tradeable: boolean; // hard pass/fail
  metrics: {
    bidAskSpread: number;
    bidAskSpreadPct: number;
    bidSize: number;
    askSize: number;
    openInterest: number | null;
    volume: number | null;
    midPrice: number;
  };
  warnings: string[];
  recommendation: string;
}

// Hard limits — below these, reject the trade
const HARD_LIMITS = {
  MIN_BID: 0.05, // option must have at least $0.05 bid
  MAX_SPREAD_PCT_OPTIONS: 15, // 15% max spread for options
  MAX_SPREAD_PCT_EQUITY: 1, // 1% max spread for equities
  MIN_OPEN_INTEREST: 10, // minimum 10 OI for options
  MIN_OPTION_VOLUME: 5, // minimum 5 contracts traded today
};

// Scoring weights
const WEIGHTS = {
  spreadScore: 40, // tighter spread = higher score
  depthScore: 20, // larger bid/ask sizes = higher score
  oiScore: 25, // more open interest = higher score
  volumeScore: 15, // more volume = higher score
};

export async function scoreLiquidity(
  symbol: string,
  isOptions: boolean = false
): Promise<LiquidityScore> {
  const warnings: string[] = [];

  try {
    if (isOptions) {
      return await scoreOptionsLiquidity(symbol);
    }
    return await scoreEquityLiquidity(symbol);
  } catch (err) {
    return {
      symbol,
      score: 0,
      grade: "F",
      tradeable: false,
      metrics: { bidAskSpread: 0, bidAskSpreadPct: 0, bidSize: 0, askSize: 0, openInterest: null, volume: null, midPrice: 0 },
      warnings: [`Failed to score: ${err}`],
      recommendation: "Cannot assess liquidity — do not trade",
    };
  }
}

async function scoreEquityLiquidity(symbol: string): Promise<LiquidityScore> {
  const quote = await getQuote(symbol);
  const warnings: string[] = [];

  const bid = quote.bp;
  const ask = quote.ap;
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : 100;

  // Hard fail: no bid or ask
  if (bid <= 0 || ask <= 0 || mid <= 0) {
    return {
      symbol,
      score: 0,
      grade: "F",
      tradeable: false,
      metrics: { bidAskSpread: spread, bidAskSpreadPct: spreadPct, bidSize: quote.bs, askSize: quote.as, openInterest: null, volume: null, midPrice: mid },
      warnings: ["No valid bid/ask — stock may be halted or delisted"],
      recommendation: "Do not trade — no market",
    };
  }

  // Hard fail: spread too wide
  if (spreadPct > HARD_LIMITS.MAX_SPREAD_PCT_EQUITY) {
    warnings.push(`Spread ${spreadPct.toFixed(2)}% exceeds ${HARD_LIMITS.MAX_SPREAD_PCT_EQUITY}% limit`);
  }

  // Spread score (0-40): 0% = 40pts, 1% = 0pts
  const spreadScore = Math.max(0, WEIGHTS.spreadScore * (1 - spreadPct / HARD_LIMITS.MAX_SPREAD_PCT_EQUITY));

  // Depth score (0-20): based on bid/ask sizes
  const avgSize = (quote.bs + quote.as) / 2;
  const depthScore = Math.min(WEIGHTS.depthScore, (avgSize / 100) * WEIGHTS.depthScore);

  const totalScore = Math.round(spreadScore + depthScore + WEIGHTS.oiScore + WEIGHTS.volumeScore); // equities get full OI/vol scores

  const grade = totalScore >= 80 ? "A" : totalScore >= 60 ? "B" : totalScore >= 40 ? "C" : totalScore >= 20 ? "D" : "F";

  return {
    symbol,
    score: totalScore,
    grade,
    tradeable: spreadPct <= HARD_LIMITS.MAX_SPREAD_PCT_EQUITY,
    metrics: { bidAskSpread: spread, bidAskSpreadPct: spreadPct, bidSize: quote.bs, askSize: quote.as, openInterest: null, volume: null, midPrice: mid },
    warnings,
    recommendation: totalScore >= 60 ? "Liquid — safe to trade" : totalScore >= 30 ? "Moderate liquidity — use limit orders" : "Illiquid — avoid or use small size with limits",
  };
}

async function scoreOptionsLiquidity(optionSymbol: string): Promise<LiquidityScore> {
  const warnings: string[] = [];

  // Get the option snapshot
  const snapshots = await getOptionsSnapshots([optionSymbol]);
  const snap = snapshots[optionSymbol];

  if (!snap?.latestQuote) {
    return {
      symbol: optionSymbol,
      score: 0,
      grade: "F",
      tradeable: false,
      metrics: { bidAskSpread: 0, bidAskSpreadPct: 0, bidSize: 0, askSize: 0, openInterest: null, volume: null, midPrice: 0 },
      warnings: ["No options quote available"],
      recommendation: "Cannot assess — do not trade this contract",
    };
  }

  const bid = snap.latestQuote.bp;
  const ask = snap.latestQuote.ap;
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : 100;
  const bidSize = snap.latestQuote.bs;
  const askSize = snap.latestQuote.as;

  // Get OI from the chain
  const underlying = optionSymbol.match(/^([A-Z]+)\d/)?.[1] || "";
  let openInterest: number | null = null;
  let volume: number | null = null;

  if (underlying) {
    try {
      const chain = await getOptionsChain(underlying);
      const contract = chain.find((c) => c.symbol === optionSymbol);
      if (contract) {
        openInterest = contract.open_interest ? parseInt(contract.open_interest) : null;
      }
    } catch {
      // OI lookup failed — continue without it
    }
  }

  // Daily volume from snapshot
  if (snap.dailyBar) {
    volume = snap.dailyBar.v;
  }

  // === HARD FAILS ===
  let tradeable = true;

  if (bid < HARD_LIMITS.MIN_BID) {
    tradeable = false;
    warnings.push(`Bid $${bid.toFixed(2)} below minimum $${HARD_LIMITS.MIN_BID} — likely worthless or deeply OTM`);
  }

  if (spreadPct > HARD_LIMITS.MAX_SPREAD_PCT_OPTIONS) {
    tradeable = false;
    warnings.push(`Spread ${spreadPct.toFixed(1)}% exceeds ${HARD_LIMITS.MAX_SPREAD_PCT_OPTIONS}% limit — too expensive to cross`);
  }

  if (openInterest !== null && openInterest < HARD_LIMITS.MIN_OPEN_INTEREST) {
    tradeable = false;
    warnings.push(`Open interest ${openInterest} below minimum ${HARD_LIMITS.MIN_OPEN_INTEREST} — no liquidity for exit`);
  }

  if (volume !== null && volume < HARD_LIMITS.MIN_OPTION_VOLUME) {
    warnings.push(`Volume ${volume} below minimum ${HARD_LIMITS.MIN_OPTION_VOLUME} — may have difficulty filling`);
  }

  // === SCORING ===

  // Spread score (0-40): 0% = 40pts, 15% = 0pts
  const spreadScore = Math.max(0, WEIGHTS.spreadScore * (1 - spreadPct / HARD_LIMITS.MAX_SPREAD_PCT_OPTIONS));

  // Depth score (0-20): bid/ask size
  const avgSize = (bidSize + askSize) / 2;
  const depthScore = Math.min(WEIGHTS.depthScore, (avgSize / 50) * WEIGHTS.depthScore);

  // OI score (0-25): 0 OI = 0pts, 1000+ = 25pts
  const oiScore = openInterest !== null
    ? Math.min(WEIGHTS.oiScore, (openInterest / 1000) * WEIGHTS.oiScore)
    : WEIGHTS.oiScore * 0.3; // partial credit if unknown

  // Volume score (0-15): 0 vol = 0pts, 500+ = 15pts
  const volumeScore = volume !== null
    ? Math.min(WEIGHTS.volumeScore, (volume / 500) * WEIGHTS.volumeScore)
    : WEIGHTS.volumeScore * 0.3;

  const totalScore = Math.round(spreadScore + depthScore + oiScore + volumeScore);
  const grade = totalScore >= 80 ? "A" : totalScore >= 60 ? "B" : totalScore >= 40 ? "C" : totalScore >= 20 ? "D" : "F";

  // Additional warnings
  if (spreadPct > 5 && spreadPct <= HARD_LIMITS.MAX_SPREAD_PCT_OPTIONS) {
    warnings.push(`Spread is ${spreadPct.toFixed(1)}% — always use limit orders, never market`);
  }
  if (bid > 0 && bid < 0.50) {
    warnings.push("Cheap option (<$0.50) — expect wide spreads and slippage on exit");
  }

  let recommendation: string;
  if (!tradeable) {
    recommendation = "REJECT — fails hard liquidity limits, do not trade";
  } else if (totalScore >= 70) {
    recommendation = "Good liquidity — safe to trade with limit orders";
  } else if (totalScore >= 40) {
    recommendation = "Moderate — use aggressive limit orders (mid + 15% of spread), reduce size";
  } else {
    recommendation = "Poor liquidity — only trade if conviction is very high, expect slippage";
  }

  return {
    symbol: optionSymbol,
    score: totalScore,
    grade,
    tradeable,
    metrics: { bidAskSpread: spread, bidAskSpreadPct: spreadPct, bidSize, askSize, openInterest, volume, midPrice: mid },
    warnings,
    recommendation,
  };
}

// Batch check — used by auto-trader to filter candidates
export async function filterByLiquidity(
  symbols: string[],
  isOptions: boolean = false,
  minScore: number = 30
): Promise<{ passed: string[]; failed: { symbol: string; reason: string }[] }> {
  const passed: string[] = [];
  const failed: { symbol: string; reason: string }[] = [];

  // Process in batches to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((s) => scoreLiquidity(s, isOptions).catch(() => null))
    );

    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (!result || !result.tradeable || result.score < minScore) {
        failed.push({
          symbol: batch[j],
          reason: result
            ? result.warnings[0] || `Score ${result.score} below minimum ${minScore}`
            : "Liquidity check failed",
        });
      } else {
        passed.push(batch[j]);
      }
    }
  }

  return { passed, failed };
}
