import { getPositions, getAccount } from "@/lib/alpaca";
import { getTradovateAccountSummary, getTradovatePositions } from "@/lib/tradovate";
import { generateLearningInsights } from "@/lib/learning-engine";
import { sendNotification } from "@/lib/notifications";
import { prisma } from "@/lib/db";
import { runSynthesis, logObservation } from "@/lib/vault";

export const maxDuration = 120;

// ============ POST-MARKET REVIEW AGENT ============
// Runs at 4:30 PM ET (20:30 UTC) after market close.
// Reviews the day's performance, extracts lessons, updates learning engine.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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

    const entries = todayTrades.filter((t) => t.action.includes("entry") || t.action.includes("buy") || t.action.includes("iron") || t.action.includes("sell_bull") || t.action.includes("sell_bear"));
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

    // 3. Current portfolio state — both brokers
    let portfolioSummary = "";

    // Tradovate (futures)
    try {
      const tvAccount = await getTradovateAccountSummary();
      const tvPositions = await getTradovatePositions();
      const tvEquity = tvAccount.netLiq || tvAccount.balance;

      const today = new Date().toISOString().slice(0, 10);
      const sodRecord = await prisma.agentConfig.findUnique({ where: { key: `daily_balance_${today}` } });
      const sodBalance = sodRecord ? parseFloat(sodRecord.value) : null;
      const tvDailyChange = sodBalance != null ? tvEquity - sodBalance : null;
      const tvDailyPct = sodBalance != null && sodBalance > 0 ? ((tvEquity - sodBalance) / sodBalance) * 100 : null;
      const tvOpen = tvPositions.filter((p) => p.netPos !== 0);

      portfolioSummary = `FUTURES (Tradovate): $${tvEquity.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
      if (tvDailyChange != null) portfolioSummary += ` (${tvDailyChange >= 0 ? "+" : ""}$${tvDailyChange.toFixed(0)}, ${tvDailyPct != null ? (tvDailyPct >= 0 ? "+" : "") + tvDailyPct.toFixed(2) + "%" : ""})`;
      portfolioSummary += `\n  Positions: ${tvOpen.length}, Unrealized: ${tvAccount.unrealizedPnl >= 0 ? "+" : ""}$${tvAccount.unrealizedPnl.toFixed(0)}, Margin: $${tvAccount.marginUsed.toFixed(0)}`;
    } catch {
      portfolioSummary = "FUTURES (Tradovate): Could not fetch";
    }

    // Alpaca (stocks/options)
    try {
      const alpAccount = await getAccount();
      const alpPositions = await getPositions();
      const alpEquity = parseFloat(alpAccount.equity);
      const alpDailyChange = alpEquity - parseFloat(alpAccount.last_equity);
      const alpDailyPct = (alpDailyChange / parseFloat(alpAccount.last_equity)) * 100;
      const alpWinners = alpPositions.filter((p) => parseFloat(p.unrealized_pl) > 0).length;
      const alpLosers = alpPositions.filter((p) => parseFloat(p.unrealized_pl) < 0).length;
      const alpUnrealized = alpPositions.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0);

      portfolioSummary += `\nSTOCKS/OPTIONS (Alpaca): $${alpEquity.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${alpDailyChange >= 0 ? "+" : ""}$${alpDailyChange.toFixed(0)}, ${alpDailyPct >= 0 ? "+" : ""}${alpDailyPct.toFixed(2)}%)`;
      if (alpPositions.length > 0) {
        portfolioSummary += `\n  Positions: ${alpPositions.length} (${alpWinners}W/${alpLosers}L), Unrealized: ${alpUnrealized >= 0 ? "+" : ""}$${alpUnrealized.toFixed(0)}`;
      }
    } catch {
      portfolioSummary += "\nSTOCKS/OPTIONS (Alpaca): Could not fetch";
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

    // 5. Run vault synthesis — updates Performance, Lessons, Anti-Patterns in Obsidian brain
    let synthesisUpdate = "";
    try {
      const synthesis = await runSynthesis();
      synthesisUpdate = `Vault Synthesis: ${synthesis.totalTrades} trades analyzed, ${(synthesis.winRate * 100).toFixed(0)}% WR, PF ${synthesis.profitFactor.toFixed(2)}, ${synthesis.lessonsExtracted} lessons, ${synthesis.antiPatternsFound} anti-patterns`;

      // Log notable observations
      if (todayPnl > 0 && todayWins > todayLosses) {
        await logObservation("review-agent", `Positive day: +$${todayPnl.toFixed(0)}, ${todayWins}W/${todayLosses}L`);
      } else if (todayPnl < -100) {
        await logObservation("review-agent", `Rough day: -$${Math.abs(todayPnl).toFixed(0)}, ${todayWins}W/${todayLosses}L — review trade quality`);
      }
    } catch { /* synthesis optional */ }

    // 6. Build end-of-day review
    const review = [
      `END OF DAY REVIEW — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`,
      "",
      portfolioSummary,
      "",
      `Today's Activity:`,
      `  Agent ran ${todayRuns.length} times, scanned ${totalScanned} stocks`,
      `  Opened ${entries.length} new positions`,
      `  Closed ${closes.length} trades: ${todayWins}W / ${todayLosses}L, P&L ${todayPnl >= 0 ? "+" : ""}$${todayPnl.toFixed(0)}`,
      totalErrors > 0 ? `  Errors: ${totalErrors}` : "",
      "",
      learningUpdate ? `Learning Engine:\n  ${learningUpdate}` : "",
      synthesisUpdate ? `Vault Brain:\n  ${synthesisUpdate}` : "",
    ].filter(Boolean).join("\n");

    // Send notification
    try {
      await sendNotification(review.slice(0, 2000), "general");
    } catch { /* ignore */ }

    // Log the review run
    await prisma.agentRun.create({
      data: {
        runType: "review",
        stocksScanned: totalScanned,
        tradesPlaced: entries.length,
        positionsManaged: closes.length,
        errors: totalErrors,
        summary: `EOD: ${todayWins}W/${todayLosses}L, P&L ${todayPnl >= 0 ? "+" : ""}$${todayPnl.toFixed(0)}, ${entries.length} new, ${closes.length} closed`,
        durationMs: 0,
      },
    });

    return Response.json({ status: "ok", review, todayTrades: todayTrades.length, todayPnl });
  } catch (error) {
    console.error("[review]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
