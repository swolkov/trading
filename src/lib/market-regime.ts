import { getHistoricalBars } from "./yahoo";

export type MarketRegime = "bull" | "bear" | "choppy";

export interface RegimeAnalysis {
  regime: MarketRegime;
  spyAbove50sma: boolean;
  spyAbove200sma: boolean;
  goldenCross: boolean; // 50 > 200 SMA
  deathCross: boolean;  // 50 < 200 SMA
  spy1mReturn: number;
  spy3mReturn: number;
  rsi: number | null;
  volatility: number; // annualized from 20-day std dev
  recommendation: string;
  positionSizeMultiplier: number; // 0.5 to 1.5x normal sizing
  cashReservePct: number; // override cash reserve
}

export async function detectMarketRegime(): Promise<RegimeAnalysis> {
  const bars = await getHistoricalBars("SPY", 250);

  if (bars.length < 50) {
    return defaultRegime();
  }

  const closes = bars.map((b) => b.c);
  const current = closes[closes.length - 1];

  // Moving averages
  const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const sma200 = closes.length >= 200
    ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200
    : sma50;

  const spyAbove50sma = current > sma50;
  const spyAbove200sma = current > sma200;
  const goldenCross = sma50 > sma200;
  const deathCross = sma50 < sma200;

  // Returns
  const spy1mReturn = closes.length >= 21
    ? (current - closes[closes.length - 21]) / closes[closes.length - 21]
    : 0;
  const spy3mReturn = closes.length >= 63
    ? (current - closes[closes.length - 63]) / closes[closes.length - 63]
    : 0;

  // RSI
  let rsi: number | null = null;
  if (closes.length >= 15) {
    const changes: number[] = [];
    for (let i = closes.length - 14; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }
    const gains = changes.filter((c) => c > 0);
    const losses = changes.filter((c) => c < 0).map((c) => Math.abs(c));
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / 14 : 0;
    rsi = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
  }

  // Volatility (annualized 20-day std dev of returns)
  const returns: number[] = [];
  for (let i = closes.length - 20; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100; // annualized %

  // Determine regime
  let regime: MarketRegime;
  let recommendation: string;
  let positionSizeMultiplier: number;
  let cashReservePct: number;

  if (goldenCross && spyAbove50sma && spy1mReturn > 0) {
    regime = "bull";
    recommendation = "BULL MARKET: Be aggressive. Buy dips. Full position sizes. Favor calls over puts. Reduce cash reserve.";
    positionSizeMultiplier = 1.3;
    cashReservePct = 15;
  } else if (deathCross && !spyAbove50sma && spy1mReturn < -0.03) {
    regime = "bear";
    recommendation = "BEAR MARKET: Be defensive. Raise cash. Smaller positions. Consider puts for hedging. Tighter stop losses.";
    positionSizeMultiplier = 0.5;
    cashReservePct = 40;
  } else if (deathCross || (!spyAbove200sma && spy3mReturn < -0.05)) {
    regime = "bear";
    recommendation = "BEAR TREND: Market below key averages. Reduce exposure. Favor cash and hedges.";
    positionSizeMultiplier = 0.6;
    cashReservePct = 35;
  } else if (goldenCross && spyAbove200sma) {
    regime = "bull";
    recommendation = "BULL TREND: Market above key averages. Buy quality on pullbacks. Normal to slightly larger positions.";
    positionSizeMultiplier = 1.1;
    cashReservePct = 18;
  } else {
    regime = "choppy";
    recommendation = "CHOPPY MARKET: No clear trend. Trade less. Tighter ranges. Sell premium (covered calls). Wait for breakout or breakdown.";
    positionSizeMultiplier = 0.7;
    cashReservePct = 30;
  }

  // Adjust for extreme volatility
  if (volatility > 30) {
    positionSizeMultiplier *= 0.7;
    cashReservePct = Math.max(cashReservePct, 35);
    recommendation += ` HIGH VOLATILITY (${volatility.toFixed(0)}%): Reduce all position sizes.`;
  }

  return {
    regime,
    spyAbove50sma,
    spyAbove200sma,
    goldenCross,
    deathCross,
    spy1mReturn,
    spy3mReturn,
    rsi,
    volatility,
    recommendation,
    positionSizeMultiplier,
    cashReservePct,
  };
}

function defaultRegime(): RegimeAnalysis {
  return {
    regime: "choppy",
    spyAbove50sma: true,
    spyAbove200sma: true,
    goldenCross: true,
    deathCross: false,
    spy1mReturn: 0,
    spy3mReturn: 0,
    rsi: null,
    volatility: 15,
    recommendation: "Unable to determine regime. Trading with default conservative settings.",
    positionSizeMultiplier: 0.8,
    cashReservePct: 25,
  };
}
