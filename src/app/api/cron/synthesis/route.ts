import { runSynthesisAgent } from "@/lib/synthesis-agent";
import { sendNotification } from "@/lib/notifications";
import { prisma } from "@/lib/db";

export const maxDuration = 120;

// ============ SYNTHESIS AGENT CRON ============
// Runs 3x daily: 12:00 PM (midday check), 5:00 PM (post-market), 9:00 PM (evening deep analysis)
// Also runs after every 10 new trades (checked on each invocation).
//
// This is the BRAIN'S LEARNING LOOP:
// 1. Analyzes all trades (real + paper) for patterns
// 2. Extracts lessons → updates Lessons/active-lessons.md
// 3. Finds anti-patterns → updates Rules/anti-patterns.md
// 4. Updates performance stats → Performance/statistics.md
// 5. Scores paper trades vs real trades to validate trading windows
//
// Without this cron, the brain is just a journal. With it, the brain EVOLVES.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSynthesisAgent();

    if (result.shouldRun && result.totalTrades > 0) {
      // Notify on significant synthesis runs
      const summary = [
        `SYNTHESIS: ${result.totalTrades} trades analyzed`,
        `WR: ${(result.winRate * 100).toFixed(0)}% | PF: ${result.profitFactor.toFixed(2)}`,
        `Lessons: ${result.lessonsExtracted} | Anti-patterns: ${result.antiPatternsFound}`,
        result.reason,
      ].join("\n");

      try { await sendNotification(summary, "futures"); } catch {}
    }

    await prisma.agentConfig.upsert({ where: { key: "synthesis_last_run" }, update: { value: new Date().toISOString() }, create: { key: "synthesis_last_run", value: new Date().toISOString() } }).catch(() => {});

    return Response.json({
      status: "ok",
      ran: result.shouldRun,
      reason: result.reason,
      trades: result.totalTrades,
      winRate: result.winRate,
      profitFactor: result.profitFactor,
      lessons: result.lessonsExtracted,
      antiPatterns: result.antiPatternsFound,
      details: result.details,
    });
  } catch (error) {
    console.error("[synthesis]", error);
    try { await sendNotification(`🚨 SYNTHESIS CRON CRASH: ${error instanceof Error ? error.message : "Unknown"}`, "general"); } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
