import { prisma } from "./db";
import { getHistoricalBars } from "./yahoo";

// ============ BENCHMARK TRACKING ============
// Answers the most important question: "Am I beating the market?"
// If the agent makes 8% but SPY makes 12%, the agent is DESTROYING value.
// Tracks: alpha, beta, Sharpe ratio, information ratio, max drawdown vs benchmark.

export interface BenchmarkComparison {
  period: string;
  // Portfolio
  portfolioReturn: number;
  portfolioSharpe: number;
  portfolioMaxDrawdown: number;
  portfolioVolatility: number;
  // Benchmark (SPY)
  benchmarkReturn: number;
  benchmarkSharpe: number;
  benchmarkMaxDrawdown: number;
  benchmarkVolatility: number;
  // Relative
  alpha: number; // excess return over benchmark
  beta: number; // sensitivity to benchmark
  informationRatio: number; // alpha / tracking error
  trackingError: number; // std dev of excess returns
  // Verdict
  beatingBenchmark: boolean;
  verdict: string;
  // Data for charting
  equityCurve: { date: string; portfolio: number; benchmark: number; alpha: number }[];
}

function calcReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return returns;
}

function calcSharpe(returns: number[], riskFreeRate: number = 0.05): number {
  if (returns.length < 2) return 0;
  const dailyRf = riskFreeRate / 252;
  const excessReturns = returns.map((r) => r - dailyRf);
  const mean = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
  const variance = excessReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / excessReturns.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (mean / std) * Math.sqrt(252) : 0;
}

