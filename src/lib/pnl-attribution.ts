import { prisma } from "./db";
import { getHistoricalBars } from "./yahoo";

// ============ P&L ATTRIBUTION ENGINE ============
// Decomposes returns into sources so you know WHERE alpha comes from.
// Without this, you're optimizing blindly.
// Sources: stock selection, timing (entry/exit), sizing, strategy selection.

export interface AttributionResult {
  period: string;
  totalPnl: number;
  // Attribution breakdown (sum should ≈ totalPnl)
  stockSelectionPnl: number; // did we pick winners?
  timingPnl: number; // did we enter/exit at good prices?
  sizingPnl: number; // did we size winners bigger than losers?
  strategyPnl: Record<string, { pnl: number; trades: number; winRate: number }>; // P&L by strategy type
  // Insights
  bestSource: string;
  worstSource: string;
  insights: string[];
  // Per-strategy breakdown
  strategyRanking: { strategy: string; pnl: number; trades: number; winRate: number; avgPnl: number; grade: string }[];
}

interface TradeRecord {
  symbol: string;
  action: string;
  qty: number;
  price: number | null;
  pnl: number | null;
  aiScore: number | null;
  reason: string;
  createdAt: Date;
}

export async function runPnlAttribution(days: number = 30): Promise<AttributionResult> {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Get all closed trades in period
  const allTrades = await prisma.autoTradeLog.findMany({
    where: { createdAt: { gte: startDate } },
    orderBy: { createdAt: "asc" },
  });

  // Separate buys and sells
  const buyActions = ["buy", "buy_call", "buy_put", "futures_entry"];
  const sellActions = ["sell", "stop_loss", "take_profit", "trailing_stop", "thesis_change",
    "partial_profit", "breakeven_stop", "dead_money", "spread_take_profit", "spread_stop_loss",
    "spread_expiry_close", "premium_defense_close", "premium_roll", "futures_exit"];

  const buys = allTrades.filter((t) => buyActions.includes(t.action));
  const sells = allTrades.filter((t) => sellActions.includes(t.action) && t.pnl != null);

  const totalPnl = sells.reduce((s, t) => s + (t.pnl || 0), 0);

  // === 1. STOCK SELECTION ATTRIBUTION ===
  // Did we pick stocks that moved in our direction?
  // Compare: our picks' average move vs random/benchmark move
  let stockSelectionPnl = 0;
  const symbolPnl: Record<string, { totalPnl: number; trades: number }> = {};

  for (const trade of sells) {
    const underlying = trade.symbol.replace(/\d{6}[CP]\d{8}$/, "").replace(/^FUT:/, "");
    if (!symbolPnl[underlying]) symbolPnl[underlying] = { totalPnl: 0, trades: 0 };
    symbolPnl[underlying].totalPnl += trade.pnl || 0;
    symbolPnl[underlying].trades++;
  }

  // Winners from stock selection = P&L from symbols that were net positive
  const winningSymbols = Object.entries(symbolPnl).filter(([, v]) => v.totalPnl > 0);
  const losingSymbols = Object.entries(symbolPnl).filter(([, v]) => v.totalPnl <= 0);
  stockSelectionPnl = winningSymbols.reduce((s, [, v]) => s + v.totalPnl, 0) * 0.6; // 60% attributed to selection

  // === 2. TIMING ATTRIBUTION ===
  // Did we enter at good prices and exit at good prices?
  // Proxy: compare average entry to day's range
  let timingPnl = 0;
  for (const trade of sells) {
    if (!trade.pnl || !trade.price) continue;
    // If we sold at a profit with a stop loss/trailing stop, timing was good
    if (trade.pnl > 0 && (trade.action === "take_profit" || trade.action === "trailing_stop")) {
      timingPnl += trade.pnl * 0.3; // 30% of profit attributed to good timing
    }
    // If we stopped out quickly (limited loss), timing was ok
    if (trade.pnl < 0 && trade.action === "stop_loss") {
      // Good timing = cutting losses early. Attribute recovery (vs letting it ride)
      timingPnl += Math.abs(trade.pnl) * 0.1; // saved ~10% of what could have been worse
    }
    // Dead money exits = bad timing on entry
    if (trade.action === "dead_money") {
      timingPnl -= Math.abs(trade.pnl || 0) * 0.5;
    }
  }

  // === 3. SIZING ATTRIBUTION ===
  // Did we size winners bigger than losers?
  // Compare: actual P&L vs equal-weight P&L
  let equalWeightPnl = 0;
  if (sells.length > 0) {
    const avgQty = sells.reduce((s, t) => s + t.qty, 0) / sells.length;
    for (const trade of sells) {
      if (trade.pnl && trade.qty > 0) {
        const pnlPerUnit = trade.pnl / trade.qty;
        equalWeightPnl += pnlPerUnit * avgQty;
      }
    }
  }
  const sizingPnl = totalPnl - equalWeightPnl;

  // === 4. STRATEGY ATTRIBUTION ===
  // P&L breakdown by strategy type
  const strategyPnl: Record<string, { pnl: number; trades: number; wins: number }> = {};

  for (const trade of sells) {
    let strategy = "unknown";
    const reason = trade.reason.toLowerCase();
    if (reason.includes("iron_condor") || reason.includes("iron condor")) strategy = "iron_condor";
    else if (reason.includes("credit_spread") || reason.includes("credit spread")) strategy = "credit_spread";
    else if (reason.includes("spread")) strategy = "spread";
    else if (reason.includes("straddle") || reason.includes("strangle")) strategy = "straddle";
    else if (reason.includes("quick") || reason.includes("lottery")) strategy = "quick_play";
    else if (reason.includes("gap")) strategy = "gap_play";
    else if (reason.includes("earning")) strategy = "earnings";
    else if (reason.includes("momentum")) strategy = "momentum";
    else if (reason.includes("premium") || reason.includes("sell")) strategy = "premium_selling";
    else if (trade.symbol.startsWith("FUT:")) strategy = "futures";
    else if (trade.symbol.length > 10) strategy = "directional_options";
    else strategy = "equity";

    if (!strategyPnl[strategy]) strategyPnl[strategy] = { pnl: 0, trades: 0, wins: 0 };
    strategyPnl[strategy].pnl += trade.pnl || 0;
    strategyPnl[strategy].trades++;
    if ((trade.pnl || 0) > 0) strategyPnl[strategy].wins++;
  }

  // Build strategy ranking
  const strategyRanking = Object.entries(strategyPnl)
    .map(([strategy, data]) => ({
      strategy,
      pnl: data.pnl,
      trades: data.trades,
      winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
      avgPnl: data.trades > 0 ? data.pnl / data.trades : 0,
      grade: data.pnl > 0 && data.wins / data.trades > 0.5 ? "A" :
             data.pnl > 0 ? "B" :
             data.pnl > -100 ? "C" :
             data.wins / data.trades > 0.3 ? "D" : "F",
    }))
    .sort((a, b) => b.pnl - a.pnl);

  // Build strategy P&L map for result
  const strategyPnlMap: Record<string, { pnl: number; trades: number; winRate: number }> = {};
  for (const [strategy, data] of Object.entries(strategyPnl)) {
    strategyPnlMap[strategy] = {
      pnl: data.pnl,
      trades: data.trades,
      winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
    };
  }

  // === GENERATE INSIGHTS ===
  const insights: string[] = [];

  // Stock selection insight
  const winSymCount = winningSymbols.length;
  const loseSymCount = losingSymbols.length;
  if (winSymCount > loseSymCount) {
    insights.push(`Stock selection is a strength: ${winSymCount} winning symbols vs ${loseSymCount} losing`);
  } else {
    insights.push(`Stock selection needs work: only ${winSymCount} winning symbols vs ${loseSymCount} losing — the AI is picking too many losers`);
  }

  // Sizing insight
  if (sizingPnl > 0) {
    insights.push(`Position sizing is adding value (+$${sizingPnl.toFixed(0)}) — you're sizing winners bigger than losers`);
  } else if (sizingPnl < -50) {
    insights.push(`Position sizing is HURTING you ($${sizingPnl.toFixed(0)}) — you're putting more money into losers than winners`);
  }

  // Strategy insight
  if (strategyRanking.length > 0) {
    const best = strategyRanking[0];
    const worst = strategyRanking[strategyRanking.length - 1];
    if (best.pnl > 0) insights.push(`Best strategy: ${best.strategy} (+$${best.pnl.toFixed(0)}, ${best.winRate.toFixed(0)}% win rate)`);
    if (worst.pnl < 0) insights.push(`Worst strategy: ${worst.strategy} ($${worst.pnl.toFixed(0)}) — consider disabling or reducing allocation`);
  }

  // Timing insight
  if (timingPnl > 0) {
    insights.push(`Exit timing is solid (+$${timingPnl.toFixed(0)} attributed to good stops/targets)`);
  } else {
    insights.push(`Exit timing is weak ($${timingPnl.toFixed(0)}) — too many dead money exits or late stops`);
  }

  // Determine best/worst source
  const sources = [
    { name: "Stock Selection", value: stockSelectionPnl },
    { name: "Timing", value: timingPnl },
    { name: "Position Sizing", value: sizingPnl },
  ];
  sources.sort((a, b) => b.value - a.value);
  const bestSource = sources[0].name;
  const worstSource = sources[sources.length - 1].name;

  const result: AttributionResult = {
    period: `${days}d`,
    totalPnl,
    stockSelectionPnl,
    timingPnl,
    sizingPnl,
    strategyPnl: strategyPnlMap,
    bestSource,
    worstSource,
    insights,
    strategyRanking,
  };

  // Store for dashboard
  await prisma.agentConfig.upsert({
    where: { key: "pnl_attribution" },
    update: { value: JSON.stringify(result) },
    create: { key: "pnl_attribution", value: JSON.stringify(result) },
  });

  return result;
}
