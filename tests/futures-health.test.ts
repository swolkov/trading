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

// The DESK (TradingView → Tradovate demo) — the panel reads the desk's own keys, not the
// retired engines' heartbeats.
test("desk health reads the switch and guardian from the desk's own state", () => {
  const cfg = { futures_desk_enabled: "true", futures_desk_state: JSON.stringify({ guardianAt: "2026-09-12T17:50:00Z", equity: 57794.27, alerts: {} }) };
  const d = futuresHealth(cfg, now, true).desk;
  assert.equal(d.enabled, true); assert.equal(d.guardianFresh, true); assert.equal(d.guardianAt, "2026-09-12T17:50:00.000Z");
  assert.equal(d.configured, true); assert.equal(d.equity, 57794.27); assert.equal(d.lastError, null); assert.equal(d.disabledReason, null);
  assert.equal(d.cmeOpen, false);   // Saturday 14:00 ET
});
test("desk health fails to red on a stale, missing or malformed guardian report", () => {
  assert.equal(futuresHealth({ futures_desk_state: JSON.stringify({ guardianAt: "2026-09-12T17:39:00Z" }) }, now).desk.guardianFresh, false); // 21 min
  assert.equal(futuresHealth({ futures_desk_state: JSON.stringify({ guardianAt: "2026-09-12T18:01:00Z" }) }, now).desk.guardianAt, null);     // future
  for (const raw of [undefined, "{", "[]", "null"]) {
    const d = futuresHealth(raw == null ? {} : { futures_desk_state: raw }, now).desk;
    assert.equal(d.guardianFresh, false); assert.equal(d.enabled, false); assert.equal(d.configured, false);
  }
  const d = futuresHealth({ futures_desk_enabled: "false", futures_desk_state: JSON.stringify({ disabledReason: "equity −20% from high", lastError: "auth 401" }) }, now).desk;
  assert.equal(d.enabled, false); assert.equal(d.disabledReason, "equity −20% from high"); assert.equal(d.lastError, "auth 401");
});
