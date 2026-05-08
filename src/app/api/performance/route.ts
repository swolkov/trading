import { prisma } from "@/lib/db";
import { getPositions } from "@/lib/alpaca";

export async function GET() {
  try {
    // Get all trades with P&L
    const allTrades = await prisma.autoTradeLog.findMany({
      orderBy: { createdAt: "desc" },
    });

    // Get actual open positions from Alpaca (source of truth)
    let livePositionCount = 0;
    try {
      const positions = await getPositions();
      livePositionCount = positions.length;
    } catch {
      // fallback to log-based count if Alpaca unavailable
      livePositionCount = allTrades.filter((t) => t.pnl == null && !t.action.includes("skip") && !t.action.includes("veto")).length;
    }

    const closedTrades = allTrades.filter((t) => t.pnl != null && t.pnl !== 0);
    const wins = closedTrades.filter((t) => (t.pnl || 0) > 0);
    const losses = closedTrades.filter((t) => (t.pnl || 0) < 0);

    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const grossProfit = wins.reduce((s, t) => s + (t.pnl || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
    const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
    const expectancy = closedTrades.length > 0 ? totalPnl / closedTrades.length : 0;

    // Max drawdown calculation
    let peak = 0;
    let maxDrawdown = 0;
    let runningPnl = 0;
    for (const t of closedTrades.reverse()) {
      runningPnl += t.pnl || 0;
      if (runningPnl > peak) peak = runningPnl;
      const dd = peak - runningPnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Strategy breakdown
    const byStrategy: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of allTrades) {
      const strategy = categorizeStrategy(t.action);
      if (!byStrategy[strategy]) byStrategy[strategy] = { trades: 0, wins: 0, pnl: 0 };
      byStrategy[strategy].trades++;
      if ((t.pnl || 0) > 0) byStrategy[strategy].wins++;
      byStrategy[strategy].pnl += t.pnl || 0;
    }

    // Symbol breakdown
    const bySymbol: Record<string, { trades: number; wins: number; pnl: number }> = {};
    for (const t of closedTrades) {
      // Extract underlying
      const underlying = t.symbol.replace(/\d.*$/, "");
      if (!bySymbol[underlying]) bySymbol[underlying] = { trades: 0, wins: 0, pnl: 0 };
      bySymbol[underlying].trades++;
      if ((t.pnl || 0) > 0) bySymbol[underlying].wins++;
      bySymbol[underlying].pnl += t.pnl || 0;
    }

    // Daily P&L
    const dailyPnl: Record<string, number> = {};
    for (const t of closedTrades) {
      const date = new Date(t.createdAt).toISOString().split("T")[0];
      dailyPnl[date] = (dailyPnl[date] || 0) + (t.pnl || 0);
    }

    // Recent trades for the table
    const recentTrades = allTrades
      .filter((t) => !t.action.includes("skip") && !t.action.includes("veto"))
      .slice(0, 30)
      .map((t) => ({
        symbol: t.symbol,
        action: t.action,
        qty: t.qty,
        price: t.price,
        pnl: t.pnl,
        score: t.aiScore,
        signal: t.aiSignal,
        reason: t.reason?.slice(0, 150) || "",
        time: t.createdAt,
      }));

    // Agent runs
    const runs = await prisma.agentRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const totalRuns = runs.length;
    const avgDuration = runs.length > 0 ? runs.reduce((s, r) => s + r.durationMs, 0) / runs.length / 1000 : 0;
    const totalScanned = runs.reduce((s, r) => s + r.stocksScanned, 0);

    // Streak
    let currentStreak = 0;
    let streakType = "";
    for (const t of closedTrades.reverse()) {
      if (streakType === "") {
        streakType = (t.pnl || 0) > 0 ? "win" : "loss";
        currentStreak = 1;
      } else if ((streakType === "win" && (t.pnl || 0) > 0) || (streakType === "loss" && (t.pnl || 0) < 0)) {
        currentStreak++;
      } else {
        break;
      }
    }

    return Response.json({
      overview: {
        totalTrades: closedTrades.length,
        openTrades: livePositionCount,
        winRate: Math.round(winRate * 10) / 10,
        profitFactor: Math.round(profitFactor * 100) / 100,
        totalPnl: Math.round(totalPnl * 100) / 100,
        grossProfit: Math.round(grossProfit * 100) / 100,
        grossLoss: Math.round(grossLoss * 100) / 100,
        avgWin: Math.round(avgWin * 100) / 100,
        avgLoss: Math.round(avgLoss * 100) / 100,
        maxDrawdown: Math.round(maxDrawdown * 100) / 100,
        expectancy: Math.round(expectancy * 100) / 100,
        currentStreak: `${currentStreak} ${streakType}${currentStreak !== 1 ? "s" : ""}`,
        bestTrade: wins.length > 0 ? Math.max(...wins.map((t) => t.pnl || 0)) : 0,
        worstTrade: losses.length > 0 ? Math.min(...losses.map((t) => t.pnl || 0)) : 0,
      },
      agent: {
        totalRuns,
        avgDuration: Math.round(avgDuration * 10) / 10,
        totalScanned,
      },
      byStrategy: Object.entries(byStrategy).map(([strategy, data]) => ({
        strategy,
        trades: data.trades,
        winRate: data.trades > 0 ? Math.round((data.wins / data.trades) * 1000) / 10 : 0,
        pnl: Math.round(data.pnl * 100) / 100,
      })).sort((a, b) => b.pnl - a.pnl),
      bySymbol: Object.entries(bySymbol).map(([symbol, data]) => ({
        symbol,
        trades: data.trades,
        winRate: data.trades > 0 ? Math.round((data.wins / data.trades) * 1000) / 10 : 0,
        pnl: Math.round(data.pnl * 100) / 100,
      })).sort((a, b) => b.pnl - a.pnl),
      dailyPnl: Object.entries(dailyPnl).sort(([a], [b]) => a.localeCompare(b)).map(([date, pnl]) => ({
        date,
        pnl: Math.round(pnl * 100) / 100,
      })),
      recentTrades,
    });
  } catch (error) {
    console.error("[/api/performance]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

function categorizeStrategy(action: string): string {
  if (action.includes("iron_condor")) return "Iron Condor";
  if (action.includes("spread") || action.includes("sell_bull") || action.includes("sell_bear")) return "Credit Spread";
  if (action.includes("straddle")) return "Straddle";
  if (action.includes("buy_call") || action.includes("earnings_call")) return "Buy Calls";
  if (action.includes("buy_put") || action.includes("earnings_put")) return "Buy Puts";
  if (action.includes("stop_loss")) return "Stop Loss";
  if (action.includes("take_profit")) return "Take Profit";
  if (action.includes("roll")) return "Roll Forward";
  if (action.includes("expiry")) return "Expiry Close";
  if (action.includes("trailing")) return "Trailing Stop";
  if (action.includes("thesis")) return "Thesis Change";
  if (action === "buy") return "Stock Buy";
  if (action === "sell") return "Stock Sell";
  return action;
}
