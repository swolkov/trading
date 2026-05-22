import { prisma } from "./db";
import {
  type AgentEvent,
  type EventType,
  getUnprocessedEvents,
  markProcessed,
  emitEvent,
  pruneEvents,
  countEvents,
} from "./event-bus";
import {
  getSessionValue,
  setSessionValue,
  incrementSession,
  cleanExpiredSessions,
  SessionKeys,
} from "./session-context";
import { sendNotification } from "./notifications";
import { appendLiveFeed, updateJARVIS } from "./vault";

// ============ ORCHESTRATOR ============
// Event-driven workflow coordinator. Runs every 1 min via cron.
// Reads pending events → triggers reactive workflows → updates session state.
//
// This is the BRAIN'S NERVOUS SYSTEM:
// - Cron agents are the muscles (they do work on schedules)
// - Vault is the memory (persistent knowledge)
// - Event bus is the nerve signals (real-time coordination)
// - Orchestrator is the spinal cord (routes signals to the right response)

// ─── Priority System ─────────────────────────────────────────────────────────

const EVENT_PRIORITY: Record<string, number> = {
  // Priority 1: IMMEDIATE — safety-critical
  "risk.drawdown_breach": 1,
  "risk.max_drawdown": 1,
  "signal.flatten_all": 1,
  "regime.vix_spike": 1,
  "regime.breadth_collapse": 1,
  // Priority 2: URGENT — affects current trading
  "risk.drawdown_alert": 2,
  "risk.consecutive_stops": 2,
  "signal.pause_entries": 2,
  "signal.tighten_stops": 2,
  "regime.changed": 2,
  "trade.stop_loss": 2,
  // Priority 3: NORMAL — standard workflow triggers
  "trade.entry": 3,
  "trade.exit": 3,
  "trade.target_hit": 3,
  "trade.scale_out": 3,
  "trade.skip": 3,
  "synthesis.completed": 3,
  "agent.error": 3,
  "agent.offline": 3,
  // Priority 4: LOW — bookkeeping, no urgency
  "agent.online": 4,
  "session.premarket_ready": 4,
  "session.market_open": 4,
  "session.market_close": 4,
  "synthesis.lesson_extracted": 4,
  "synthesis.antipattern_found": 4,
  "synthesis.strategy_updated": 4,
};

function getEventPriority(type: string): number {
  return EVENT_PRIORITY[type] ?? 3;
}

// ─── Workflow Handlers ───────────────────────────────────────────────────────

type WorkflowHandler = (events: AgentEvent[]) => Promise<void>;

// WORKFLOW: Drawdown breach → pause all entries immediately
async function handleDrawdownBreach(events: AgentEvent[]): Promise<void> {
  const worst = events.reduce((a, b) =>
    (a.payload.pctOfLimit || 0) > (b.payload.pctOfLimit || 0) ? a : b,
  );

  const mode = worst.payload.mode || "live";
  const pct = worst.payload.pctOfLimit || 100;

  // Set session-level pause
  await setSessionValue(SessionKeys.ENTRIES_PAUSED, {
    paused: true,
    reason: `Drawdown ${pct.toFixed(0)}% of daily limit (${mode})`,
    since: new Date().toISOString(),
    until: "eod",
    mode,
  });

  // Emit pause signal for all agents to read
  await emitEvent("signal.pause_entries", "orchestrator", {
    reason: `Daily loss limit reached (${mode})`,
    mode,
    duration: "eod",
  });

  await sendNotification(
    `🚨 ORCHESTRATOR: Entries PAUSED (${mode}) — drawdown at ${pct.toFixed(0)}% of daily limit`,
    "futures",
  );

  await appendLiveFeed("orchestrator", "alert", `ENTRIES PAUSED (${mode}) — drawdown ${pct.toFixed(0)}% of limit`);
}

