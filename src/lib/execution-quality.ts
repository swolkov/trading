import { prisma } from "./db";
import { getQuote, getOrders, getAccountActivities, type Quote, type Order } from "./alpaca";
import { sendNotification } from "./notifications";

// ============ EXECUTION QUALITY AGENT ============
// Measures and tracks how well we execute trades.
// Top shops measure: expected vs actual fill, spread impact, slippage.
// "You can't improve what you don't measure."

export interface ExecutionMetrics {
  symbol: string;
  orderId: string;
  side: "buy" | "sell";
  orderType: string;
  // Prices
  expectedPrice: number; // mid-price at order time
  fillPrice: number;
  bidAtFill: number;
  askAtFill: number;
  spread: number;
  spreadPct: number;
  // Slippage
  slippageDollars: number; // difference between expected and actual
  slippageBps: number; // basis points
  slippagePctOfSpread: number; // what % of spread we gave up
  // Quality grade
  grade: "A" | "B" | "C" | "D" | "F";
  gradeReason: string;
  timestamp: string;
}

export interface ExecutionReport {
  period: string;
  totalFills: number;
  avgSlippageBps: number;
  totalSlippageDollars: number;
  gradeDistribution: Record<string, number>;
  worstFills: ExecutionMetrics[];
  recommendations: string[];
}

// Score a single execution
function gradeExecution(metrics: {
  slippageBps: number;
  slippagePctOfSpread: number;
  spreadPct: number;
}): { grade: "A" | "B" | "C" | "D" | "F"; reason: string } {
  const { slippageBps, slippagePctOfSpread, spreadPct } = metrics;

  // Excellent: filled at or better than mid, or slippage < 2bps
  if (slippageBps <= 2) return { grade: "A", reason: "Near-zero slippage" };

  // Good: slippage < 25% of spread
  if (slippagePctOfSpread < 25 && slippageBps < 10) return { grade: "B", reason: "Minor slippage, within tolerance" };

  // Acceptable: slippage < 50% of spread
  if (slippagePctOfSpread < 50 && slippageBps < 20) return { grade: "C", reason: "Moderate slippage" };

  // Poor: slippage > 50% of spread or > 20bps
  if (slippagePctOfSpread < 75 || slippageBps < 50) return { grade: "D", reason: "Significant slippage — consider limit orders" };

  // Terrible: full spread or worse
  return { grade: "F", reason: `Extreme slippage (${slippageBps.toFixed(0)}bps) — review order type and timing` };
}

// Analyze a single fill against market conditions at fill time
export async function analyzeExecution(
  order: Order,
  quoteAtFill?: Quote
): Promise<ExecutionMetrics | null> {
  if (!order.filled_avg_price || !order.filled_at) return null;

  const fillPrice = parseFloat(order.filled_avg_price);
  const symbol = order.symbol;

  // Get current/recent quote if not provided
  let quote = quoteAtFill;
  if (!quote) {
    try {
      quote = await getQuote(symbol.length > 10 ? symbol.replace(/\d.*$/, "") : symbol);
    } catch {
      return null; // Can't analyze without quote data
    }
  }

  const bid = quote.bp;
  const ask = quote.ap;
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;

  // Calculate slippage — positive = bad (we paid more / received less than mid)
  let slippageDollars: number;
  if (order.side === "buy") {
    slippageDollars = (fillPrice - mid) * parseFloat(order.filled_qty);
  } else {
    slippageDollars = (mid - fillPrice) * parseFloat(order.filled_qty);
  }

  const slippageBps = mid > 0 ? Math.abs((fillPrice - mid) / mid) * 10000 : 0;
  const slippagePctOfSpread = spread > 0 ? Math.abs(fillPrice - mid) / spread * 100 : 0;

  const { grade, reason } = gradeExecution({ slippageBps, slippagePctOfSpread, spreadPct });

  return {
    symbol,
    orderId: order.id,
    side: order.side as "buy" | "sell",
    orderType: order.type,
    expectedPrice: mid,
    fillPrice,
    bidAtFill: bid,
    askAtFill: ask,
    spread,
    spreadPct,
    slippageDollars,
    slippageBps,
    slippagePctOfSpread,
    grade,
    gradeReason: reason,
    timestamp: order.filled_at,
  };
}

