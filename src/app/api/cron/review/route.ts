import { getPositions, getAccount } from "@/lib/alpaca";
import { generateLearningInsights } from "@/lib/learning-engine";
import { sendNotification } from "@/lib/notifications";
import { prisma } from "@/lib/db";

export const maxDuration = 120;

// ============ POST-MARKET REVIEW AGENT ============
// Runs at 4:30 PM ET (20:30 UTC) after market close.
// Reviews the day's performance, extracts lessons, updates learning engine.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // 1. Today's trades
    const todayTrades = await prisma.autoTradeLog.findMany({
      where: { createdAt: { gte: todayStart } },
      orderBy: { createdAt: "desc" },
    });

    const buys = todayTrades.filter((t) => t.action.includes("buy") || t.action.includes("iron") || t.action.includes("sell_bull") || t.action.includes("sell_bear"));
    const closes = todayTrades.filter((t) => t.pnl != null);
    const todayPnl = closes.reduce((s, t) => s + (t.pnl || 0), 0);
    const todayWins = closes.filter((t) => (t.pnl || 0) > 0).length;
    const todayLosses = closes.filter((t) => (t.pnl || 0) <= 0).length;

    // 2. Today's agent runs
    const todayRuns = await prisma.agentRun.findMany({
      where: { createdAt: { gte: todayStart } },
      orderBy: { createdAt: "desc" },
    });

    const totalScanned = todayRuns.reduce((s, r) => s + r.stocksScanned, 0);
    const totalErrors = todayRuns.reduce((s, r) => s + r.errors, 0);

    // 3. Current portfolio state
    let portfolioSummary = "";
    try {
      const account = await getAccount();
      const positions = await getPositions();
      const equity = parseFloat(account.equity);
      const dailyChange = equity - parseFloat(account.last_equity);
      const dailyPct = (dailyChange / parseFloat(account.last_equity)) * 100;

      const posWinners = positions.filter((p) => parseFloat(p.unrealized_pl) > 0).length;
      const posLosers = positions.filter((p) => parseFloat(p.unrealized_pl) < 0).length;
      const totalUnrealized = positions.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0);

      portfolioSummary = `Portfolio: $${equity.toLocaleString()} (${dailyChange >= 0 ? "+" : ""}$${dailyChange.toFixed(0)}, ${dailyPct >= 0 ? "+" : ""}${dailyPct.toFixed(2)}%)\nPositions: ${positions.length} (${posWinners} winning, ${posLosers} losing)\nUnrealized: ${totalUnrealized >= 0 ? "+" : ""}$${totalUnrealized.toFixed(0)}`;
    } catch {
      portfolioSummary = "Could not fetch portfolio state";
    }

    // 4. Learning insights
    let learningUpdate = "";
    try {
      const insights = await generateLearningInsights();
      if (insights.totalTrades > 0) {
        learningUpdate = `All-time: ${insights.totalTrades} trades, ${(insights.winRate * 100).toFixed(0)}% WR, PF ${insights.profitFactor.toFixed(2)}, P&L $${insights.totalRealizedPnl.toFixed(0)}`;
        if (insights.bestSetups.length > 0) learningUpdate += `\nWorking: ${insights.bestSetups[0]}`;
        if (insights.worstSetups.length > 0) learningUpdate += `\nNot working: ${insights.worstSetups[0]}`;
      }
    } catch { /* ignore */ }

    // 5. Build end-of-day review
    const review = [
      `END OF DAY REVIEW — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`,
      "",
      portfolioSummary,
      "",
      `Today's Activity:`,
      `  Agent ran ${todayRuns.length} times, scanned ${totalScanned} stocks`,
      `  Opened ${buys.length} new positions`,
      `  Closed ${closes.length} trades: ${todayWins}W / ${todayLosses}L, P&L ${todayPnl >= 0 ? "+" : ""}$${todayPnl.toFixed(0)}`,
      totalErrors > 0 ? `  Errors: ${totalErrors}` : "",
      "",
      learningUpdate ? `Learning Engine:\n  ${learningUpdate}` : "",
    ].filter(Boolean).join("\n");

    // Send notification
    try {
      await sendNotification(review.slice(0, 2000));
    } catch { /* ignore */ }

    // Log the review run
    await prisma.agentRun.create({
      data: {
        runType: "review",
        stocksScanned: totalScanned,
        tradesPlaced: buys.length,
        positionsManaged: closes.length,
        errors: totalErrors,
        summary: `EOD: ${todayWins}W/${todayLosses}L, P&L ${todayPnl >= 0 ? "+" : ""}$${todayPnl.toFixed(0)}, ${buys.length} new, ${closes.length} closed`,
        durationMs: 0,
      },
    });

    return Response.json({ status: "ok", review, todayTrades: todayTrades.length, todayPnl });
  } catch (error) {
    console.error("[review]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
