import { prisma } from "./db";
import { sendNotification } from "./notifications";

// ============ WALK-FORWARD OPTIMIZATION ============
// Weekly: re-test all strategies on rolling windows, auto-adjust parameters,
// flag edges that are decaying. Static systems die — adaptive ones survive.

export interface StrategyHealth {
  strategy: string;
  // Recent performance (last 30 trades)
  recentTrades: number;
  recentWinRate: number;
  recentPnl: number;
  recentAvgPnl: number;
  recentProfitFactor: number;
  // Historical performance (all trades)
  totalTrades: number;
  totalWinRate: number;
  totalPnl: number;
  totalProfitFactor: number;
  // Edge decay detection
  edgeDecaying: boolean;
  decayRate: number; // negative = decaying, positive = improving
  // Rolling window comparison
  windowComparison: {
    period1: { label: string; winRate: number; pnl: number };
    period2: { label: string; winRate: number; pnl: number };
  };
  // Recommended adjustments
  recommendation: "keep" | "optimize" | "reduce" | "kill";
  adjustments: string[];
  grade: string;
}

export interface WalkForwardResult {
  timestamp: string;
  strategies: StrategyHealth[];
  overallHealth: "healthy" | "mixed" | "declining" | "critical";
  parameterChanges: { key: string; oldValue: string; newValue: string; reason: string }[];
  insights: string[];
}

function classifyStrategy(reason: string, symbol: string): string {
  const r = reason.toLowerCase();
  if (r.includes("iron_condor") || r.includes("iron condor")) return "iron_condor";
  if (r.includes("credit_spread") || r.includes("credit spread")) return "credit_spread";
  if (r.includes("spread")) return "spread";
  if (r.includes("straddle") || r.includes("strangle")) return "straddle";
  if (r.includes("quick") || r.includes("lottery")) return "quick_play";
  if (r.includes("gap")) return "gap_play";
  if (r.includes("earning")) return "earnings";
  if (r.includes("momentum")) return "momentum";
  if (r.includes("premium") || r.includes("sell")) return "premium_selling";
  if (symbol.startsWith("FUT:")) return "futures";
  if (symbol.length > 10) return "directional_options";
  return "equity";
}