// Run the execution quality review — analyzes recent fills
export async function runExecutionReview(): Promise<ExecutionReport> {
  const startTime = Date.now();
  const allMetrics: ExecutionMetrics[] = [];
  const recommendations: string[] = [];

  try {
    // Get recent filled orders (last 24 hours)
    const orders = await getOrders("closed");
    const recentFills = orders.filter((o) => {
      if (o.status !== "filled" || !o.filled_at) return false;
      const fillAge = Date.now() - new Date(o.filled_at).getTime();
      return fillAge < 24 * 60 * 60 * 1000;
    });

    // Analyze each fill
    for (const order of recentFills.slice(0, 30)) {
      try {
        const metrics = await analyzeExecution(order);
        if (metrics) allMetrics.push(metrics);
      } catch {
        // Skip individual failures
      }
    }

    // Calculate aggregate stats
    const avgSlippageBps = allMetrics.length > 0
      ? allMetrics.reduce((sum, m) => sum + m.slippageBps, 0) / allMetrics.length
      : 0;

    const totalSlippageDollars = allMetrics.reduce((sum, m) => sum + Math.abs(m.slippageDollars), 0);

    const gradeDistribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    for (const m of allMetrics) gradeDistribution[m.grade]++;

    // Sort worst fills
    const worstFills = [...allMetrics].sort((a, b) => b.slippageBps - a.slippageBps).slice(0, 5);

    // Generate recommendations
    if (avgSlippageBps > 15) {
      recommendations.push("Average slippage is high — switch from market orders to aggressive limit orders (mid + 25% of spread)");
    }
    if (gradeDistribution.D + gradeDistribution.F > allMetrics.length * 0.3) {
      recommendations.push("30%+ of fills are poor quality — consider using IOC limit orders instead of market orders");
    }

    const wideSpreadSymbols = allMetrics.filter((m) => m.spreadPct > 0.5).map((m) => m.symbol);
    if (wideSpreadSymbols.length > 0) {
      const unique = [...new Set(wideSpreadSymbols)];
      recommendations.push(`Wide spreads detected on: ${unique.join(", ")} — use limit orders or avoid these symbols`);
    }

    const optionFills = allMetrics.filter((m) => m.symbol.length > 10);
    if (optionFills.length > 0) {
      const avgOptSlippage = optionFills.reduce((s, m) => s + m.slippageBps, 0) / optionFills.length;
      if (avgOptSlippage > 25) {
        recommendations.push(`Options slippage averaging ${avgOptSlippage.toFixed(0)}bps — always use limit orders for options`);
      }
    }

    // Store execution metrics in AgentConfig for dashboard
    await prisma.agentConfig.upsert({
      where: { key: "execution_quality_report" },
      update: {
        value: JSON.stringify({
          lastRun: new Date().toISOString(),
          totalFills: allMetrics.length,
          avgSlippageBps: avgSlippageBps.toFixed(1),
          totalSlippageDollars: totalSlippageDollars.toFixed(2),
          grades: gradeDistribution,
          worstSymbols: worstFills.map((f) => `${f.symbol}: ${f.slippageBps.toFixed(0)}bps`),
          recommendations,
        }),
      },
      create: {
        key: "execution_quality_report",
        value: JSON.stringify({
          lastRun: new Date().toISOString(),
          totalFills: allMetrics.length,
          avgSlippageBps: avgSlippageBps.toFixed(1),
          totalSlippageDollars: totalSlippageDollars.toFixed(2),
          grades: gradeDistribution,
          recommendations,
        }),
      },
    });

    // Alert on bad execution quality
    if (totalSlippageDollars > 50 || avgSlippageBps > 20) {
      await sendNotification(
        `📊 EXECUTION QUALITY ALERT:\n• Avg slippage: ${avgSlippageBps.toFixed(1)}bps\n• Total cost: $${totalSlippageDollars.toFixed(2)}\n• Grades: A:${gradeDistribution.A} B:${gradeDistribution.B} C:${gradeDistribution.C} D:${gradeDistribution.D} F:${gradeDistribution.F}\n${recommendations.length > 0 ? "• " + recommendations[0] : ""}`,
        "general"
      );
    }

    const summary = `Execution: ${allMetrics.length} fills analyzed — avg ${avgSlippageBps.toFixed(1)}bps slippage, $${totalSlippageDollars.toFixed(2)} total cost`;

    await prisma.agentRun.create({
      data: {
        runType: "execution_quality",
        stocksScanned: allMetrics.length,
        tradesPlaced: 0,
        positionsManaged: 0,
        errors: 0,
        summary,
        durationMs: Date.now() - startTime,
      },
    });

    return {
      period: "24h",
      totalFills: allMetrics.length,
      avgSlippageBps,
      totalSlippageDollars,
      gradeDistribution,
      worstFills,
      recommendations,
    };
  } catch (err) {
    const summary = `Execution quality review failed: ${err}`;
    await prisma.agentRun.create({
      data: {
        runType: "execution_quality",
        stocksScanned: 0,
        tradesPlaced: 0,
        positionsManaged: 0,
        errors: 1,
        summary,
        durationMs: Date.now() - startTime,
      },
    });
    return {
      period: "24h",
      totalFills: 0,
      avgSlippageBps: 0,
      totalSlippageDollars: 0,
      gradeDistribution: { A: 0, B: 0, C: 0, D: 0, F: 0 },
      worstFills: [],
      recommendations: [`Review failed: ${err}`],
    };
  }
}

