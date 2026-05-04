import { prisma } from "./db";

export interface LearningInsights {
  // Overall performance
  totalTrades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  totalRealizedPnl: number;
  profitFactor: number; // gross profit / gross loss

  // Accuracy
  buyAccuracy: number;  // % of buy signals that were profitable
  sellAccuracy: number; // % of sell signals that avoided losses
  avgScoreOnWinners: number;
  avgScoreOnLosers: number;
  bestScoreThreshold: number; // score above which win rate is highest

  // Sector performance
  sectorStats: { sector: string; trades: number; winRate: number; avgPnl: number }[];

  // Pattern insights
  bestSetups: string[];
  worstSetups: string[];

  // Time-based
  avgHoldDays: number;
  bestTimeframe: string;

  // Per-symbol memory
  symbolHistory: { symbol: string; trades: number; winRate: number; lastSignal: string; lastScore: number; avgPnl: number }[];

  // Market regime performance
  regimeStats: { regime: string; trades: number; winRate: number; avgPnl: number }[];

  // Summary for AI
  aiSummary: string;
}

export async function generateLearningInsights(): Promise<LearningInsights> {
  // Get all closed trades (sells with P&L)
  const allTrades = await prisma.autoTradeLog.findMany({
    where: { pnl: { not: null } },
    orderBy: { createdAt: "desc" },
  });

  const allBuys = await prisma.autoTradeLog.findMany({
    where: { action: { in: ["buy", "buy_call", "buy_put"] } },
    orderBy: { createdAt: "desc" },
  });

  const allReports = await prisma.researchReport.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const agentRuns = await prisma.agentRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Overall performance
  const winners = allTrades.filter((t) => (t.pnl || 0) > 0);
  const losers = allTrades.filter((t) => (t.pnl || 0) <= 0);
  const totalTrades = allTrades.length;
  const winRate = totalTrades > 0 ? winners.length / totalTrades : 0;
  const totalRealizedPnl = allTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const grossProfit = winners.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losers.reduce((sum, t) => sum + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Average win/loss percentage (approximate from P&L and price)
  const avgWinPct = winners.length > 0
    ? winners.reduce((sum, t) => sum + ((t.pnl || 0) / Math.max(1, (t.price || 100) * (t.qty || 1))) * 100, 0) / winners.length
    : 0;
  const avgLossPct = losers.length > 0
    ? losers.reduce((sum, t) => sum + ((t.pnl || 0) / Math.max(1, (t.price || 100) * (t.qty || 1))) * 100, 0) / losers.length
    : 0;

  // Accuracy by signal type
  const buyTrades = allTrades.filter((t) => t.aiSignal?.includes("buy"));
  const sellTrades = allTrades.filter((t) => t.aiSignal?.includes("sell"));
  const buyAccuracy = buyTrades.length > 0
    ? buyTrades.filter((t) => (t.pnl || 0) > 0).length / buyTrades.length
    : 0;
  const sellAccuracy = sellTrades.length > 0
    ? sellTrades.filter((t) => (t.pnl || 0) > 0).length / sellTrades.length
    : 0;

  // Score analysis
  const avgScoreOnWinners = winners.length > 0
    ? winners.filter((t) => t.aiScore != null).reduce((sum, t) => sum + (t.aiScore || 0), 0) / Math.max(1, winners.filter((t) => t.aiScore != null).length)
    : 0;
  const avgScoreOnLosers = losers.length > 0
    ? losers.filter((t) => t.aiScore != null).reduce((sum, t) => sum + (t.aiScore || 0), 0) / Math.max(1, losers.filter((t) => t.aiScore != null).length)
    : 0;

  // Find best score threshold
  let bestScoreThreshold = 55;
  let bestThresholdWinRate = 0;
  for (const threshold of [50, 55, 60, 65, 70, 75, 80]) {
    const aboveThreshold = allTrades.filter((t) => (t.aiScore || 0) >= threshold);
    if (aboveThreshold.length >= 3) {
      const wr = aboveThreshold.filter((t) => (t.pnl || 0) > 0).length / aboveThreshold.length;
      if (wr > bestThresholdWinRate) {
        bestThresholdWinRate = wr;
        bestScoreThreshold = threshold;
      }
    }
  }

  // Sector performance
  const sectorMap: Record<string, { wins: number; losses: number; totalPnl: number }> = {};
  for (const report of allReports) {
    const sector = report.sector || "Unknown";
    const trades = allTrades.filter((t) => t.symbol === report.symbol);
    if (!sectorMap[sector]) sectorMap[sector] = { wins: 0, losses: 0, totalPnl: 0 };
    for (const t of trades) {
      if ((t.pnl || 0) > 0) sectorMap[sector].wins++;
      else sectorMap[sector].losses++;
      sectorMap[sector].totalPnl += t.pnl || 0;
    }
  }
  const sectorStats = Object.entries(sectorMap)
    .filter(([, v]) => v.wins + v.losses > 0)
    .map(([sector, v]) => ({
      sector,
      trades: v.wins + v.losses,
      winRate: (v.wins / (v.wins + v.losses)),
      avgPnl: v.totalPnl / (v.wins + v.losses),
    }))
    .sort((a, b) => b.winRate - a.winRate);

  // Per-symbol history
  const symbolMap: Record<string, { trades: number; wins: number; totalPnl: number; lastSignal: string; lastScore: number }> = {};
  for (const t of allTrades) {
    if (!symbolMap[t.symbol]) symbolMap[t.symbol] = { trades: 0, wins: 0, totalPnl: 0, lastSignal: "", lastScore: 0 };
    symbolMap[t.symbol].trades++;
    if ((t.pnl || 0) > 0) symbolMap[t.symbol].wins++;
    symbolMap[t.symbol].totalPnl += t.pnl || 0;
    symbolMap[t.symbol].lastSignal = t.aiSignal || "";
    symbolMap[t.symbol].lastScore = t.aiScore || 0;
  }
  const symbolHistory = Object.entries(symbolMap)
    .map(([symbol, v]) => ({
      symbol,
      trades: v.trades,
      winRate: v.wins / v.trades,
      lastSignal: v.lastSignal,
      lastScore: v.lastScore,
      avgPnl: v.totalPnl / v.trades,
    }))
    .sort((a, b) => b.trades - a.trades)
    .slice(0, 15);

  // Market regime stats from agent runs
  const regimeMap: Record<string, { trades: number; wins: number; totalPnl: number }> = {};
  for (const run of agentRuns) {
    const regimeMatch = run.summary.match(/\[(BULL|BEAR|CHOPPY)\]/);
    if (regimeMatch) {
      const regime = regimeMatch[1];
      if (!regimeMap[regime]) regimeMap[regime] = { trades: 0, wins: 0, totalPnl: 0 };
      regimeMap[regime].trades += run.tradesPlaced;
    }
  }
  const regimeStats = Object.entries(regimeMap)
    .map(([regime, v]) => ({
      regime,
      trades: v.trades,
      winRate: v.trades > 0 ? v.wins / v.trades : 0,
      avgPnl: v.trades > 0 ? v.totalPnl / v.trades : 0,
    }));

  // Pattern insights
  const bestSetups: string[] = [];
  const worstSetups: string[] = [];

  if (avgScoreOnWinners > avgScoreOnLosers + 10) {
    bestSetups.push(`Higher AI scores (${avgScoreOnWinners.toFixed(0)}+) produce more winners`);
  }
  if (buyAccuracy > 0.6) bestSetups.push(`Buy signals are ${(buyAccuracy * 100).toFixed(0)}% accurate — trust them`);
  if (buyAccuracy < 0.4) worstSetups.push(`Buy signals only ${(buyAccuracy * 100).toFixed(0)}% accurate — be more selective`);

  const bestSectors = sectorStats.filter((s) => s.winRate > 0.6 && s.trades >= 2);
  for (const s of bestSectors.slice(0, 2)) {
    bestSetups.push(`${s.sector}: ${(s.winRate * 100).toFixed(0)}% win rate over ${s.trades} trades`);
  }
  const worstSectors = sectorStats.filter((s) => s.winRate < 0.4 && s.trades >= 2);
  for (const s of worstSectors.slice(0, 2)) {
    worstSetups.push(`${s.sector}: only ${(s.winRate * 100).toFixed(0)}% win rate — avoid`);
  }

  // Build AI summary
  const aiSummary = totalTrades === 0
    ? "No closed trades yet. This is our first trading period. Be cautious with initial positions — start small, validate the strategy, then scale up."
    : `PERFORMANCE REVIEW (${totalTrades} closed trades):
- Win Rate: ${(winRate * 100).toFixed(0)}% (${winners.length}W / ${losers.length}L)
- Profit Factor: ${profitFactor === Infinity ? "All wins" : profitFactor.toFixed(2)}
- Total P&L: $${totalRealizedPnl.toFixed(2)}
- Avg Win: +${avgWinPct.toFixed(1)}% | Avg Loss: ${avgLossPct.toFixed(1)}%
- Buy accuracy: ${(buyAccuracy * 100).toFixed(0)}% | Avg winning score: ${avgScoreOnWinners.toFixed(0)} | Avg losing score: ${avgScoreOnLosers.toFixed(0)}
- Best score threshold: ${bestScoreThreshold}+ (${(bestThresholdWinRate * 100).toFixed(0)}% win rate)
${bestSetups.length > 0 ? "WHAT WORKS: " + bestSetups.join(". ") : ""}
${worstSetups.length > 0 ? "WHAT DOESN'T WORK: " + worstSetups.join(". ") : ""}
${symbolHistory.length > 0 ? "TOP SYMBOLS: " + symbolHistory.slice(0, 5).map((s) => `${s.symbol} (${s.trades} trades, ${(s.winRate * 100).toFixed(0)}% WR)`).join(", ") : ""}

APPLY THESE LESSONS: ${winRate > 0.6 ? "Strategy is working — maintain current approach but look for higher conviction setups." : winRate > 0.4 ? "Mixed results — be MORE selective, only trade highest conviction setups (score " + bestScoreThreshold + "+)." : "Strategy needs adjustment — reduce position sizes, tighten criteria, focus on sectors that work."}`;

  return {
    totalTrades,
    winRate,
    avgWinPct,
    avgLossPct,
    totalRealizedPnl,
    profitFactor,
    buyAccuracy,
    sellAccuracy,
    avgScoreOnWinners,
    avgScoreOnLosers,
    bestScoreThreshold,
    sectorStats,
    bestSetups,
    worstSetups,
    avgHoldDays: 0,
    bestTimeframe: "swing",
    symbolHistory,
    regimeStats,
    aiSummary,
  };
}