// WORKFLOW: Regime change → notify all agents, update session context
async function handleRegimeChange(events: AgentEvent[]): Promise<void> {
  const latest = events[events.length - 1]!;
  const { fromRegime, toRegime, sizeMultiplier, confidence } = latest.payload;

  // Store in session for fast reads by trading agents
  await setSessionValue(SessionKeys.REGIME_SHIFT_PENDING, {
    from: fromRegime,
    to: toRegime,
    sizeMultiplier: sizeMultiplier || 1.0,
    confidence: confidence || 0,
    detectedAt: new Date().toISOString(),
  });

  // If shifting to choppy/bear, tighten stops
  if (toRegime === "CHOPPY" || toRegime === "BEAR") {
    await emitEvent("signal.tighten_stops", "orchestrator", {
      reason: `Regime shifted to ${toRegime}`,
      duration: "until_regime_change",
    });
    await setSessionValue(SessionKeys.STOPS_TIGHTENED, {
      active: true,
      multiplier: toRegime === "BEAR" ? 0.6 : 0.75,
      reason: `Regime: ${toRegime}`,
    });
  }

  await appendLiveFeed(
    "orchestrator",
    "alert",
    `REGIME: ${fromRegime} → ${toRegime} (${(confidence || 0).toFixed(0)}% conf, size ${sizeMultiplier || 1}x)`,
  );
}

// WORKFLOW: VIX spike → immediate defensive posture
async function handleVixSpike(events: AgentEvent[]): Promise<void> {
  await setSessionValue(SessionKeys.VIX_SPIKE, {
    level: events[0]?.payload.price,
    change: events[0]?.payload.pnl, // reused field for % change
    time: new Date().toISOString(),
  });

  await setSessionValue(SessionKeys.ENTRIES_PAUSED, {
    paused: true,
    reason: "VIX spike detected — halt all new entries",
    since: new Date().toISOString(),
    until: "15m", // reassess in 15 min
  });

  await emitEvent("signal.pause_entries", "orchestrator", {
    reason: "VIX spike",
    duration: "15m",
  });

  await sendNotification("🚨 ORCHESTRATOR: VIX SPIKE — all entries paused for 15 min", "futures");
}

// WORKFLOW: Consecutive stops → cool down
async function handleConsecutiveStops(events: AgentEvent[]): Promise<void> {
  const latest = events[events.length - 1]!;
  const mode = latest.payload.mode || "live";
  const count = latest.payload.consecutiveStops || 3;

  if (mode === "live") {
    // Live: pause entries for 30 min after 3 consecutive stops
    await setSessionValue(SessionKeys.ENTRIES_PAUSED, {
      paused: true,
      reason: `${count} consecutive stops (${mode}) — cooling down`,
      since: new Date().toISOString(),
      until: "30m",
      mode,
    }, 30); // 30 min TTL

    await sendNotification(
      `🟡 ORCHESTRATOR: ${count} consecutive stops (${mode}) — entries paused 30 min`,
      "futures",
    );
  }
  // Demo: just log, don't pause
  await appendLiveFeed("orchestrator", "cooldown", `${count} consecutive stops (${mode})`);
}

// WORKFLOW: Trade exit → update session tallies, check synthesis trigger
async function handleTradeExit(events: AgentEvent[]): Promise<void> {
  for (const event of events) {
    const mode = event.payload.mode || "demo";
    const pnl = event.payload.pnl || 0;
    const isStopLoss = event.type === "trade.stop_loss";

    // Update daily trade count
    const countKey = mode === "live" ? SessionKeys.LIVE_TRADE_COUNT : SessionKeys.DEMO_TRADE_COUNT;
    await incrementSession(countKey);

    // Update daily P&L tally
    const pnlKey = mode === "live" ? SessionKeys.LIVE_DAILY_PNL : SessionKeys.DEMO_DAILY_PNL;
    const currentPnl = await getSessionValue<number>(pnlKey) || 0;
    await setSessionValue(pnlKey, currentPnl + pnl);

    // Track consecutive stops
    const stopsKey = mode === "live" ? SessionKeys.LIVE_CONSECUTIVE_STOPS : SessionKeys.DEMO_CONSECUTIVE_STOPS;
    if (isStopLoss || pnl < 0) {
      const stops = await incrementSession(stopsKey);
      if (stops >= 3 && mode === "live") {
        await emitEvent("risk.consecutive_stops", "orchestrator", {
          consecutiveStops: stops,
          mode,
        });
      }
    } else {
      // Winner resets consecutive stop counter
      await setSessionValue(stopsKey, 0);
    }

    // Track trades since last synthesis
    const synthCount = await incrementSession(SessionKeys.TRADES_SINCE_SYNTHESIS);
    if (synthCount >= 10) {
      // Don't trigger synthesis directly — just log that it's due
      await appendLiveFeed("orchestrator", "alert", `${synthCount} trades since last synthesis — synthesis due`);
    }
  }
}