// Pre-trade execution check — call this before placing an order
// Returns recommended order type and limit price
export function getExecutionAdvice(
  symbol: string,
  side: "buy" | "sell",
  bid: number,
  ask: number,
  qty: number
): {
  recommendedType: "market" | "limit";
  limitPrice?: number;
  reason: string;
} {
  const spread = ask - bid;
  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;
  const isOptions = symbol.length > 10;
  const notionalValue = mid * qty;

  // Always use limit orders for options — spreads are wide
  if (isOptions) {
    const limitPrice = side === "buy"
      ? parseFloat((mid + spread * 0.15).toFixed(2)) // slightly above mid
      : parseFloat((mid - spread * 0.15).toFixed(2)); // slightly below mid
    return {
      recommendedType: "limit",
      limitPrice,
      reason: `Options: limit at ${side === "buy" ? "mid+15%" : "mid-15%"} of spread ($${limitPrice.toFixed(2)})`,
    };
  }

  // Wide spread stocks (> 0.3%) — use limit
  if (spreadPct > 0.3) {
    const limitPrice = side === "buy"
      ? parseFloat((mid + spread * 0.25).toFixed(2))
      : parseFloat((mid - spread * 0.25).toFixed(2));
    return {
      recommendedType: "limit",
      limitPrice,
      reason: `Wide spread (${spreadPct.toFixed(2)}%) — limit at mid+25% of spread`,
    };
  }

  // Large notional (> $5k) — use limit to control impact
  if (notionalValue > 5000) {
    const limitPrice = side === "buy"
      ? parseFloat((ask * 0.999).toFixed(2)) // just below ask
      : parseFloat((bid * 1.001).toFixed(2)); // just above bid
    return {
      recommendedType: "limit",
      limitPrice,
      reason: `Large order ($${notionalValue.toFixed(0)}) — limit near ${side === "buy" ? "ask" : "bid"}`,
    };
  }

  // Tight spread, small order — market is fine
  return {
    recommendedType: "market",
    reason: `Tight spread (${spreadPct.toFixed(2)}%), small notional — market order ok`,
  };
}
