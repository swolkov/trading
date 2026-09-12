import { cmeOpen } from "@/lib/futures-desk-rules";

// Read-only operational status. A saved "ready" flag is not evidence of a running engine.
export function futuresHeartbeat(raw: string | undefined, now = Date.now()) {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch { /* Missing or malformed telemetry stays unavailable. */ }
  const timestamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
  const valid = Number.isFinite(timestamp) && timestamp <= now;
  const fresh = valid && now - timestamp < 300_000;
  return {
    at: valid ? new Date(timestamp).toISOString() : null,
    fresh,
    ready: valid && now - timestamp < 75_000 && value.ready === true,
    entryAuthorizationReported: valid && now - timestamp < 75_000 && value.entryAuthorizationReady === true,
    reportedMode: typeof value.mode === "string" ? value.mode : null,
    marketData: fresh && typeof value.mdHealth === "string" ? value.mdHealth : "unverified",
  };
}

// THE FUTURES DESK (Sep 2026): TradingView alerts → Tradovate DEMO, paper only. Its switch and
// guardian state live in AgentConfig (futures-desk.ts writes them); this reads the same keys
// the desk's own refusal logic reads. `guardianFresh` uses the desk's own entry gate (20 min).
// The retired Railway engines' heartbeats (above) are kept ONLY so a process that should be
// dead shows up red if it ever reports again.
export const DESK_GUARDIAN_FRESH_MS = 20 * 60_000;
export function futuresDeskHealth(config: Record<string, string>, now = Date.now(), configured = false) {
  let state: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(config.futures_desk_state ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed as Record<string, unknown>;
  } catch { /* unreadable state reads as "no guardian report", never as healthy */ }
  const guardianTs = typeof state.guardianAt === "string" ? Date.parse(state.guardianAt) : NaN;
  const guardianValid = Number.isFinite(guardianTs) && guardianTs <= now;
  return {
    configured,                                                  // broker + webhook credentials present on the server
    enabled: config.futures_desk_enabled === "true",             // the typed-ENABLE switch
    disabledReason: typeof state.disabledReason === "string" ? state.disabledReason : null,
    guardianAt: guardianValid ? new Date(guardianTs).toISOString() : null,
    guardianFresh: guardianValid && now - guardianTs < DESK_GUARDIAN_FRESH_MS,
    lastError: typeof state.lastError === "string" ? state.lastError : null,
    equity: typeof state.equity === "number" && Number.isFinite(state.equity) ? state.equity : null,
    cmeOpen: cmeOpen(new Date(now)),
  };
}

export function futuresHealth(config: Record<string, string>, now = Date.now(), configured = false) {
  return {
    executionMode: ["paper", "live", "disabled"].includes(config.trading_mode_futures) ? config.trading_mode_futures : "unknown",
    paper: futuresHeartbeat(config.futures_engine_heartbeat_demo, now),
    live: futuresHeartbeat(config.futures_engine_heartbeat_live, now),
    desk: futuresDeskHealth(config, now, configured),
  };
}
export type FuturesHealth = ReturnType<typeof futuresHealth>;
