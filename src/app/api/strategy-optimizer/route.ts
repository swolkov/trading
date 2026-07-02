import { prisma } from "@/lib/db";
import { getPositions } from "@/lib/alpaca";

// ============ STRATEGY OPTIMIZER ============
// Analyzes actual trade history to find the best-performing strategy combinations
// and recommends an optimal daily playbook for maximum returns.

interface StrategyPerformance {
  strategy: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgWinPnl: number;
  avgLossPnl: number;
  profitFactor: number;
  expectancy: number;        // avg $ you make per trade
  kellyPct: number;          // optimal position size (Kelly criterion)
  bestDte: string;           // DTE range that works best
  bestTimeOfDay: string;     // morning vs afternoon
  bestRegime: string;        // bull/bear/choppy
  grade: "A+" | "A" | "B" | "C" | "D" | "F";
}

interface OptimalPlaybook {
  dailyBudgetAllocation: { strategy: string; pctOfBudget: number; reasoning: string }[];
  avoidList: { strategy: string; reasoning: string }[];
  topRules: string[];
  estimatedDailyPnl: number;
  confidence: string;
}

export async function GET() {
  try {
    // Alpaca LIVE trades only (this page is Alpaca-scoped). The table has no mode
    // column: "opt_" = live options agent, "live_" = live FUTURES (different page),
    // unprefixed stock_/crypto_ rows = retired paper — all excluded.
    const allTrades = await prisma.autoTradeLog.findMany({
      where: { OR: [{ action: { startsWith: "opt_" } }, { symbol: { startsWith: "OPT:" } }] },
      orderBy: { createdAt: "desc" },
    });

    // Get current positions for context
    let positionCount = 0;
    try {
      const positions = await getPositions("live");
      positionCount = positions.length;
    } catch { /* ignore */ }

    // Get agent config
    let equity = 100000;
    try {
      const configs = await prisma.agentConfig.findMany();
      for (const c of configs) {
        if (c.key === "initial_capital") equity = parseFloat(c.value);
      }
    } catch { /* ignore */ }

    // Categorize all trades by strategy type
    const strategyBuckets: Record<string, typeof allTrades> = {};
    for (const t of allTrades) {
      const strategy = categorize(t.action, t.reason || "");
      if (strategy === "skip" || strategy === "risk_veto") continue;
      if (!strategyBuckets[strategy]) strategyBuckets[strategy] = [];
      strategyBuckets[strategy].push(t);
    }

    // Analyze each strategy
    const strategies: StrategyPerformance[] = [];
    for (const [strategy, trades] of Object.entries(strategyBuckets)) {
      const closed = trades.filter((t) => t.pnl != null);
      if (closed.length === 0) {
        // Still track open strategies
        strategies.push({
          strategy,
          trades: trades.length,
          wins: 0, losses: 0, winRate: 0,
          totalPnl: 0, avgPnl: 0, avgWinPnl: 0, avgLossPnl: 0,
          profitFactor: 0, expectancy: 0, kellyPct: 0,
          bestDte: "N/A", bestTimeOfDay: "N/A", bestRegime: "N/A",
          grade: "C",
        });
        continue;
      }

      const wins = closed.filter((t) => (t.pnl || 0) > 0);
      const losses = closed.filter((t) => (t.pnl || 0) <= 0);
      const winRate = closed.length > 0 ? wins.length / closed.length : 0;
      const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
      const grossProfit = wins.reduce((s, t) => s + (t.pnl || 0), 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
      const avgPnl = closed.length > 0 ? totalPnl / closed.length : 0;
      const avgWinPnl = wins.length > 0 ? grossProfit / wins.length : 0;
      const avgLossPnl = losses.length > 0 ? grossLoss / losses.length : 0;
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

      // Kelly Criterion: f* = (bp - q) / b
      // where b = avg win / avg loss, p = win rate, q = 1 - p
      const b = avgLossPnl > 0 ? avgWinPnl / avgLossPnl : 1;
      const kellyPct = Math.max(0, Math.min(25, ((b * winRate - (1 - winRate)) / b) * 100));

      // Expectancy: how much you make per dollar risked per trade
      const expectancy = (winRate * avgWinPnl) - ((1 - winRate) * avgLossPnl);

      // Analyze DTE patterns
      let bestDte = "N/A";
      const dteGroups: Record<string, number[]> = { "0-7": [], "7-14": [], "14-30": [], "30+": [] };
      for (const t of closed) {
        const dteMatch = t.reason?.match(/(\d+)\s*DTE/);
        if (dteMatch) {
          const dte = parseInt(dteMatch[1]);
          const key = dte <= 7 ? "0-7" : dte <= 14 ? "7-14" : dte <= 30 ? "14-30" : "30+";
          dteGroups[key].push(t.pnl || 0);
        }
      }
      let bestDteAvg = -Infinity;
      for (const [range, pnls] of Object.entries(dteGroups)) {
        if (pnls.length >= 2) {
          const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
          if (avg > bestDteAvg) { bestDteAvg = avg; bestDte = `${range} DTE`; }
        }
      }

      // Analyze time of day
      const morningTrades = closed.filter((t) => new Date(t.createdAt).getHours() < 12);
      const afternoonTrades = closed.filter((t) => new Date(t.createdAt).getHours() >= 12);
      const morningPnl = morningTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const afternoonPnl = afternoonTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const bestTimeOfDay = morningTrades.length >= 2 && afternoonTrades.length >= 2
        ? morningPnl / morningTrades.length > afternoonPnl / afternoonTrades.length ? "Morning" : "Afternoon"
        : "N/A";

      // Analyze regime
      let bestRegime = "N/A";
      const regimePnl: Record<string, number[]> = {};
      for (const t of closed) {
        const regimeMatch = t.reason?.match(/\[(BULL|BEAR|CHOPPY)\]/i);
        if (regimeMatch) {
          const regime = regimeMatch[1].toUpperCase();
          if (!regimePnl[regime]) regimePnl[regime] = [];
          regimePnl[regime].push(t.pnl || 0);
        }
      }
      let bestRegimeAvg = -Infinity;
      for (const [regime, pnls] of Object.entries(regimePnl)) {
        if (pnls.length >= 2) {
          const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
          if (avg > bestRegimeAvg) { bestRegimeAvg = avg; bestRegime = regime; }
        }
      }

      // Grade the strategy
      let grade: StrategyPerformance["grade"] = "C";
      if (closed.length >= 5) {
        if (winRate >= 0.7 && profitFactor >= 2.0) grade = "A+";
        else if (winRate >= 0.6 && profitFactor >= 1.5) grade = "A";
        else if (winRate >= 0.5 && profitFactor >= 1.2) grade = "B";
        else if (winRate >= 0.4 && totalPnl > 0) grade = "C";
        else if (winRate < 0.4 || totalPnl < 0) grade = "D";
        if (totalPnl < -500 || (closed.length >= 5 && winRate < 0.3)) grade = "F";
      }

      strategies.push({
        strategy, trades: trades.length, wins: wins.length, losses: losses.length,
        winRate: Math.round(winRate * 1000) / 10,
        totalPnl: Math.round(totalPnl * 100) / 100,
        avgPnl: Math.round(avgPnl * 100) / 100,
        avgWinPnl: Math.round(avgWinPnl * 100) / 100,
        avgLossPnl: Math.round(avgLossPnl * 100) / 100,
        profitFactor: Math.round(profitFactor * 100) / 100,
        expectancy: Math.round(expectancy * 100) / 100,
        kellyPct: Math.round(kellyPct * 10) / 10,
        bestDte, bestTimeOfDay, bestRegime, grade,
      });
    }

    // Sort by grade then expectancy
    const gradeOrder = { "A+": 0, "A": 1, "B": 2, "C": 3, "D": 4, "F": 5 };
    strategies.sort((a, b) => gradeOrder[a.grade] - gradeOrder[b.grade] || b.expectancy - a.expectancy);

    // Generate optimal playbook
    const playbook = generatePlaybook(strategies, equity);

    return Response.json({
      strategies,
      playbook,
      meta: {
        totalTrades: allTrades.length,
        closedTrades: allTrades.filter((t) => t.pnl != null).length,
        openPositions: positionCount,
        equity,
        dataPoints: allTrades.length,
        needsMoreData: allTrades.filter((t) => t.pnl != null).length < 20,
      },
    });
  } catch (error) {
    console.error("[strategy-optimizer]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

function categorize(action: string, reason: string): string {
  if (action.includes("skip") || action.includes("veto")) return "skip";
  if (action.includes("iron_condor")) return "Iron Condor";
  if (action.includes("sell_bull") || action.includes("sell_bear") || action.includes("spread_sell")) return "Credit Spread";
  if (action.includes("spread_buy") || action.includes("spread_take") || action.includes("spread_stop") || action.includes("spread_expiry")) return "Debit Spread";
  if (action.includes("straddle")) return "Straddle";
  if (action.includes("quick_call") || action.includes("quick_put")) return "Quick Play (7-14 DTE)";
  if (action.includes("earnings")) return "Earnings Play";
  if (action.includes("buy_call")) return "Directional Call";
  if (action.includes("buy_put")) return "Directional Put";
  if (action.includes("premium")) return "Premium Selling";
  if (action === "buy") return "Stock Buy";

  // Check reason for more context
  if (reason.includes("sector_breakout")) return "Sector Breakout";
  if (reason.includes("relative_value") || reason.includes("PAIRS")) return "Relative Value";
  if (reason.includes("gap_")) return "Gap Play";
  if (reason.includes("momentum")) return "Momentum";
  if (reason.includes("oversold")) return "Mean Reversion";

  // Exit types
  if (action.includes("stop_loss")) return "Stop Loss";
  if (action.includes("take_profit") || action.includes("partial_profit")) return "Take Profit";
  if (action.includes("trailing")) return "Trailing Stop";
  if (action.includes("dead_money")) return "Dead Money Exit";
  if (action.includes("breakeven")) return "Breakeven Stop";
  if (action.includes("roll")) return "Roll Forward";
  if (action.includes("expiry")) return "Expiry Close";
  if (action.includes("thesis")) return "Thesis Change";

  return action;
}

function generatePlaybook(strategies: StrategyPerformance[], equity: number): OptimalPlaybook {
  const profitable = strategies.filter((s) =>
    s.grade !== "F" && s.grade !== "D" && !["Stop Loss", "Take Profit", "Trailing Stop", "Dead Money Exit", "Breakeven Stop", "Roll Forward", "Expiry Close", "Thesis Change", "skip", "risk_veto"].includes(s.strategy)
  );

  const losing = strategies.filter((s) =>
    (s.grade === "F" || s.grade === "D") && !["Stop Loss", "Take Profit", "Trailing Stop", "Dead Money Exit", "Breakeven Stop", "Roll Forward", "Expiry Close", "Thesis Change", "skip", "risk_veto"].includes(s.strategy)
  );

  // Allocate budget to profitable strategies proportional to their Kelly %
  const totalKelly = profitable.reduce((s, p) => s + p.kellyPct, 0) || 1;
  const allocation = profitable.map((s) => ({
    strategy: s.strategy,
    pctOfBudget: Math.round((s.kellyPct / totalKelly) * 100),
    reasoning: `${s.grade} grade | ${s.winRate}% WR | ${s.profitFactor}x PF | Kelly: ${s.kellyPct}% | Best at: ${s.bestDte}`,
  }));

  // If no closed trades yet, recommend the theoretical best allocation
  if (profitable.length === 0 || strategies.every((s) => s.trades < 3)) {
    return {
      dailyBudgetAllocation: [
        { strategy: "Iron Condor (SPY/QQQ)", pctOfBudget: 40, reasoning: "Primary income — sell theta on indexes. 65-75% historical win rate." },
        { strategy: "Credit Spread (Large Caps)", pctOfBudget: 25, reasoning: "Secondary income — defined risk premium selling on focus symbols." },
        { strategy: "Directional (High Conviction)", pctOfBudget: 20, reasoning: "Home runs — only when 5/5 experts agree. Score 70+." },
        { strategy: "Quick Play (7-14 DTE)", pctOfBudget: 10, reasoning: "Mechanical setups — RSI extremes, breakouts. Small bets, 1% risk." },
        { strategy: "Cash Reserve", pctOfBudget: 5, reasoning: "Keep powder dry for opportunities." },
      ],
      avoidList: [],
      topRules: [
        "Need 20+ closed trades before optimization is meaningful — current data is insufficient",
        "Premium selling (iron condors + credit spreads) should be 60-65% of daily activity",
        "Directional trades only when AI committee score is 70+ with 80%+ confidence",
        "Max 6 trades per day — quality over quantity",
        "Cut losses at -40% on options, take profits at +50% (or use partial takes)",
      ],
      estimatedDailyPnl: 0,
      confidence: "LOW — need more trade history (minimum 20 closed trades)",
    };
  }

  const avoidList = losing.map((s) => ({
    strategy: s.strategy,
    reasoning: `${s.grade} grade | ${s.winRate}% WR | Lost $${Math.abs(s.totalPnl).toFixed(0)} total | ${s.trades} trades`,
  }));

  // Calculate estimated daily P&L from allocation
  const estimatedDailyPnl = profitable.reduce((s, p) => {
    // If each strategy averages X per trade, and we do ~3 trades/day allocated proportionally
    return s + p.avgPnl * 0.5; // assume ~0.5 trades per strategy per day
  }, 0);

  const topRules: string[] = [];

  // Generate rules from data
  const bestStrategy = profitable[0];
  if (bestStrategy) {
    topRules.push(`Your best strategy is ${bestStrategy.strategy} (${bestStrategy.grade} grade, ${bestStrategy.winRate}% WR) — allocate most budget here`);
  }

  const bestWinRate = strategies.filter((s) => s.trades >= 3).sort((a, b) => b.winRate - a.winRate)[0];
  if (bestWinRate && bestWinRate.winRate >= 60) {
    topRules.push(`Highest win rate: ${bestWinRate.strategy} at ${bestWinRate.winRate}% — lean into this`);
  }

  const worstStrategy = strategies.filter((s) => s.trades >= 3 && s.totalPnl < 0).sort((a, b) => a.totalPnl - b.totalPnl)[0];
  if (worstStrategy) {
    topRules.push(`Stop doing ${worstStrategy.strategy} — lost $${Math.abs(worstStrategy.totalPnl).toFixed(0)} over ${worstStrategy.trades} trades`);
  }

  // DTE insight
  const dteStrategies = strategies.filter((s) => s.bestDte !== "N/A" && s.trades >= 3);
  if (dteStrategies.length > 0) {
    const dteCounts: Record<string, number> = {};
    for (const s of dteStrategies) {
      dteCounts[s.bestDte] = (dteCounts[s.bestDte] || 0) + 1;
    }
    const bestDte = Object.entries(dteCounts).sort(([, a], [, b]) => b - a)[0];
    if (bestDte) topRules.push(`Sweet spot DTE: ${bestDte[0]} performs best across ${bestDte[1]} strategies`);
  }

  // Kelly insight
  const highKelly = strategies.filter((s) => s.kellyPct >= 10).sort((a, b) => b.kellyPct - a.kellyPct);
  if (highKelly.length > 0) {
    topRules.push(`Kelly says size up on ${highKelly[0].strategy} (${highKelly[0].kellyPct}% optimal allocation)`);
  }

  if (topRules.length < 3) {
    topRules.push("Premium selling (iron condors + credit spreads) should be primary income");
    topRules.push("Only do directional trades with 70+ AI score and 80%+ confidence");
    topRules.push("Max 6 trades per day — more trades != more money");
  }

  const closedCount = strategies.reduce((s, st) => s + st.wins + st.losses, 0);
  const confidence = closedCount >= 50 ? "HIGH" : closedCount >= 20 ? "MODERATE" : "LOW — need more trade data";

  return {
    dailyBudgetAllocation: allocation,
    avoidList,
    topRules,
    estimatedDailyPnl: Math.round(estimatedDailyPnl * 100) / 100,
    confidence,
  };
}
