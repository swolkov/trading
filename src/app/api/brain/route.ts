import { prisma } from "@/lib/db";
import { vaultReadMultiple } from "@/lib/vault";

function extractFrontmatterField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`${field}:\\s*"?([^"\\n]+)"?`));
  return match ? match[1].trim() : null;
}

function extractSection(content: string, heading: string): string {
  const regex = new RegExp(`## ${heading}[\\s\\S]*?(?=\\n## |$)`, "i");
  const match = content.match(regex);
  return match ? match[0].replace(`## ${heading}`, "").trim() : "";
}

export async function GET() {
  try {
    const [configs, recentRuns, recentTrades] = await Promise.all([
      prisma.agentConfig.findMany(),
      prisma.agentRun.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.autoTradeLog.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);

    const configMap: Record<string, string> = {};
    for (const c of configs) configMap[c.key] = c.value;

    const parseJSON = (key: string) => {
      try { return configMap[key] ? JSON.parse(configMap[key]) : null; } catch { return null; }
    };

    // Read brain vault files from DB (works on Vercel/Railway)
    const vaultDocs = await vaultReadMultiple([
      "Brain/market-regime.md",
      "Brain/volatility-environment.md",
      "Brain/macro-outlook.md",
      "Brain/crypto-regime.md",
      "Lessons/active-lessons.md",
    ]);

    const regimeRaw = vaultDocs["Brain/market-regime.md"] || null;
    const volRaw = vaultDocs["Brain/volatility-environment.md"] || null;
    const macroRaw = vaultDocs["Brain/macro-outlook.md"] || null;
    const cryptoRegimeRaw = vaultDocs["Brain/crypto-regime.md"] || null;
    const lessonsRaw = vaultDocs["Lessons/active-lessons.md"] || null;

    // Parse brain state
    const brain = {
      regime: {
        trend: regimeRaw?.match(/\*\*Trend\*\*:\s*(.+)/)?.[1] || "Unknown",
        vix: regimeRaw?.match(/VIX\s*([\d.]+)/)?.[1] || "?",
        classification: regimeRaw?.match(/\*\*Current\*\*:\s*`?(\w+)`?/)?.[1] || "UNKNOWN",
        lastUpdated: regimeRaw ? extractFrontmatterField(regimeRaw, "last_updated") : null,
      },
      volatility: {
        environment: volRaw?.match(/\*\*Current\*\*:\s*`?(\w+)`?/)?.[1] || volRaw?.match(/Environment[:\s]*(\w+)/i)?.[1] || "Unknown",
        lastUpdated: volRaw ? extractFrontmatterField(volRaw, "last_updated") : null,
      },
      macro: {
        summary: macroRaw ? extractSection(macroRaw, "Summary").slice(0, 200) || extractSection(macroRaw, "Current").slice(0, 200) : null,
        lastUpdated: macroRaw ? extractFrontmatterField(macroRaw, "last_updated") : null,
      },
      crypto: {
        regime: cryptoRegimeRaw?.match(/\*\*Current\*\*:\s*`?(\w+)`?/)?.[1] || "Unknown",
        lastUpdated: cryptoRegimeRaw ? extractFrontmatterField(cryptoRegimeRaw, "last_updated") : null,
      },
    };

    // Active lessons (top 5)
    const lessons = lessonsRaw
      ?.split("\n")
      .filter(l => l.startsWith("- ") || l.startsWith("1.") || l.match(/^\d+\./))
      .slice(0, 5)
      .map(l => l.replace(/^[-\d.]+\s*/, "").trim()) || [];

    // Agent status from heartbeats
    const agents = [
      {
        id: "futures-demo",
        name: "Futures Engine (Demo)",
        type: "core",
        heartbeat: (() => { try { return JSON.parse(configMap.futures_engine_heartbeat_demo || "{}").timestamp || null; } catch { return null; } })(),
        mode: "demo",
        icon: "engine",
      },
      {
        id: "futures-live",
        name: "Futures Engine (Live)",
        type: "core",
        heartbeat: (() => { try { return JSON.parse(configMap.futures_engine_heartbeat_live || "{}").timestamp || null; } catch { return null; } })(),
        mode: "live",
        icon: "engine",
      },
      {
        id: "futures-cron",
        name: "Futures Cron",
        type: "core",
        heartbeat: configMap.futures_cron_last_run || null,
        mode: configMap.futures_mode || "disabled",
        icon: "clock",
      },
      {
        id: "crypto",
        name: "Crypto Agent",
        type: "core",
        heartbeat: configMap.crypto_last_run || null,
        mode: configMap.crypto_enabled || "disabled",
        icon: "bitcoin",
      },
      {
        id: "stocks",
        name: "Stocks Agent",
        type: "core",
        heartbeat: configMap.stocks_last_run || null,
        mode: configMap.stocks_enabled || "disabled",
        icon: "chart",
      },
      {
        id: "watchdog",
        name: "Watchdog",
        type: "support",
        heartbeat: configMap.watchdog_last_run || null,
        mode: "auto",
        icon: "shield",
      },
      {
        id: "regime",
        name: "Regime Transition",
        type: "support",
        heartbeat: configMap.regime_transition_last_run || null,
        mode: "auto",
        icon: "radar",
      },
      {
        id: "events",
        name: "Event Catalyst",
        type: "support",
        heartbeat: configMap.event_catalyst_last_run || null,
        mode: "auto",
        icon: "calendar",
      },
      {
        id: "premarket",
        name: "Pre-Market Briefing",
        type: "support",
        heartbeat: configMap.premarket_last_run || null,
        mode: "auto",
        icon: "sunrise",
      },
      {
        id: "review",
        name: "Post-Market Review",
        type: "support",
        heartbeat: configMap.review_last_run || null,
        mode: "auto",
        icon: "moon",
      },
    ];

    // Drawdown state
    const drawdown = parseJSON("drawdown_state");

    // Today's P&L from trades
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = recentTrades.filter(t => new Date(t.createdAt) >= todayStart);
    const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const todayTradeCount = todayTrades.filter(t => !t.action.includes("skip")).length;

    // Task queue - derive from system state
    const tasks: { priority: "high" | "medium" | "low"; label: string; context: string }[] = [];

    // Check what needs attention
    const regimeAge = brain.regime.lastUpdated
      ? (Date.now() - new Date(brain.regime.lastUpdated).getTime()) / (1000 * 60 * 60)
      : 999;
    if (regimeAge > 12) {
      tasks.push({ priority: "medium", label: "Update market regime", context: `Last updated ${regimeAge > 24 ? Math.floor(regimeAge / 24) + "d" : Math.floor(regimeAge) + "h"} ago` });
    }

    if (drawdown?.mode && drawdown.mode !== "NORMAL") {
      tasks.push({ priority: "high", label: `Drawdown: ${drawdown.mode}`, context: `${drawdown.currentDrawdownPct?.toFixed(1)}% drawdown, ${drawdown.consecutiveLosses} consecutive losses` });
    }

    const staleAgents = agents.filter(a => {
      if (!a.heartbeat) return a.mode !== "disabled";
      const age = (Date.now() - new Date(a.heartbeat).getTime()) / 60000;
      return age > 60 && a.mode !== "disabled";
    });
    if (staleAgents.length > 0) {
      tasks.push({ priority: "high", label: `${staleAgents.length} agent(s) stale`, context: staleAgents.map(a => a.name).join(", ") });
    }

    const eventData = parseJSON("event_calendar");
    if (eventData?.eventsToday?.length > 0) {
      tasks.push({ priority: "medium", label: `${eventData.eventsToday.length} event(s) today`, context: eventData.eventsToday.slice(0, 2).join(", ") });
    }

    // Activity feed (last 20 meaningful events)
    const activity = [
      ...recentTrades.slice(0, 15).map(t => ({
        type: t.action.includes("skip") ? "skip" : t.pnl && t.pnl > 0 ? "win" : t.pnl && t.pnl < 0 ? "loss" : "trade",
        text: `${t.action.toUpperCase()} ${t.symbol}${t.qty ? ` x${t.qty}` : ""}${t.pnl ? ` → $${t.pnl.toFixed(0)}` : ""}`,
        detail: t.reason?.slice(0, 80) || "",
        time: t.createdAt,
      })),
      ...recentRuns.slice(0, 10).map(r => ({
        type: "run",
        text: `${r.runType?.replace(/_/g, " ")} completed`,
        detail: r.summary?.slice(0, 80) || "",
        time: r.createdAt,
      })),
    ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 20);

    return Response.json({
      brain,
      agents,
      tasks,
      activity,
      lessons,
      stats: {
        todayPnl,
        todayTradeCount,
        drawdownMode: drawdown?.mode || "NORMAL",
        effectiveMultiplier:
          (configMap.regime_size_override ? parseFloat(configMap.regime_size_override) : 1.0) *
          (configMap.event_size_override ? parseFloat(configMap.event_size_override) : 1.0),
        futuresMode: configMap.futures_mode || "disabled",
        cryptoMode: configMap.crypto_enabled || "disabled",
        stocksMode: configMap.stocks_enabled || "disabled",
      },
    });
  } catch (error) {
    console.error("[/api/brain]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
