import { getHistoricalBars } from "./yahoo";

export interface BacktestConfig {
  symbol: string;
  startDate: string;
  endDate: string;
  strategy: "sma_crossover" | "rsi_reversal" | "momentum" | "mean_reversion";
  initialCapital: number;
  positionSizePct: number;
  stopLossPct: number;
  takeProfitPct: number;
}

export interface BacktestTrade {
  date: string;
  action: "buy" | "sell";
  price: number;
  qty: number;
  reason: string;
  pnl?: number;
  pnlPct?: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  totalReturn: number;
  totalReturnPct: number;
  winRate: number;
  winners: number;
  losers: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  sharpeRatio: number;
  finalCapital: number;
  buyAndHoldReturn: number;
  alpha: number; // return vs buy & hold
  equityCurve: { date: string; equity: number }[];
}

function sma(data: number[], period: number, index: number): number | null {
  if (index < period - 1) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) sum += data[i];
  return sum / period;
}

function rsi(closes: number[], index: number, period: number = 14): number | null {
  if (index < period) return null;
  let gains = 0, losses = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const bars = await getHistoricalBars(config.symbol, 500);

  if (bars.length < 50) {
    throw new Error(`Insufficient data for ${config.symbol}: ${bars.length} bars`);
  }

  // Filter by date range
  const filteredBars = bars.filter((b) => {
    const date = b.t.split("T")[0];
    return date >= config.startDate && date <= config.endDate;
  });

  if (filteredBars.length < 20) {
    throw new Error(`Only ${filteredBars.length} bars in date range`);
  }

  const closes = bars.map((b) => b.c);
  const startIdx = bars.findIndex((b) => b.t.split("T")[0] >= config.startDate);

  let capital = config.initialCapital;
  let position = 0;
  let entryPrice = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  let peakEquity = capital;
  let maxDrawdown = 0;
  const dailyReturns: number[] = [];
  let prevEquity = capital;

  for (let i = Math.max(startIdx, 200); i < bars.length; i++) {
    const date = bars[i].t.split("T")[0];
    if (date > config.endDate) break;

    const price = closes[i];
    const equity = position > 0 ? capital + position * price : capital;

    // Track drawdown
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // Daily return
    if (prevEquity > 0) dailyReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;

    equityCurve.push({ date, equity });

    // Generate signals based on strategy
    let signal: "buy" | "sell" | "hold" = "hold";

    switch (config.strategy) {
      case "sma_crossover": {
        const sma20 = sma(closes, 20, i);
        const sma50 = sma(closes, 50, i);
        const prevSma20 = sma(closes, 20, i - 1);
        const prevSma50 = sma(closes, 50, i - 1);
        if (sma20 && sma50 && prevSma20 && prevSma50) {
          if (prevSma20 <= prevSma50 && sma20 > sma50) signal = "buy";
          if (prevSma20 >= prevSma50 && sma20 < sma50) signal = "sell";
        }
        break;
      }
      case "rsi_reversal": {
        const r = rsi(closes, i);
        const prevR = rsi(closes, i - 1);
        if (r && prevR) {
          if (prevR < 30 && r >= 30) signal = "buy"; // RSI crossing up from oversold
          if (prevR > 70 && r <= 70) signal = "sell"; // RSI crossing down from overbought
        }
        break;
      }
      case "momentum": {
        const sma10 = sma(closes, 10, i);
        const sma30 = sma(closes, 30, i);
        const r = rsi(closes, i);
        if (sma10 && sma30 && r) {
          if (price > sma10 && sma10 > sma30 && r > 50 && r < 70) signal = "buy";
          if (price < sma10 && r < 40) signal = "sell";
        }
        break;
      }
      case "mean_reversion": {
        const sma20val = sma(closes, 20, i);
        if (sma20val) {
          const deviation = (price - sma20val) / sma20val;
          if (deviation < -0.03) signal = "buy"; // 3% below mean
          if (deviation > 0.03) signal = "sell"; // 3% above mean
        }
        break;
      }
    }

    // Execute signals
    if (signal === "buy" && position === 0) {
      const positionValue = capital * config.positionSizePct / 100;
      const qty = Math.floor(positionValue / price);
      if (qty > 0) {
        position = qty;
        entryPrice = price;
        capital -= qty * price;
        trades.push({ date, action: "buy", price, qty, reason: `${config.strategy} buy signal` });
      }
    }

    // Check stop loss / take profit
    if (position > 0) {
      const pnlPct = (price - entryPrice) / entryPrice;

      if (pnlPct <= -(config.stopLossPct / 100)) {
        const pnl = position * (price - entryPrice);
        capital += position * price;
        trades.push({ date, action: "sell", price, qty: position, reason: `Stop loss at ${(pnlPct * 100).toFixed(1)}%`, pnl, pnlPct });
        position = 0;
      } else if (pnlPct >= config.takeProfitPct / 100) {
        const pnl = position * (price - entryPrice);
        capital += position * price;
        trades.push({ date, action: "sell", price, qty: position, reason: `Take profit at ${(pnlPct * 100).toFixed(1)}%`, pnl, pnlPct });
        position = 0;
      } else if (signal === "sell") {
        const pnl = position * (price - entryPrice);
        capital += position * price;
        trades.push({ date, action: "sell", price, qty: position, reason: `${config.strategy} sell signal`, pnl, pnlPct });
        position = 0;
      }
    }
  }

  // Close any open position at end
  if (position > 0) {
    const lastPrice = closes[closes.length - 1];
    const pnl = position * (lastPrice - entryPrice);
    const pnlPct = (lastPrice - entryPrice) / entryPrice;
    capital += position * lastPrice;
    trades.push({ date: bars[bars.length - 1].t.split("T")[0], action: "sell", price: lastPrice, qty: position, reason: "End of backtest", pnl, pnlPct });
    position = 0;
  }

  // Calculate stats
  const sellTrades = trades.filter((t) => t.action === "sell" && t.pnl != null);
  const winners = sellTrades.filter((t) => (t.pnl || 0) > 0);
  const losers = sellTrades.filter((t) => (t.pnl || 0) <= 0);
  const winRate = sellTrades.length > 0 ? winners.length / sellTrades.length : 0;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + (t.pnlPct || 0), 0) / winners.length * 100 : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + (t.pnlPct || 0), 0) / losers.length * 100 : 0;

  const finalCapital = capital;
  const totalReturn = finalCapital - config.initialCapital;
  const totalReturnPct = (totalReturn / config.initialCapital) * 100;

  // Buy and hold comparison
  const firstPrice = filteredBars[0]?.c || closes[startIdx];
  const lastPrice = filteredBars[filteredBars.length - 1]?.c || closes[closes.length - 1];
  const buyAndHoldReturn = ((lastPrice - firstPrice) / firstPrice) * 100;
  const alpha = totalReturnPct - buyAndHoldReturn;

  // Sharpe ratio (annualized)
  const meanDailyReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdDev = dailyReturns.length > 0
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + Math.pow(r - meanDailyReturn, 2), 0) / dailyReturns.length)
    : 1;
  const sharpeRatio = stdDev > 0 ? (meanDailyReturn / stdDev) * Math.sqrt(252) : 0;

  return {
    config,
    trades,
    totalReturn,
    totalReturnPct,
    winRate,
    winners: winners.length,
    losers: losers.length,
    avgWin,
    avgLoss,
    maxDrawdown: maxDrawdown * 100,
    sharpeRatio,
    finalCapital,
    buyAndHoldReturn,
    alpha,
    equityCurve,
  };
}
