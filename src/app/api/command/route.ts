import { prisma } from "@/lib/db";

// ============ COMMAND CENTER API ============
// Aggregates all meta-agent data into a single response for the Command Center UI.
// Reads from AgentConfig keys written by: watchdog, portfolio-risk, regime-transition,
// event-catalyst, execution-quality agents.

export async function GET() {
  try {
    const configs = await prisma.agentConfig.findMany();
    const configMap: Record<string, string> = {};
    for (const c of configs) configMap[c.key] = c.value;

    // Recent agent runs (last 24h) for all meta-agents
    const recentRuns = await prisma.agentRun.findMany({
      where: {
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        runType: { in: ["watchdog", "portfolio_risk", "regime_transition", "event_catalyst", "execution_quality"] },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    // Parse stored JSON configs safely
    const parseJSON = (key: string) => {
      try { return configMap[key] ? JSON.parse(configMap[key]) : null; } catch { return null; }
    };

    return Response.json({
      // Watchdog health
      watchdog: {
        lastRun: configMap.watchdog_last_run || null,
        recentRuns: recentRuns.filter((r) => r.runType === "watchdog").slice(0, 5),
      },

      // Portfolio risk snapshot
      portfolioRisk: parseJSON("portfolio_risk_snapshot"),

      // Regime transition
      regimeTransition: parseJSON("regime_transition"),
      regimeSizeOverride: configMap.regime_size_override ? parseFloat(configMap.regime_size_override) : 1.0,

      // Event catalyst
      eventCalendar: parseJSON("event_calendar"),
      eventSizeOverride: configMap.event_size_override ? parseFloat(configMap.event_size_override) : 1.0,

      // Execution quality
      executionQuality: parseJSON("execution_quality_report"),

      // Combined effective multiplier
      effectiveMultiplier: (configMap.regime_size_override ? parseFloat(configMap.regime_size_override) : 1.0) *
                           (configMap.event_size_override ? parseFloat(configMap.event_size_override) : 1.0),

      // Preferred/avoid strategies from regime transition
      preferredStrategies: parseJSON("regime_preferred_strategies") || [],
      avoidStrategies: parseJSON("regime_avoid_strategies") || [],

      // Agent heartbeats
      heartbeats: {
        watchdog: configMap.watchdog_last_run || null,
        futuresEngine: configMap.futures_engine_heartbeat || null,
        futuresCron: configMap.futures_cron_last_run || null,
        tradeCron: configMap.trade_last_run || null,
        monitorCron: configMap.monitor_last_run || null,
        premarketCron: configMap.premarket_last_run || null,
        reviewCron: configMap.review_last_run || null,
      },

      // Meta-agent run history
      recentRuns: recentRuns.map((r) => ({
        type: r.runType,
        summary: r.summary,
        errors: r.errors,
        duration: r.durationMs,
        time: r.createdAt,
      })),
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
