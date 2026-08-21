import test from "node:test";
import assert from "node:assert/strict";
import { isEdgeEnabled, matchEdge } from "../src/lib/realtime-edges";

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