// WORKFLOW: Synthesis completed → reset counters, broadcast
async function handleSynthesisCompleted(events: AgentEvent[]): Promise<void> {
  const latest = events[events.length - 1]!;

  // Reset trades-since-synthesis counter
  await setSessionValue(SessionKeys.TRADES_SINCE_SYNTHESIS, 0);

  // Refresh JARVIS
  try { await updateJARVIS("orchestrator-synthesis"); } catch {}

  await appendLiveFeed(
    "orchestrator",
    "alert",
    `Synthesis complete: ${latest.payload.totalTrades} trades, ${((latest.payload.winRate || 0) * 100).toFixed(0)}% WR, ${latest.payload.lessonsExtracted || 0} lessons`,
  );
}

// WORKFLOW: Agent went offline → check if critical
async function handleAgentOffline(events: AgentEvent[]): Promise<void> {
  const criticalAgents = ["futures-realtime-live", "futures-realtime-demo", "watchdog"];
  const criticalDown = events.filter((e) =>
    criticalAgents.some((a) => e.payload.agentName?.includes(a)),
  );

  if (criticalDown.length > 0) {
    const names = criticalDown.map((e) => e.payload.agentName).join(", ");
    await sendNotification(`🚨 ORCHESTRATOR: Critical agent(s) offline: ${names}`, "general");
  }
}

// ─── Workflow Router ─────────────────────────────────────────────────────────

const WORKFLOW_MAP: Record<string, WorkflowHandler> = {
  "risk.drawdown_breach": handleDrawdownBreach,
  "risk.max_drawdown": handleDrawdownBreach,
  "risk.drawdown_alert": handleDrawdownBreach,
  "risk.consecutive_stops": handleConsecutiveStops,
  "regime.changed": handleRegimeChange,
  "regime.vix_spike": handleVixSpike,
  "regime.breadth_collapse": handleRegimeChange,
  "trade.exit": handleTradeExit,
  "trade.stop_loss": handleTradeExit,
  "trade.target_hit": handleTradeExit,
  "trade.scale_out": handleTradeExit,
  "synthesis.completed": handleSynthesisCompleted,
  "agent.offline": handleAgentOffline,
};

// ─── Main Orchestrator Loop ──────────────────────────────────────────────────

export interface OrchestratorResult {
  eventsProcessed: number;
  workflowsTriggered: string[];
  sessionCleanup: number;
  eventsPruned: number;
  errors: string[];
}