export async function runWalkForwardOptimization(): Promise<WalkForwardResult> {
  const startTime = Date.now();

  // Get all closed trades
  const allTrades = await prisma.autoTradeLog.findMany({
    where: {
      pnl: { not: null },
      action: { notIn: ["skip", "risk_veto", "liquidity_veto"] },
    },
    orderBy: { createdAt: "asc" },
  });

  if (allTrades.length < 10) {
    return {
      timestamp: new Date().toISOString(),
      strategies: [],
      overallHealth: "healthy",
      parameterChanges: [],
      insights: ["Insufficient trades for walk-forward analysis (need 10+)"],
    };
  }

  // Group trades by strategy
  const strategyTrades: Record<string, typeof allTrades> = {};
  for (const trade of allTrades) {
    const strategy = classifyStrategy(trade.reason, trade.symbol);
    if (!strategyTrades[strategy]) strategyTrades[strategy] = [];
    strategyTrades[strategy].push(trade);
  }

  const strategies: StrategyHealth[] = [];
  const parameterChanges: { key: string; oldValue: string; newValue: string; reason: string }[] = [];
  const insights: string[] = [];

  for (const [strategy, trades] of Object.entries(strategyTrades)) {
    if (trades.length < 3) continue;

    // Split into recent (last 30) vs old
    const recentTrades = trades.slice(-30);
    const olderTrades = trades.slice(0, -30);

    // Recent metrics
    const recentWins = recentTrades.filter((t) => (t.pnl || 0) > 0).length;
    const recentWinRate = (recentWins / recentTrades.length) * 100;
    const recentPnl = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const recentAvgPnl = recentPnl / recentTrades.length;
    const recentGrossProfit = recentTrades.filter((t) => (t.pnl || 0) > 0).reduce((s, t) => s + (t.pnl || 0), 0);
    const recentGrossLoss = Math.abs(recentTrades.filter((t) => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl || 0), 0));
    const recentProfitFactor = recentGrossLoss > 0 ? recentGrossProfit / recentGrossLoss : recentGrossProfit > 0 ? 99 : 0;

    // Total metrics
    const totalWins = trades.filter((t) => (t.pnl || 0) > 0).length;
    const totalWinRate = (totalWins / trades.length) * 100;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const totalGrossProfit = trades.filter((t) => (t.pnl || 0) > 0).reduce((s, t) => s + (t.pnl || 0), 0);
    const totalGrossLoss = Math.abs(trades.filter((t) => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl || 0), 0));
    const totalProfitFactor = totalGrossLoss > 0 ? totalGrossProfit / totalGrossLoss : totalGrossProfit > 0 ? 99 : 0;

    // Edge decay: compare first half vs second half performance
    const midpoint = Math.floor(trades.length / 2);
    const firstHalf = trades.slice(0, midpoint);
    const secondHalf = trades.slice(midpoint);

    const firstHalfWinRate = firstHalf.length > 0 ? (firstHalf.filter((t) => (t.pnl || 0) > 0).length / firstHalf.length) * 100 : 0;
    const secondHalfWinRate = secondHalf.length > 0 ? (secondHalf.filter((t) => (t.pnl || 0) > 0).length / secondHalf.length) * 100 : 0;
    const firstHalfPnl = firstHalf.reduce((s, t) => s + (t.pnl || 0), 0);
    const secondHalfPnl = secondHalf.reduce((s, t) => s + (t.pnl || 0), 0);

    const decayRate = secondHalfWinRate - firstHalfWinRate;
    const edgeDecaying = decayRate < -10 || (secondHalfPnl < firstHalfPnl * 0.5 && firstHalfPnl > 0);

    // Determine recommendation
    let recommendation: StrategyHealth["recommendation"];
    let adjustments: string[] = [];
    let grade: string;

    if (recentPnl > 0 && recentWinRate > 50 && recentProfitFactor > 1.5) {
      recommendation = "keep";
      grade = "A";
      if (decayRate > 5) adjustments.push("Edge improving — consider increasing allocation");
    } else if (recentPnl > 0 && recentWinRate > 40) {
      recommendation = "optimize";
      grade = "B";
      adjustments.push("Positive but weak — tighten entry criteria");
      if (recentProfitFactor < 1.2) adjustments.push("Profit factor low — improve stop losses");
    } else if (recentWinRate > 35 || totalPnl > 0) {
      recommendation = "reduce";
      grade = "C";
      adjustments.push("Marginal edge — reduce position size 50%");
      if (edgeDecaying) adjustments.push("Edge is decaying — may need to kill soon");
    } else {
      recommendation = "kill";
      grade = "F";
      adjustments.push("No edge detected — disable this strategy");
    }

    if (edgeDecaying && recommendation !== "kill") {
      adjustments.push(`Edge decaying: win rate ${firstHalfWinRate.toFixed(0)}% → ${secondHalfWinRate.toFixed(0)}%`);
    }

    strategies.push({
      strategy,
      recentTrades: recentTrades.length,
      recentWinRate,
      recentPnl,
      recentAvgPnl,
      recentProfitFactor,
      totalTrades: trades.length,
      totalWinRate,
      totalPnl,
      totalProfitFactor,
      edgeDecaying,
      decayRate,
      windowComparison: {
        period1: { label: "First half", winRate: firstHalfWinRate, pnl: firstHalfPnl },
        period2: { label: "Recent half", winRate: secondHalfWinRate, pnl: secondHalfPnl },
      },
      recommendation,
      adjustments,
      grade,
    });
  }

  // Sort by recommendation urgency
  const recOrder: Record<string, number> = { kill: 0, reduce: 1, optimize: 2, keep: 3 };
  strategies.sort((a, b) => recOrder[a.recommendation] - recOrder[b.recommendation]);

  // Generate parameter changes for "kill" strategies
  for (const strat of strategies) {
    if (strat.recommendation === "kill" && strat.totalTrades >= 10) {
      parameterChanges.push({
        key: `strategy_${strat.strategy}_enabled`,
        oldValue: "true",
        newValue: "false",
        reason: `${strat.strategy}: ${strat.totalTrades} trades, ${strat.totalWinRate.toFixed(0)}% win rate, $${strat.totalPnl.toFixed(0)} total P&L — no edge`,
      });
      insights.push(`KILL: ${strat.strategy} has no edge (${strat.recentWinRate.toFixed(0)}% recent win rate, $${strat.recentPnl.toFixed(0)} recent P&L)`);
    }
    if (strat.edgeDecaying && strat.recommendation !== "kill") {
      insights.push(`DECAY: ${strat.strategy} edge is fading (${strat.decayRate.toFixed(0)}% decline in win rate)`);
    }
  }

  // Boost best performers
  const bestStrategy = strategies.find((s) => s.recommendation === "keep" && s.recentProfitFactor > 2);
  if (bestStrategy) {
    insights.push(`BOOST: ${bestStrategy.strategy} is the top performer (${bestStrategy.recentProfitFactor.toFixed(1)} PF) — consider increasing allocation`);
  }

  // Overall health
  const killCount = strategies.filter((s) => s.recommendation === "kill").length;
  const keepCount = strategies.filter((s) => s.recommendation === "keep").length;
  const overallHealth: WalkForwardResult["overallHealth"] =
    killCount === 0 && keepCount > strategies.length * 0.5 ? "healthy" :
    killCount <= 1 ? "mixed" :
    killCount <= 2 ? "declining" :
    "critical";

  const result: WalkForwardResult = {
    timestamp: new Date().toISOString(),
    strategies,
    overallHealth,
    parameterChanges,
    insights,
  };

  // Store
  await prisma.agentConfig.upsert({
    where: { key: "walk_forward_result" },
    update: { value: JSON.stringify(result) },
    create: { key: "walk_forward_result", value: JSON.stringify(result) },
  });

  // Notify on critical findings
  if (killCount > 0 || overallHealth === "declining" || overallHealth === "critical") {
    await sendNotification(
      `📊 WALK-FORWARD: ${overallHealth.toUpperCase()}\n` +
      `${strategies.length} strategies analyzed:\n` +
      strategies.map((s) => `• ${s.strategy}: ${s.grade} (${s.recommendation}) — ${s.recentWinRate.toFixed(0)}% WR, $${s.recentPnl.toFixed(0)}`).join("\n") +
      (insights.length > 0 ? `\n\n${insights[0]}` : ""),
      "general"
    );
  }

  await prisma.agentRun.create({
    data: {
      runType: "walk_forward",
      stocksScanned: allTrades.length,
      tradesPlaced: 0,
      positionsManaged: strategies.length,
      errors: killCount,
      summary: `Walk-forward: ${strategies.length} strategies — ${keepCount} keep, ${strategies.filter((s) => s.recommendation === "optimize").length} optimize, ${strategies.filter((s) => s.recommendation === "reduce").length} reduce, ${killCount} kill`,
      durationMs: Date.now() - startTime,
    },
  });

  return result;
}