function calcMaxDrawdown(values: number[]): number {
  let peak = values[0] || 0;
  let maxDd = 0;
  for (const val of values) {
    if (val > peak) peak = val;
    const dd = (peak - val) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function calcBeta(portfolioReturns: number[], benchmarkReturns: number[]): number {
  const n = Math.min(portfolioReturns.length, benchmarkReturns.length);
  if (n < 5) return 1;

  const pReturns = portfolioReturns.slice(0, n);
  const bReturns = benchmarkReturns.slice(0, n);

  const pMean = pReturns.reduce((a, b) => a + b, 0) / n;
  const bMean = bReturns.reduce((a, b) => a + b, 0) / n;

  let covariance = 0;
  let bVariance = 0;
  for (let i = 0; i < n; i++) {
    covariance += (pReturns[i] - pMean) * (bReturns[i] - bMean);
    bVariance += Math.pow(bReturns[i] - bMean, 2);
  }

  return bVariance > 0 ? covariance / bVariance : 1;
}

export async function generateBenchmarkReport(
  period: "1W" | "1M" | "3M" | "6M" | "1Y" = "1M"
): Promise<BenchmarkComparison> {
  // Equities brokerage removed — no portfolio equity history to compare.
  const portfolioHistory: { equity: number[]; timestamp: number[] } = { equity: [], timestamp: [] };

  // Fetch SPY bars for same period
  const barCount = period === "1W" ? 7 : period === "1M" ? 30 : period === "3M" ? 90 : period === "6M" ? 180 : 365;
  const spyBars = await getHistoricalBars("SPY", barCount);

  // Build aligned series
  const portfolioEquity = portfolioHistory.equity || [];
  const portfolioTimestamps = portfolioHistory.timestamp || [];
  const spyCloses = spyBars.map((b) => b.c);

  // Normalize to same length (shorter of the two)
  const len = Math.min(portfolioEquity.length, spyCloses.length);
  const pEquity = portfolioEquity.slice(-len);
  const bPrices = spyCloses.slice(-len);

  if (len < 3) {
    return emptyReport(period, "Insufficient data — need at least 3 data points");
  }

  // Calculate returns
  const pReturns = calcReturns(pEquity);
  const bReturns = calcReturns(bPrices);

  // Total returns
  const portfolioReturn = pEquity.length >= 2
    ? (pEquity[pEquity.length - 1] - pEquity[0]) / pEquity[0]
    : 0;
  const benchmarkReturn = bPrices.length >= 2
    ? (bPrices[bPrices.length - 1] - bPrices[0]) / bPrices[0]
    : 0;

  // Volatility (annualized)
  const pStd = Math.sqrt(pReturns.reduce((s, r) => s + r * r, 0) / pReturns.length - Math.pow(pReturns.reduce((a, b) => a + b, 0) / pReturns.length, 2)) * Math.sqrt(252);
  const bStd = Math.sqrt(bReturns.reduce((s, r) => s + r * r, 0) / bReturns.length - Math.pow(bReturns.reduce((a, b) => a + b, 0) / bReturns.length, 2)) * Math.sqrt(252);

  // Sharpe
  const portfolioSharpe = calcSharpe(pReturns);
  const benchmarkSharpe = calcSharpe(bReturns);

  // Max drawdown
  const portfolioMaxDrawdown = calcMaxDrawdown(pEquity);
  const benchmarkMaxDrawdown = calcMaxDrawdown(bPrices);

  // Alpha & Beta
  const beta = calcBeta(pReturns, bReturns);
  const alpha = portfolioReturn - (beta * benchmarkReturn);

  // Tracking error & information ratio
  const excessReturns = pReturns.map((r, i) => r - (bReturns[i] || 0));
  const trackingError = Math.sqrt(
    excessReturns.reduce((s, r) => s + r * r, 0) / excessReturns.length -
    Math.pow(excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length, 2)
  ) * Math.sqrt(252);
  const informationRatio = trackingError > 0 ? (alpha / trackingError) : 0;

  // Build equity curve for charting
  const basePortfolio = pEquity[0] || 100000;
  const baseBenchmark = bPrices[0] || 500;
  const equityCurve: BenchmarkComparison["equityCurve"] = [];
  for (let i = 0; i < len; i++) {
    const date = portfolioTimestamps[portfolioTimestamps.length - len + i]
      ? new Date(portfolioTimestamps[portfolioTimestamps.length - len + i] * 1000).toISOString().split("T")[0]
      : `Day ${i}`;
    const pNorm = ((pEquity[i] - basePortfolio) / basePortfolio) * 100;
    const bNorm = ((bPrices[i] - baseBenchmark) / baseBenchmark) * 100;
    equityCurve.push({
      date,
      portfolio: parseFloat(pNorm.toFixed(2)),
      benchmark: parseFloat(bNorm.toFixed(2)),
      alpha: parseFloat((pNorm - bNorm).toFixed(2)),
    });
  }

  const beatingBenchmark = portfolioReturn > benchmarkReturn;
  let verdict: string;
  if (alpha > 0.05) verdict = `STRONG OUTPERFORMANCE: +${(alpha * 100).toFixed(1)}% alpha over SPY. The system is generating real edge.`;
  else if (alpha > 0) verdict = `Slight outperformance: +${(alpha * 100).toFixed(1)}% alpha. Positive but not yet statistically significant.`;
  else if (alpha > -0.03) verdict = `Roughly matching SPY (${(alpha * 100).toFixed(1)}% alpha). Consider whether agent fees/complexity are worth it.`;
  else verdict = `UNDERPERFORMING SPY by ${(Math.abs(alpha) * 100).toFixed(1)}%. Review strategy — a passive SPY position would be more profitable.`;

  // Store for dashboard
  await prisma.agentConfig.upsert({
    where: { key: "benchmark_report" },
    update: {
      value: JSON.stringify({
        lastRun: new Date().toISOString(),
        period,
        portfolioReturn: (portfolioReturn * 100).toFixed(2),
        benchmarkReturn: (benchmarkReturn * 100).toFixed(2),
        alpha: (alpha * 100).toFixed(2),
        beta: beta.toFixed(2),
        sharpe: portfolioSharpe.toFixed(2),
        informationRatio: informationRatio.toFixed(2),
        beatingBenchmark,
        verdict,
      }),
    },
    create: {
      key: "benchmark_report",
      value: JSON.stringify({
        lastRun: new Date().toISOString(),
        period,
        portfolioReturn: (portfolioReturn * 100).toFixed(2),
        benchmarkReturn: (benchmarkReturn * 100).toFixed(2),
        alpha: (alpha * 100).toFixed(2),
        beatingBenchmark,
        verdict,
      }),
    },
  });

  return {
    period,
    portfolioReturn,
    portfolioSharpe,
    portfolioMaxDrawdown,
    portfolioVolatility: pStd,
    benchmarkReturn,
    benchmarkSharpe,
    benchmarkMaxDrawdown,
    benchmarkVolatility: bStd,
    alpha,
    beta,
    informationRatio,
    trackingError,
    beatingBenchmark,
    verdict,
    equityCurve,
  };
}

function emptyReport(period: string, verdict: string): BenchmarkComparison {
  return {
    period,
    portfolioReturn: 0, portfolioSharpe: 0, portfolioMaxDrawdown: 0, portfolioVolatility: 0,
    benchmarkReturn: 0, benchmarkSharpe: 0, benchmarkMaxDrawdown: 0, benchmarkVolatility: 0,
    alpha: 0, beta: 1, informationRatio: 0, trackingError: 0,
    beatingBenchmark: false, verdict, equityCurve: [],
  };
}
