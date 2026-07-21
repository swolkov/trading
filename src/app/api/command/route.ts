import { prisma } from "@/lib/db";
import { getViewMode } from "@/lib/trading-mode";

// View-aware (emits only the active engine's heartbeat) + reads live DB state every call — must never
// be statically cached, or a demo→live toggle could keep showing the wrong engine.
export const dynamic = "force-dynamic";

// ============ COMMAND CENTER API ============
// Aggregates all meta-agent data into a single response for the Command Center UI.
// Reads from AgentConfig keys written by: watchdog, portfolio-risk, regime-transition,
// event-catalyst, execution-quality agents.

export async function GET() {
  try {
    const configs = await prisma.agentConfig.findMany();
    const configMap: Record<string, string> = {};
    for (const c of configs) configMap[c.key] = c.value;

    // Engine health is view-aware: only surface the futures engine matching the active view
    // (live view → live engine, demo view → demo engine). Shared infra crons stay in both views.
    const futuresView = await getViewMode("futures").catch(() => "demo");

    // Recent agent runs (last 24h) for all meta-agents
    const recentRuns = await prisma.agentRun.findMany({
      where: {
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        runType: { in: ["watchdog", "portfolio_risk", "regime_transition", "event_catalyst", "execution_quality", "walk_forward"] },
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

      // Agent heartbeats — engine heartbeat is view-scoped (only the active view's engine); crons are shared.
      heartbeats: {
        watchdog: configMap.watchdog_last_run || null,
        ...(futuresView === "live"
          ? { futuresEngineLive: (() => { try { return JSON.parse(configMap.futures_engine_heartbeat_live || "{}").timestamp || null; } catch { return null; } })() }
          : { futuresEngineDemo: (() => { try { return JSON.parse(configMap.futures_engine_heartbeat_demo || "{}").timestamp || null; } catch { return null; } })() }),
        futuresCron: configMap.futures_cron_last_run || null,
        tradeCron: configMap.trade_last_run || null,
        monitorCron: configMap.monitor_last_run || null,
        premarketCron: configMap.premarket_last_run || null,
        reviewCron: configMap.review_last_run || null,
      },

      // Benchmark tracking
      benchmark: parseJSON("benchmark_report"),

      // P&L attribution
      pnlAttribution: parseJSON("pnl_attribution"),

      // Stress test
      stressTest: parseJSON("stress_test_result"),

      // Drawdown protocol
      drawdownState: parseJSON("drawdown_state"),
      drawdownMode: configMap.drawdown_mode || "NORMAL",

      // Walk-forward optimization
      walkForward: parseJSON("walk_forward_result"),

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
