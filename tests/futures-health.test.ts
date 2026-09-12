import test from "node:test";
import assert from "node:assert/strict";
import { futuresHealth, futuresHeartbeat } from "../src/lib/futures-health";
const now = Date.parse("2026-09-12T18:00:00Z");
test("stale ready flag and market data never certify a stopped engine", () => {
  const h = futuresHeartbeat(JSON.stringify({timestamp: "2026-08-31T14:33:03Z", ready: true, mdHealth: "databento"}), now);
  assert.equal(h.fresh, false); assert.equal(h.ready, false); assert.equal(h.marketData, "unverified");
});
test("missing, malformed and future timestamps stay unavailable", () => {
  for (const raw of [undefined, "{", "null", "[]", JSON.stringify({ timestamp: "2026-09-13T00:00:00Z", ready: true })]) {
    const h = futuresHeartbeat(raw, now); assert.equal(h.at, null); assert.equal(h.ready, false);
  }
});
test("fresh heartbeat reports readiness without changing configured execution mode", () => {
  const h = futuresHealth({trading_mode_futures: "paper", futures_engine_heartbeat_demo: JSON.stringify({timestamp: "2026-09-12T17:59:00Z", ready: true, mode: "demo", mdHealth: "databento"})}, now);
  assert.equal(h.executionMode, "paper"); assert.equal(h.paper.ready, true); assert.equal(h.paper.reportedMode, "demo"); assert.equal(h.live.fresh, false);
  assert.equal(futuresHealth({trading_mode_futures: "live"}, now).executionMode, "live");
});
test("heartbeat exactly at five minutes is stale", () => {
  assert.equal(futuresHeartbeat(JSON.stringify({timestamp: "2026-09-12T17:55:00Z", ready: true}), now).ready, false);
});

test("disabled and unknown configuration cannot masquerade as paper", () => {
  assert.equal(futuresHealth({}, now).executionMode, "unknown");
  assert.equal(futuresHealth({trading_mode_futures: "disabled"}, now).executionMode, "disabled");
  assert.equal(futuresHealth({trading_mode_futures: "garbage"}, now).executionMode, "unknown");
});
test("reporting tolerance does not extend the 75-second process lease", () => {
  const h = futuresHeartbeat(JSON.stringify({timestamp: "2026-09-12T17:58:45Z", ready: true, entryAuthorizationReady: true, mdHealth: "websocket"}), now);
  assert.equal(h.fresh, true); assert.equal(h.ready, false); assert.equal(h.entryAuthorizationReported, false);
});
test("process lease and entry authorization are separate, source remains raw telemetry", () => {
  for (const mdHealth of ["databento", "websocket", "yahoo", "none", "circuit_open", "degraded(10)"]) {
    const h = futuresHeartbeat(JSON.stringify({timestamp: "2026-09-12T17:59:30Z", ready: true, entryAuthorizationReady: false, mdHealth}), now);
    assert.equal(h.ready, true); assert.equal(h.entryAuthorizationReported, false); assert.equal(h.marketData, mdHealth);
  }
});
