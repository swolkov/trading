import { prisma } from "./db";

// ============ SESSION CONTEXT ============
// Ephemeral intra-day state shared across all agents.
// Lives for one trading day, auto-cleaned at midnight ET.
// Use for: cross-agent signals, running tallies, coordination flags.

function getTodaySessionId(): string {
  // ET date as session ID
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function getSessionExpiry(): Date {
  // Midnight ET tonight — session expires then
  const now = new Date();
  const etStr = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const midnight = new Date(`${etStr}T23:59:59-04:00`);
  // If we're past midnight, push to next day
  if (midnight < now) midnight.setDate(midnight.getDate() + 1);
  return midnight;
}

// ─── Read / Write ────────────────────────────────────────────────────────────

export async function getSessionValue<T = unknown>(key: string): Promise<T | null> {
  const sessionId = getTodaySessionId();
  const row = await prisma.sessionContext.findUnique({
    where: { sessionId_key: { sessionId, key } },
  });
  if (!row) return null;
  if (row.expiresAt < new Date()) return null; // expired
  return JSON.parse(row.value) as T;
}

export async function setSessionValue(
  key: string,
  value: unknown,
  ttlMinutes?: number,
): Promise<void> {
  const sessionId = getTodaySessionId();
  const expiresAt = ttlMinutes
    ? new Date(Date.now() + ttlMinutes * 60000)
    : getSessionExpiry();

  await prisma.sessionContext.upsert({
    where: { sessionId_key: { sessionId, key } },
    create: { sessionId, key, value: JSON.stringify(value), expiresAt },
    update: { value: JSON.stringify(value), expiresAt },
  });
}

export async function deleteSessionValue(key: string): Promise<void> {
  const sessionId = getTodaySessionId();
  await prisma.sessionContext.deleteMany({
    where: { sessionId, key },
  });
}

// ─── Bulk Reads ──────────────────────────────────────────────────────────────

export async function getSessionSnapshot(): Promise<Record<string, unknown>> {
  const sessionId = getTodaySessionId();
  const rows = await prisma.sessionContext.findMany({
    where: { sessionId, expiresAt: { gt: new Date() } },
  });
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = JSON.parse(row.value);
  }
  return result;
}

// ─── Counters (atomic-ish via upsert) ────────────────────────────────────────

export async function incrementSession(key: string, by = 1): Promise<number> {
  const current = await getSessionValue<number>(key);
  const newVal = (current || 0) + by;
  await setSessionValue(key, newVal);
  return newVal;
}

// ─── Convenience: Common Session Keys ────────────────────────────────────────

export const SessionKeys = {
  // Running tallies
  LIVE_TRADE_COUNT: "live_trade_count",
  DEMO_TRADE_COUNT: "demo_trade_count",
  LIVE_CONSECUTIVE_STOPS: "live_consecutive_stops",
  DEMO_CONSECUTIVE_STOPS: "demo_consecutive_stops",
  LIVE_DAILY_PNL: "live_daily_pnl",
  DEMO_DAILY_PNL: "demo_daily_pnl",
  // Cross-agent signals
  ENTRIES_PAUSED: "entries_paused",       // { paused: true, reason: "...", until: "..." }
  STOPS_TIGHTENED: "stops_tightened",     // { active: true, multiplier: 0.75 }
  REGIME_SHIFT_PENDING: "regime_shift",   // { from: "BULL", to: "CHOPPY", detected: "..." }
  // Market flashes
  BTC_FLASH: "btc_flash",               // { direction: "down", pct: -3.2, time: "..." }
  VIX_SPIKE: "vix_spike",               // { level: 32, change: +30%, time: "..." }
  // Synthesis tracking
  TRADES_SINCE_SYNTHESIS: "trades_since_synthesis",
  // Strategic advisor
  DAILY_PLAN: "daily_plan",              // Fable 5 daily trading plan (generated at premarket)
} as const;

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export async function cleanExpiredSessions(): Promise<number> {
  const result = await prisma.sessionContext.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
