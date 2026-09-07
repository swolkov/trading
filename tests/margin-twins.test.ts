import assert from "node:assert/strict";
import test from "node:test";
import { autoShadowPlans, TWIN_SOURCES } from "../src/lib/margin-auto-plans";
import { btcRegimeUp, tsmomSignal, REGIME_LOOKBACK } from "../src/lib/margin-regime";
import { exitParams, launchStopDue, managedStop } from "../src/lib/margin-shadow";
import { managedStopTarget } from "../src/lib/margin-live-risk";

// The Sep 7 2026 pre-registered twins: same signals as the live candidate, one change each.
// These tests pin the ONE change per twin and prove the record's container is untouched.

const high = { tier: "high", factors: ["2 timeframes breaking", "volume confirms"] };

test("the record's managed exit is unchanged: breakeven at +1R, trail 1R, ratchet only", () => {
  const entry = 100, oneR = 3;
  assert.equal(managedStop(1, entry, 102, 97, oneR), 97, "below +1R nothing moves");
  assert.equal(managedStop(1, entry, 103, 97, oneR), 100, "+1R → breakeven");
  assert.equal(managedStop(1, entry, 106, 100, oneR), 103, "+2R → trail 1R behind");
  assert.equal(managedStop(1, entry, 104, 103, oneR), 103, "never loosens");
  // and it is the same rule the guardian applies to the real resting stop
  for (const peak of [101, 103, 104.5, 106, 109]) assert.equal(managedStop(1, entry, peak, 97, oneR), managedStopTarget("long", entry, peak, 97, oneR), `peak ${peak}`);
  // shorts mirror
  assert.equal(managedStop(-1, entry, 94, 103, oneR), 97);
});

test("selective-tight trails 0.5R only after +2R; before that it is the record's rule", () => {
  const p = exitParams("selective-tight", 2, 100);
  assert.deepEqual({ tightAfterR: p.tightAfterR, tightTrailR: p.tightTrailR, oneR: p.oneR, maxHoldH: p.maxHoldH }, { tightAfterR: 2, tightTrailR: 0.5, oneR: 3, maxHoldH: 48 });
  assert.equal(managedStop(1, 100, 104.5, 97, 3, p), 101.5, "at +1.5R the trail is still 1R");
  assert.equal(managedStop(1, 100, 106, 97, 3, p), 104.5, "at +2R the trail narrows to 0.5R");
  assert.equal(managedStop(1, 100, 106, 97, 3), 103, "the record keeps 1R at +2R");
});

test("selective-launch closes a trade still below +0.5R after 8h — and nothing else does", () => {
  const p = exitParams("selective-launch", 2, 100);
  assert.equal(launchStopDue(p, 7.9, 0.2), false);
  assert.equal(launchStopDue(p, 8, 0.49), true);
  assert.equal(launchStopDue(p, 8, 0.5), false, "at +0.5R it has launched");
  assert.equal(launchStopDue(p, 30, -0.9), true);
  for (const src of ["selective", "selective-x5", "selective-tight", "selective-btc", "tsmom", null]) assert.equal(launchStopDue(exitParams(src, 2, 100), 40, -0.9), false, String(src));
});

test("selective-btc and tsmom containers are what was registered", () => {
  const b = exitParams("selective-btc", 2, 100);
  const s = exitParams("selective", 2, 100);
  assert.deepEqual({ oneR: b.oneR, maxHoldH: b.maxHoldH, carry: b.carry }, { oneR: s.oneR, maxHoldH: s.maxHoldH, carry: s.carry }, "same container as the record");
  const t = exitParams("tsmom", 2, 100);
  assert.deepEqual({ oneR: t.oneR, maxHoldH: t.maxHoldH, carry: t.carry }, { oneR: 8, maxHoldH: 24 * 14, carry: true });
});

test("plans: the two container twins always ride along; the regime twin only in a confirmed BTC up-regime", () => {
  const base = autoShadowPlans("breakout", "5m", high, 5).map((p) => p.source);
  assert.deepEqual(base, ["selective", "selective-x5", "selective-tight", "selective-launch"]);
  assert.deepEqual(autoShadowPlans("breakout", "5m", high, 5, { btcUp: null }).map((p) => p.source), base, "unreadable regime → no regime twin");
  assert.deepEqual(autoShadowPlans("breakout", "5m", high, 5, { btcUp: false }).map((p) => p.source), base, "down-regime → no regime twin");
  assert.deepEqual(autoShadowPlans("breakout", "5m", high, 5, { btcUp: true }).map((p) => p.source), [...base, "selective-btc"]);
  assert.deepEqual(autoShadowPlans("breakout", "1h", high, 5, { btcUp: true }), [], "twins never widen the entry rule");
  assert.deepEqual(TWIN_SOURCES, ["selective-tight", "selective-launch", "selective-btc"]);
});

test("BTC regime and tsmom signals need 21 complete closes and read close vs 20-day average", () => {
  const flat = Array.from({ length: REGIME_LOOKBACK }, () => 100);
  assert.equal(btcRegimeUp(flat), null, "20 closes is not enough");
  assert.equal(btcRegimeUp([...flat, 101]), true);
  assert.equal(btcRegimeUp([...flat, 99]), false);
  assert.equal(btcRegimeUp([90, ...flat]), false, "exactly at the average is not up");
  const rising = Array.from({ length: 21 }, (_, i) => 100 + i);
  const sig = tsmomSignal(rising);
  assert.ok(sig && sig.long && sig.ret20 > 0 && sig.close > sig.sma20);
  const falling = Array.from({ length: 21 }, (_, i) => 120 - i);
  const f = tsmomSignal(falling);
  assert.ok(f && !f.long && f.ret20 < 0);
  assert.equal(tsmomSignal([1, 2, 3]), null);
});
