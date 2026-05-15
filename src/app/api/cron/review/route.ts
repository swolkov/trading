import { getPositions, getAccount } from "@/lib/alpaca";
import { getTradovateAccountSummary, getTradovatePositions, TRADOVATE_CONTRACTS } from "@/lib/tradovate";
import { getFuturesIntradayBars } from "@/lib/futures-data";
import { generateLearningInsights } from "@/lib/learning-engine";
import { sendNotification } from "@/lib/notifications";
import { prisma } from "@/lib/db";
import { logObservation } from "@/lib/vault";
import { runSynthesisAgent } from "@/lib/synthesis-agent";

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

    // 4. Score paper trades — check if hypothetical entries would have won or lost
    // This is the learning engine: the agent logs setups it WOULD have taken (during lunch,
    // overnight, after tilt, after daily limit). Now we check what actually happened.
    let paperTradeResults = "";
    try {
      const paperTrades = todayTrades.filter((t) => t.action.startsWith("paper_"));
      if (paperTrades.length > 0) {
        let paperWins = 0, paperLosses = 0, paperOpen = 0;
        const paperDetails: string[] = [];

        // Fetch 5-min bars for each symbol to check price action after paper entry
        const symbolBarsCache: Record<string, { t: number; o: number; h: number; l: number; c: number; v: number }[]> = {};

        for (const pt of paperTrades) {
          const symbol = pt.symbol.replace("FUT:", "");
          const entryPrice = pt.price || 0;
          const entryTime = new Date(pt.createdAt).getTime() / 1000;
          const isLong = pt.action === "paper_long";

          // Parse stop and target from reason string
          const stopMatch = pt.reason?.match(/Stop:\s*\$?([\d,.]+)/);
          const targetMatch = pt.reason?.match(/Target:\s*\$?([\d,.]+)/);
          if (!stopMatch || !targetMatch || !entryPrice) continue;

          const stopPrice = parseFloat(stopMatch[1].replace(",", ""));
          const targetPrice = parseFloat(targetMatch[1].replace(",", ""));

          // Get bars (cache per symbol)
          if (!symbolBarsCache[symbol]) {
            try {
              symbolBarsCache[symbol] = await getFuturesIntradayBars(symbol, "5m", "1d");
            } catch {
              continue;
            }
          }
          const bars = symbolBarsCache[symbol];

          // Find bars AFTER entry time and check what happened first: target or stop
          const barsAfterEntry = bars.filter((b) => b.t > entryTime);
          let result: "win" | "loss" | "open" = "open";
          let exitPrice = 0;
          let exitBar = 0;

          for (let i = 0; i < barsAfterEntry.length; i++) {
            const bar = barsAfterEntry[i];
            if (isLong) {
              // Check stop first (conservative: assume worst case within bar)
              if (bar.l <= stopPrice) { result = "loss"; exitPrice = stopPrice; exitBar = i; break; }
              if (bar.h >= targetPrice) { result = "win"; exitPrice = targetPrice; exitBar = i; break; }
            } else {
              // Short
              if (bar.h >= stopPrice) { result = "loss"; exitPrice = stopPrice; exitBar = i; break; }
              if (bar.l <= targetPrice) { result = "win"; exitPrice = targetPrice; exitBar = i; break; }
            }
          }

          const contractInfo = TRADOVATE_CONTRACTS[symbol];
          const multiplier = contractInfo?.multiplier || 5;
          const qty = pt.qty || 1;
          const priceDiff = isLong ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
          const hypotheticalPnl = result !== "open" ? priceDiff * multiplier * qty : 0;
          const holdBars = exitBar;
          const holdMinutes = holdBars * 5;

          if (result === "win") paperWins++;
          else if (result === "loss") paperLosses++;
          else paperOpen++;

          // Parse session from reason
          const sessionMatch = pt.reason?.match(/Session:\s*(\w+)/);
          const session = sessionMatch ? sessionMatch[1] : "unknown";

          // Parse setup type from reason
          const setupMatch = pt.reason?.match(/\[PAPER\]\s*([\w\s]+?):/);
          const setupType = setupMatch ? setupMatch[1].trim() : "unknown";

          const resultStr = result === "win" ? `WIN +$${hypotheticalPnl.toFixed(0)}`
            : result === "loss" ? `LOSS -$${Math.abs(hypotheticalPnl).toFixed(0)}`
            : "STILL OPEN at EOD";

          paperDetails.push(`${symbol} ${isLong ? "LONG" : "SHORT"} @ $${entryPrice.toFixed(2)} → ${resultStr} (${holdMinutes}min, ${session}, ${setupType})`);

          // Update the paper trade record with result
          try {
            await prisma.autoTradeLog.update({
              where: { id: pt.id },
              data: {
                pnl: hypotheticalPnl || null,
                reason: `${pt.reason} | RESULT: ${resultStr} after ${holdMinutes}min`,
              },
            });
          } catch { /* ignore update errors */ }
        }

        const paperTotal = paperWins + paperLosses;
        const paperWR = paperTotal > 0 ? ((paperWins / paperTotal) * 100).toFixed(0) : "N/A";
        paperTradeResults = `Paper Trades: ${paperTrades.length} logged, ${paperWins}W/${paperLosses}L/${paperOpen}open (${paperWR}% WR)`;

        // Log paper trade analysis to Obsidian brain — this is how it learns
        if (paperTotal > 0) {
          const insight = [
            `PAPER TRADE ANALYSIS — ${new Date().toLocaleDateString()}`,
            `${paperWins}W/${paperLosses}L (${paperWR}% WR) out of ${paperTrades.length} hypothetical trades`,
            "",
            ...paperDetails,
            "",
            paperWins > paperLosses
              ? "INSIGHT: Paper trades are winning — consider expanding trading windows or increasing trade count."
              : "INSIGHT: Paper trades losing — current window restriction is protecting the account. Stay disciplined.",
          ].join("\n");
          await logObservation("review-agent", insight);
        }
      }
    } catch { /* paper trade scoring optional */ }

    // 5. Learning insights
    let learningUpdate = "";
    try {
      const insights = await generateLearningInsights();
      if (insights.totalTrades > 0) {
        learningUpdate = `All-time: ${insights.totalTrades} trades, ${(insights.winRate * 100).toFixed(0)}% WR, PF ${insights.profitFactor.toFixed(2)}, P&L $${insights.totalRealizedPnl.toFixed(0)}`;
        if (insights.bestSetups.length > 0) learningUpdate += `\nWorking: ${insights.bestSetups[0]}`;
        if (insights.worstSetups.length > 0) learningUpdate += `\nNot working: ${insights.worstSetups[0]}`;
      }
    } catch { /* ignore */ }

    // 5. Run full synthesis agent — updates Performance, Lessons, Anti-Patterns in Obsidian brain
    // Forces run since this is the post-market review (always synthesize at EOD)
    let synthesisUpdate = "";
    try {
      const synthesis = await runSynthesisAgent(true);
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
      paperTradeResults ? `Paper Trades (Learning):\n  ${paperTradeResults}` : "",
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
