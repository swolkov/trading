import test from "node:test";
import assert from "node:assert/strict";
import { describeEdgeSetDrift, isEdgeEnabled, matchEdge } from "../src/lib/realtime-edges";

test("MGC trend continuation is registered as a demo-only edge", () => {
  const edge = matchEdge({
    sym: "MGC",
    setupType: "trend_continuation",
    direction: "long",
    rsi: 58,
    session: "morning",
  });
  assert.equal(edge?.key, "gold_trend_continuation");
  assert.equal(isEdgeEnabled("gold_trend_continuation", "demo", {}), true);
  assert.equal(isEdgeEnabled("gold_trend_continuation", "live", {}), false);
});

test("MGC trend continuation does not widen to other instruments or shorts", () => {
  assert.equal(matchEdge({ sym: "GC", setupType: "trend_continuation", direction: "long", rsi: 58, session: "morning" }), null);
  assert.equal(matchEdge({ sym: "MGC", setupType: "trend_continuation", direction: "short", rsi: 42, session: "morning" }), null);
});

test("the deploy gate accepts a live edge set that matches intent, in any order", () => {
  assert.equal(describeEdgeSetDrift([], []), null);
  assert.equal(describeEdgeSetDrift(["gold_long_europe", "gold_short"], ["gold_short", "gold_long_europe"]), null);
});

test("the deploy gate catches an edge arming itself without a decision", () => {
  const drift = describeEdgeSetDrift(["gold_long_europe"], []);
  assert.match(String(drift), /unexpectedly enabled: gold_long_europe/);
});

test("the deploy gate also catches an edge that was meant to be trading but resolved off", () => {
  const drift = describeEdgeSetDrift([], ["gold_long_europe"]);
  assert.match(String(drift), /expected but disabled: gold_long_europe/);
});

test("the deploy gate reports drift in both directions at once", () => {
  const drift = describeEdgeSetDrift(["index_overbought_short"], ["gold_short"]);
  assert.match(String(drift), /unexpectedly enabled: index_overbought_short/);
  assert.match(String(drift), /expected but disabled: gold_short/);
});
