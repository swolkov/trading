import { prisma } from "./db";

// ============ EVENT BUS ============
// DB-backed event system for agent coordination.
// Agents emit events → orchestrator consumes → triggers workflows.
// No Redis, no external deps — just PostgreSQL.

// ─── Event Types ─────────────────────────────────────────────────────────────

export type EventType =
  // Trade lifecycle
  | "trade.entry"
  | "trade.exit"
  | "trade.skip"
  | "trade.stop_loss"
  | "trade.target_hit"
  | "trade.scale_out"
  // Regime & market
  | "regime.changed"
  | "regime.vol_spike"
  | "regime.vol_crush"
  | "regime.breadth_thrust"
  | "regime.breadth_collapse"
  // Risk events
  | "risk.drawdown_warning"   // 80% of daily limit
  | "risk.drawdown_alert"     // 90% of daily limit
  | "risk.drawdown_breach"    // daily limit hit
  | "risk.max_drawdown"       // kill switch
  | "risk.consecutive_stops"  // 3+ stops in a row
  // Agent lifecycle
  | "agent.online"
  | "agent.offline"
  | "agent.error"
  | "agent.stale"
  // Synthesis & learning
  | "synthesis.completed"
  | "synthesis.lesson_extracted"
  | "synthesis.antipattern_found"
  | "synthesis.strategy_updated"
  // Session events
  | "session.premarket_ready"
  | "session.market_open"
  | "session.market_close"
  | "session.eod_review"
  // Cross-agent coordination
  | "signal.pause_entries"
  | "signal.resume_entries"
  | "signal.tighten_stops"
  | "signal.flatten_all";

export interface EventPayload {
  // Trade events
  instrument?: string;
  direction?: string;
  contracts?: number;
  price?: number;
  pnl?: number;
  rMultiple?: number;
  conviction?: number;
  setupType?: string;
  mode?: "demo" | "live";
  tradeId?: string;
  // Regime events
  fromRegime?: string;
  toRegime?: string;
  confidence?: number;
  sizeMultiplier?: number;
  // Risk events
  currentLoss?: number;
  dailyLimit?: number;
  pctOfLimit?: number;
  consecutiveStops?: number;
  // Agent events
  agentName?: string;
  error?: string;
  // Synthesis events
  totalTrades?: number;
  winRate?: number;
  lessonsExtracted?: number;
  antiPatternsFound?: number;
  // Signal events
  reason?: string;
  duration?: string; // e.g. "15m", "eod", "until_regime_change"
  // Generic
  message?: string;
  relatedFile?: string;
  [key: string]: unknown;
}

export interface AgentEvent {
  id: number;
  type: string;
  source: string;
  payload: EventPayload;
  processed: boolean;
  processedAt: Date | null;
  processedBy: string | null;
  createdAt: Date;
}

// ─── Emit ────────────────────────────────────────────────────────────────────

export async function emitEvent(
  type: EventType,
  source: string,
  payload: EventPayload = {},
): Promise<number> {
  const event = await prisma.agentEvent.create({
    data: {
      type,
      source,
      payload: JSON.stringify(payload),
    },
  });
  return event.id;
}

// Fire-and-forget version that never throws (for embedding in existing code)
export function emitEventSafe(
  type: EventType,
  source: string,
  payload: EventPayload = {},
): void {
  emitEvent(type, source, payload).catch(() => {
    // event bus is best-effort — never break existing agent logic
  });
}

// ─── Consume ─────────────────────────────────────────────────────────────────

export async function getUnprocessedEvents(
  opts: {
    types?: EventType[];
    since?: Date;
    limit?: number;
  } = {},
): Promise<AgentEvent[]> {
  const where: Record<string, unknown> = { processed: false };
  if (opts.types && opts.types.length > 0) {
    where.type = { in: opts.types };
  }
  if (opts.since) {
    where.createdAt = { gte: opts.since };
  }

  const rows = await prisma.agentEvent.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: opts.limit || 100,
  });

  return rows.map((r) => ({
    ...r,
    payload: JSON.parse(r.payload) as EventPayload,
  }));
}

export async function markProcessed(
  eventIds: number[],
  processedBy: string,
): Promise<void> {
  if (eventIds.length === 0) return;
  await prisma.agentEvent.updateMany({
    where: { id: { in: eventIds } },
    data: {
      processed: true,
      processedAt: new Date(),
      processedBy,
    },
  });
}

// ─── Query ───────────────────────────────────────────────────────────────────

export async function getRecentEvents(
  opts: {
    types?: EventType[];
    source?: string;
    limit?: number;
    since?: Date;
  } = {},
): Promise<AgentEvent[]> {
  const where: Record<string, unknown> = {};
  if (opts.types && opts.types.length > 0) where.type = { in: opts.types };
  if (opts.source) where.source = opts.source;
  if (opts.since) where.createdAt = { gte: opts.since };

  const rows = await prisma.agentEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: opts.limit || 50,
  });

  return rows.map((r) => ({
    ...r,
    payload: JSON.parse(r.payload) as EventPayload,
  }));
}

// Count events of a type in a time window (useful for rate-based triggers)
export async function countEvents(
  type: EventType,
  since: Date,
  source?: string,
): Promise<number> {
  const where: Record<string, unknown> = { type, createdAt: { gte: since } };
  if (source) where.source = source;
  return prisma.agentEvent.count({ where });
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

// Delete processed events older than N hours (run from orchestrator periodically)
export async function pruneEvents(olderThanHours = 72): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600000);
  const result = await prisma.agentEvent.deleteMany({
    where: {
      processed: true,
      createdAt: { lt: cutoff },
    },
  });
  return result.count;
}
