import { FUTURES_STRATEGY_VERSION } from "@/lib/strategy-version";

export interface FuturesHeartbeatState {
  timestamp?: string;
  ready?: boolean;
  deploymentId?: string | null;
  strategyVersion?: string;
  mdHealth?: string;
  liveTradingArmed?: boolean;
  operatorTradingEnabled?: boolean;
  riskConfigHealthy?: boolean;
  enabledEdges?: string[];
  sizingEquity?: number;
  entryAuthorizationReady?: boolean;
}

export interface FuturesEntryGates {
  entriesAllowed: boolean;
  modeRequested: boolean;
  alive: boolean;
  ready: boolean;
  currentVersion: boolean;
  marketDataHealthy: boolean;
  infrastructureArmed: boolean;
  operatorEnabled: boolean;
  riskConfigHealthy: boolean;
  hasEnabledEdge: boolean;
  heartbeatAgeSec: number | null;
  deploymentId: string | null;
  strategyVersion: string | null;
  enabledEdges: string[];
  blockers: string[];
}

export function evaluateFuturesEntryGates(
  mode: "demo" | "live",
  tradingMode: "paper" | "live" | "disabled",
  heartbeat: FuturesHeartbeatState | null,
  now = Date.now(),
): FuturesEntryGates {
  const heartbeatAt = Date.parse(heartbeat?.timestamp ?? "");
  const ageMs = now - heartbeatAt;
  const alive = Number.isFinite(heartbeatAt) && ageMs >= 0 && ageMs < 90_000;
  const authorizationFresh = Number.isFinite(heartbeatAt) && ageMs >= 0 && ageMs < 75_000;
  const ready = heartbeat?.ready === true;
  const currentVersion = heartbeat?.strategyVersion === FUTURES_STRATEGY_VERSION;
  const marketDataHealthy = heartbeat?.mdHealth !== "none" && heartbeat?.mdHealth !== "circuit_open";
  const infrastructureArmed = mode === "demo" || heartbeat?.liveTradingArmed === true;
  const operatorEnabled = heartbeat?.operatorTradingEnabled === true;
  const riskConfigHealthy = heartbeat?.riskConfigHealthy === true;
  const enabledEdges = Array.isArray(heartbeat?.enabledEdges) ? heartbeat.enabledEdges : [];
  const hasEnabledEdge = enabledEdges.length > 0;
  const engineAuthorizationReady = heartbeat?.entryAuthorizationReady === true;
  const modeRequested = mode === "live" ? tradingMode === "live" : tradingMode !== "disabled";

  const blockers: string[] = [];
  if (!modeRequested) blockers.push(tradingMode === "disabled" ? "operator mode is disabled" : "live mode is not selected");
  if (!alive) blockers.push("engine heartbeat is missing or stale");
  else if (!authorizationFresh) blockers.push("engine mutation lease has expired");
  if (!ready) blockers.push("engine is not ready");
  if (!currentVersion) blockers.push("engine is not running the current strategy version");
  if (!operatorEnabled) blockers.push("operator trading gate is off");
  if (!riskConfigHealthy) blockers.push("risk configuration is unavailable");
  if (!infrastructureArmed) blockers.push("live infrastructure arm is off");
  if (!hasEnabledEdge) blockers.push("no current-version edge is enabled");
  if (!(Number(heartbeat?.sizingEquity) > 0)) blockers.push("fresh sizing equity is unavailable");
  if (!engineAuthorizationReady) blockers.push("engine entry authorization is closed");

  return {
    entriesAllowed: engineAuthorizationReady && modeRequested && authorizationFresh && ready && currentVersion,
    modeRequested,
    alive,
    ready,
    currentVersion,
    marketDataHealthy,
    infrastructureArmed,
    operatorEnabled,
    riskConfigHealthy,
    hasEnabledEdge,
    heartbeatAgeSec: alive || Number.isFinite(heartbeatAt) ? Math.max(0, Math.round(ageMs / 1000)) : null,
    deploymentId: heartbeat?.deploymentId ?? null,
    strategyVersion: heartbeat?.strategyVersion ?? null,
    enabledEdges,
    blockers,
  };
}

export function pnlEvidence(values: number[], minimumTrades: number) {
  const split = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, split).reduce((sum, value) => sum + value, 0);
  const secondHalf = values.slice(split).reduce((sum, value) => sum + value, 0);
  if (values.length < 2) return { passes: false, trades: values.length, tStat: 0, firstHalf, secondHalf };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  const tStat = sd > 0 ? mean / (sd / Math.sqrt(values.length)) : 0;
  return { passes: values.length >= minimumTrades && tStat > 2 && firstHalf > 0 && secondHalf > 0, trades: values.length, tStat, firstHalf, secondHalf };
}