export async function runOrchestrator(): Promise<OrchestratorResult> {
  const result: OrchestratorResult = {
    eventsProcessed: 0,
    workflowsTriggered: [],
    sessionCleanup: 0,
    eventsPruned: 0,
    errors: [],
  };

  try {
    // 1. Fetch all unprocessed events
    const events = await getUnprocessedEvents({ limit: 200 });
    if (events.length === 0) {
      // Still do periodic cleanup even with no events
      result.sessionCleanup = await cleanExpiredSessions();
      return result;
    }

    // 2. Sort by priority (lower = more urgent)
    events.sort((a, b) => getEventPriority(a.type) - getEventPriority(b.type));

    // 3. Group events by type for batch processing
    const grouped: Record<string, AgentEvent[]> = {};
    for (const event of events) {
      if (!grouped[event.type]) grouped[event.type] = [];
      grouped[event.type]!.push(event);
    }

    // 4. Process each group through its workflow handler
    const processedIds: number[] = [];

    for (const [type, group] of Object.entries(grouped)) {
      const handler = WORKFLOW_MAP[type];
      if (handler) {
        try {
          await handler(group);
          result.workflowsTriggered.push(`${type}(${group.length})`);
        } catch (err) {
          result.errors.push(`${type}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Mark all events as processed regardless of handler existence
      // (unhandled events are acknowledged but not acted on)
      processedIds.push(...group.map((e) => e.id));
    }

    // 5. Mark all as processed
    await markProcessed(processedIds, "orchestrator");
    result.eventsProcessed = processedIds.length;

    // 6. Periodic cleanup (expired sessions + old events)
    result.sessionCleanup = await cleanExpiredSessions();

    // Prune old processed events every hour (check via mod)
    const minute = new Date().getMinutes();
    if (minute === 0) {
      result.eventsPruned = await pruneEvents(72);
    }

    // 7. Check for time-based pause expirations
    await checkPauseExpirations();

  } catch (err) {
    result.errors.push(`orchestrator: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// ─── Pause Expiration Check ──────────────────────────────────────────────────

async function checkPauseExpirations(): Promise<void> {
  const pause = await getSessionValue<{
    paused: boolean;
    until: string;
    since: string;
    reason: string;
  }>(SessionKeys.ENTRIES_PAUSED);

  if (!pause || !pause.paused) return;

  const since = new Date(pause.since);
  const now = Date.now();

  let expired = false;
  if (pause.until === "eod") {
    // EOD pauses don't auto-expire within the session
    return;
  } else if (pause.until.endsWith("m")) {
    const minutes = parseInt(pause.until.replace("m", ""));
    expired = now - since.getTime() > minutes * 60000;
  } else if (pause.until.endsWith("h")) {
    const hours = parseInt(pause.until.replace("h", ""));
    expired = now - since.getTime() > hours * 3600000;
  }

  if (expired) {
    await setSessionValue(SessionKeys.ENTRIES_PAUSED, {
      paused: false,
      reason: `Auto-resumed after ${pause.until}`,
      since: new Date().toISOString(),
    });

    await emitEvent("signal.resume_entries", "orchestrator", {
      reason: `Pause expired (was: ${pause.reason})`,
    });

    await appendLiveFeed("orchestrator", "alert", `Entries RESUMED — pause expired (${pause.until})`);
    await sendNotification(`🟢 ORCHESTRATOR: Entries resumed — ${pause.until} pause expired`, "futures");
  }
}

// ─── Utility: Check if entries are paused ────────────────────────────────────
// Trading agents should call this before placing orders

export async function areEntriesPaused(mode?: "live" | "demo"): Promise<{
  paused: boolean;
  reason: string;
}> {
  const pause = await getSessionValue<{
    paused: boolean;
    reason: string;
    mode?: string;
  }>(SessionKeys.ENTRIES_PAUSED);

  if (!pause || !pause.paused) {
    return { paused: false, reason: "" };
  }

  // If pause is mode-specific, only apply to that mode
  if (pause.mode && mode && pause.mode !== mode) {
    return { paused: false, reason: "" };
  }

  return { paused: true, reason: pause.reason };
}

// ─── Utility: Get session trading summary ────────────────────────────────────

export async function getSessionTradingSummary(): Promise<{
  liveTrades: number;
  demoTrades: number;
  livePnl: number;
  demoPnl: number;
  liveConsecutiveStops: number;
  demoConsecutiveStops: number;
  entriesPaused: boolean;
  tradesSinceSynthesis: number;
}> {
  return {
    liveTrades: await getSessionValue<number>(SessionKeys.LIVE_TRADE_COUNT) || 0,
    demoTrades: await getSessionValue<number>(SessionKeys.DEMO_TRADE_COUNT) || 0,
    livePnl: await getSessionValue<number>(SessionKeys.LIVE_DAILY_PNL) || 0,
    demoPnl: await getSessionValue<number>(SessionKeys.DEMO_DAILY_PNL) || 0,
    liveConsecutiveStops: await getSessionValue<number>(SessionKeys.LIVE_CONSECUTIVE_STOPS) || 0,
    demoConsecutiveStops: await getSessionValue<number>(SessionKeys.DEMO_CONSECUTIVE_STOPS) || 0,
    entriesPaused: (await getSessionValue<{ paused: boolean }>(SessionKeys.ENTRIES_PAUSED))?.paused || false,
    tradesSinceSynthesis: await getSessionValue<number>(SessionKeys.TRADES_SINCE_SYNTHESIS) || 0,
  };
}
