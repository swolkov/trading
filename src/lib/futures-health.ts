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

export function futuresHealth(config: Record<string, string>, now = Date.now()) {
  return {
    executionMode: ["paper", "live", "disabled"].includes(config.trading_mode_futures) ? config.trading_mode_futures : "unknown",
    paper: futuresHeartbeat(config.futures_engine_heartbeat_demo, now),
    live: futuresHeartbeat(config.futures_engine_heartbeat_live, now),
  };
}
export type FuturesHealth = ReturnType<typeof futuresHealth>;
