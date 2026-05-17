interface RoundTrip {
  symbol: string;
  direction: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
}

interface DayEntry {
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  label: string;
  hasBalanceData?: boolean;
}

interface WeekEntry {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  label: string;
}

export interface FuturesStats {
  // Core
  totalPnl: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;

  // Advanced
  expectancy: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeRatio: number | null; // null if <5 trading days
  currentStreak: { type: "win" | "loss" | "none"; count: number };
  longestWinStreak: number;
  longestLossStreak: number;

  // Extremes
  bestTrade: { pnl: number; symbol: string; date: string } | null;
  worstTrade: { pnl: number; symbol: string; date: string } | null;
  bestDay: { pnl: number; date: string } | null;
  worstDay: { pnl: number; date: string } | null;
  bestWeek: { pnl: number; label: string } | null;
  worstWeek: { pnl: number; label: string } | null;

  // Summaries
  totalTradingDays: number;
  greenDays: number;
  redDays: number;
  avgTradesPerDay: number;

  // Equity curve points
  equityCurve: { date: string; cumPnl: number; tradePnl: number; symbol: string }[];
}

export function computeFuturesStats(
  roundTrips: RoundTrip[],
  dayMap: Record<string, DayEntry>,
  weekMap: Record<string, WeekEntry>,
  startingCapital: number,
): FuturesStats {
  const sorted = [...roundTrips].sort(
    (a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
  );

  const wins = sorted.filter((rt) => rt.pnl > 0);
  const losses = sorted.filter((rt) => rt.pnl < 0);
  const totalPnl = sorted.reduce((s, rt) => s + rt.pnl, 0);
  const winRate = sorted.length > 0 ? (wins.length / sorted.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, rt) => s + rt.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, rt) => s + rt.pnl, 0) / losses.length : 0;
  const grossProfit = wins.reduce((s, rt) => s + rt.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, rt) => s + rt.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Expectancy
  const lossRate = sorted.length > 0 ? (losses.length / sorted.length) * 100 : 0;
  const expectancy =
    sorted.length > 0
      ? ((winRate / 100) * avgWin + (lossRate / 100) * avgLoss)
      : 0;

  // Max drawdown from cumulative P&L
  let peak = 0;
  let maxDD = 0;
  let cumPnl = 0;
  for (const rt of sorted) {
    cumPnl += rt.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdownPct = startingCapital > 0 ? (maxDD / startingCapital) * 100 : 0;

  // Streaks
  let currentType: "win" | "loss" | "none" = "none";
  let currentCount = 0;
  let longestWin = 0;
  let longestLoss = 0;
  let streakType: "win" | "loss" | "none" = "none";
  let streakCount = 0;

  for (const rt of sorted) {
    if (rt.pnl === 0) continue; // breakeven doesn't affect streak
    const isWin = rt.pnl > 0;
    if (isWin) {
      if (streakType === "win") {
        streakCount++;
      } else {
        streakType = "win";
        streakCount = 1;
      }
      if (streakCount > longestWin) longestWin = streakCount;
    } else {
      if (streakType === "loss") {
        streakCount++;
      } else {
        streakType = "loss";
        streakCount = 1;
      }
      if (streakCount > longestLoss) longestLoss = streakCount;
    }
  }
  currentType = streakType;
  currentCount = streakCount;

  // Sharpe ratio from daily P&L — only use days with real balance data
  const dayEntries = Object.values(dayMap);
  const balanceDays = dayEntries.filter((d) => d.hasBalanceData);
  let sharpeRatio: number | null = null;
  if (balanceDays.length >= 5) {
    const dailyPnls = balanceDays.map((d) => d.totalPnl);
    const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
    const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyPnls.length;
    const stddev = Math.sqrt(variance);
    sharpeRatio = stddev > 0 ? (mean / stddev) * Math.sqrt(252) : 0;
  }

  // Best/worst trade
  const bestTrade = sorted.length > 0
    ? sorted.reduce((best, rt) => (rt.pnl > best.pnl ? rt : best), sorted[0])
    : null;
  const worstTrade = sorted.length > 0
    ? sorted.reduce((worst, rt) => (rt.pnl < worst.pnl ? rt : worst), sorted[0])
    : null;

  // Best/worst day — only from days with real balance data
  const dayKeysWithPnl = Object.keys(dayMap).filter((k) => dayMap[k].hasBalanceData).sort();
  const bestDay = dayKeysWithPnl.length > 0
    ? dayKeysWithPnl.reduce((best, k) => (dayMap[k].totalPnl > dayMap[best].totalPnl ? k : best), dayKeysWithPnl[0])
    : null;
  const worstDay = dayKeysWithPnl.length > 0
    ? dayKeysWithPnl.reduce((worst, k) => (dayMap[k].totalPnl < dayMap[worst].totalPnl ? k : worst), dayKeysWithPnl[0])
    : null;

  // Best/worst week
  const weekKeys = Object.keys(weekMap);
  const bestWeek = weekKeys.length > 0
    ? weekKeys.reduce((best, k) => (weekMap[k].pnl > weekMap[best].pnl ? k : best), weekKeys[0])
    : null;
  const worstWeek = weekKeys.length > 0
    ? weekKeys.reduce((worst, k) => (weekMap[k].pnl < weekMap[worst].pnl ? k : worst), weekKeys[0])
    : null;

  // Day summaries — only count days with real balance data for green/red
  const daysWithPnl = dayEntries.filter((d) => d.hasBalanceData || d.trades > 0);
  const greenDays = daysWithPnl.filter((d) => d.totalPnl > 0).length;
  const redDays = daysWithPnl.filter((d) => d.totalPnl < 0).length;
  const avgTradesPerDay = daysWithPnl.length > 0 ? sorted.length / daysWithPnl.length : 0;

  // Equity curve
  let runningPnl = 0;
  const equityCurve = sorted.map((rt) => {
    runningPnl += rt.pnl;
    return {
      date: rt.exitTime,
      cumPnl: runningPnl,
      tradePnl: rt.pnl,
      symbol: rt.symbol,
    };
  });

  return {
    totalPnl,
    tradeCount: sorted.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    expectancy,
    maxDrawdown: maxDD,
    maxDrawdownPct,
    sharpeRatio,
    currentStreak: { type: currentType, count: currentCount },
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
    bestTrade: bestTrade ? { pnl: bestTrade.pnl, symbol: bestTrade.symbol, date: bestTrade.exitTime } : null,
    worstTrade: worstTrade ? { pnl: worstTrade.pnl, symbol: worstTrade.symbol, date: worstTrade.exitTime } : null,
    bestDay: bestDay ? { pnl: dayMap[bestDay].totalPnl, date: dayMap[bestDay].label } : null,
    worstDay: worstDay ? { pnl: dayMap[worstDay].totalPnl, date: dayMap[worstDay].label } : null,
    bestWeek: bestWeek ? { pnl: weekMap[bestWeek].pnl, label: weekMap[bestWeek].label } : null,
    worstWeek: worstWeek ? { pnl: weekMap[worstWeek].pnl, label: weekMap[worstWeek].label } : null,
    totalTradingDays: daysWithPnl.length,
    greenDays,
    redDays,
    avgTradesPerDay,
    equityCurve,
  };
}
