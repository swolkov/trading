import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFuturesEntryGates, pnlEvidence } from "../src/lib/futures-admin-state";
import { FUTURES_STRATEGY_VERSION } from "../src/lib/strategy-version";

const now = Date.parse("2026-08-20T16:00:00Z");
const healthy = {
  timestamp: new Date(now - 5_000).toISOString(),
  ready: true,
  deploymentId: "deploy-1",
  strategyVersion: FUTURES_STRATEGY_VERSION,
  mdHealth: "databento",
  liveTradingArmed: true,
  operatorTradingEnabled: true,
  riskConfigHealthy: true,
  enabledEdges: ["gold_long"],
  sizingEquity: 4_368,
  entryAuthorizationReady: true,
};

test("live mode alone does not claim real-money readiness", () => {
  const gates = evaluateFuturesEntryGates("live", "live", null, now);
  assert.equal(gates.entriesAllowed, false);
  assert.ok(gates.blockers.includes("engine heartbeat is missing or stale"));
});

test("healthy current live generation with an edge is ready", () => {
  assert.equal(evaluateFuturesEntryGates("live", "live", healthy, now).entriesAllowed, true);
});

test("live infrastructure arm and current-version edge both fail closed", () => {
  const gates = evaluateFuturesEntryGates("live", "live", { ...healthy, liveTradingArmed: false, enabledEdges: [], entryAuthorizationReady: false }, now);
  assert.equal(gates.entriesAllowed, false);
  assert.ok(gates.blockers.includes("live infrastructure arm is off"));
  assert.ok(gates.blockers.includes("no current-version edge is enabled"));
});

test("demo does not require the live infrastructure arm", () => {
  const gates = evaluateFuturesEntryGates("demo", "live", { ...healthy, liveTradingArmed: false }, now);
  assert.equal(gates.entriesAllowed, true);
});

test("stale and old-version engines fail closed", () => {
  const gates = evaluateFuturesEntryGates("live", "live", {
    ...healthy,
    timestamp: new Date(now - 91_000).toISOString(),
    strategyVersion: "old",
  }, now);
  assert.equal(gates.entriesAllowed, false);
  assert.equal(gates.alive, false);
  assert.equal(gates.currentVersion, false);
});

test("admin authorization expires at the same 75-second boundary as engine mutation authority", () => {
  assert.equal(evaluateFuturesEntryGates("live", "live", {
    ...healthy,
    timestamp: new Date(now - 74_999).toISOString(),
  }, now).entriesAllowed, true);
  const expired = evaluateFuturesEntryGates("live", "live", {
    ...healthy,
    timestamp: new Date(now - 75_000).toISOString(),
  }, now);
  assert.equal(expired.alive, true);
  assert.equal(expired.entriesAllowed, false);
  assert.ok(expired.blockers.includes("engine mutation lease has expired"));
});

test("P&L promotion evidence is evaluated independently", () => {
  const winning = Array.from({ length: 15 }, (_, index) => 10 + index);
  const losing = Array.from({ length: 15 }, (_, index) => index < 7 ? -15 : 10);
  assert.equal(pnlEvidence(winning, 15).passes, true);
  assert.equal(pnlEvidence(losing, 15).passes, false);
});
