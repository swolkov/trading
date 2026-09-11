import assert from "node:assert/strict";
import test from "node:test";
import { autoShadowPlans, TWIN_SOURCES, SHORT_SOURCE } from "../src/lib/margin-auto-plans";
import { btcRegimeUp, tsmomSignal, REGIME_LOOKBACK } from "../src/lib/margin-regime";
import { exitParams, launchStopDue, managedStop } from "../src/lib/margin-shadow";
import { managedStopTarget, liveContainerFor } from "../src/lib/margin-live-risk";

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
  assert.deepEqual(autoShadowPlans("breakout", "4h", high, 5, { btcUp: true }).map((p) => p.source), ["swing-lev", "swing-spot", "swing-wide", "swing-tight"], "4h/1d go to the slow family and its own trail twins, never to the fast twins");
  assert.deepEqual(autoShadowPlans("breakout", "4h", { tier: "med", factors: [] }, 5), [], "slow family is high conviction only");
  assert.deepEqual(autoShadowPlans("breakdown", "4h", high, 5, { btcUp: false }), [], "slow family is longs only; the 5m/15m short sleeve does not take 4h");
  assert.deepEqual(TWIN_SOURCES, ["selective-tight", "selective-launch", "selective-btc", "selective-majors", "swing-wide", "swing-tight"]);
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

test("selective-majors rides the same signal only on BTC, ETH and SOL, in the record's container", () => {
  const src = (symbol?: string, regime?: { btcUp: boolean | null }) => autoShadowPlans("breakout", "5m", high, 5, regime, symbol).map((p) => p.source);
  assert.ok(src("BTC/USD").includes("selective-majors"));
  assert.ok(src("ETH/USD").includes("selective-majors"));
  assert.ok(src("SOL/USD").includes("selective-majors"));
  assert.ok(src("XBT/USD").includes("selective-majors"), "Kraken's XBT spelling counts as BTC");
  assert.ok(!src("ADA/USD").includes("selective-majors"));
  assert.ok(!src("RENDER/USD").includes("selective-majors"));
  assert.ok(!src(undefined).includes("selective-majors"), "no symbol → no majors twin");
  assert.deepEqual(src("BTC/USD", { btcUp: true }), ["selective", "selective-x5", "selective-tight", "selective-launch", "selective-btc", "selective-majors"]);
  const m = exitParams("selective-majors", 2, 100), s = exitParams("selective", 2, 100);
  assert.deepEqual({ oneR: m.oneR, maxHoldH: m.maxHoldH, carry: m.carry }, { oneR: s.oneR, maxHoldH: s.maxHoldH, carry: s.carry });
});

test("selective-short: high-conviction breakdowns open ONLY in a confirmed BTC down-regime, and never a long twin", () => {
  const plans = (regime?: { btcUp: boolean | null }) => autoShadowPlans("breakdown", "5m", high, 5, regime, "SOL/USD").map((p) => p.source);
  assert.deepEqual(plans(undefined), [], "no regime → no short");
  assert.deepEqual(plans({ btcUp: null }), [], "unreadable regime → no short");
  assert.deepEqual(plans({ btcUp: true }), [], "up-regime → no short (every short on the record was taken here)");
  assert.deepEqual(plans({ btcUp: false }), [SHORT_SOURCE]);
  assert.deepEqual(autoShadowPlans("breakdown", "1h", high, 5, { btcUp: false }), [], "same timeframe rule as the longs");
  assert.deepEqual(autoShadowPlans("breakdown", "5m", { tier: "med", factors: [] }, 5, { btcUp: false }), [], "same conviction rule");
  assert.deepEqual(autoShadowPlans("breakdown", "5m", { tier: "high", factors: ["stretched"] }, 5, { btcUp: false }), [], "same stretched rule");
  const sh = exitParams("selective-short", 2, 100), s = exitParams("selective", 2, 100);
  assert.deepEqual({ oneR: sh.oneR, maxHoldH: sh.maxHoldH, carry: sh.carry }, { oneR: s.oneR, maxHoldH: s.maxHoldH, carry: s.carry }, "the candidate's container, mirrored");
  assert.ok(!TWIN_SOURCES.includes(SHORT_SOURCE as never), "its own signals — a sleeve, not a twin");
});

test("tsmom has a short leg: negative 20-day return AND close below the 20-day average", () => {
  const falling = Array.from({ length: 21 }, (_, i) => 120 - i);
  const f = tsmomSignal(falling);
  assert.ok(f && f.short && !f.long && f.ret20 < 0 && f.close < f.sma20);
  const rising = Array.from({ length: 21 }, (_, i) => 100 + i);
  const r = tsmomSignal(rising);
  assert.ok(r && r.long && !r.short);
  // negative return but a bounce back above the average: neither leg
  const mixed = [...Array.from({ length: 15 }, () => 120), ...Array.from({ length: 5 }, () => 90), 118];
  const m = tsmomSignal(mixed);
  assert.ok(m && !m.short && !m.long, "20d return < 0 but close above the 20d average → no short");
  const t = exitParams("tsmom-short", 2, 100);
  assert.deepEqual({ oneR: t.oneR, maxHoldH: t.maxHoldH }, { oneR: 8, maxHoldH: 24 * 14 });
});

// ── swing-wide (Sep 9 2026): the wider-trail twin ─────────────────────────────────────
test("swing-wide is swing-lev's container with a 2R trail and a 7-day hold", () => {
  const wide = exitParams("swing-wide", 2, 100);
  const lev = exitParams("swing-lev", 2, 100);
  assert.equal(wide.oneR, lev.oneR, "same 4% stop — only the trail changes");
  assert.equal(wide.trailR, 2);
  assert.equal(wide.maxHoldH, 24 * 7, "a wider trail needs room to be right");
  assert.equal(lev.trailR, undefined, "the control still trails the default 1R");
});

test("a 2R trail holds at breakeven, then rides 2R behind — it never risks more than 1R", () => {
  const wide = exitParams("swing-wide", 2, 100);   // entry 100, oneR = 4
  const stop0 = 96;                                 // the initial 4% stop
  // Below +1R nothing moves, exactly like the control.
  assert.equal(managedStop(1, 100, 103, stop0, wide.oneR, wide), stop0);
  // At +1R the control banks breakeven; the wide trail also sits at breakeven (never worse).
  assert.equal(managedStop(1, 100, 104, stop0, wide.oneR, wide), 100);
  // At +2R the control would already be trailing at +1R; the wide trail is still breakeven.
  assert.equal(managedStop(1, 100, 108, stop0, wide.oneR, wide), 100);
  assert.equal(managedStop(1, 100, 108, stop0, wide.oneR), 104, "control trails 1R behind");
  // At +3R the wide trail rides 2R behind the peak.
  assert.equal(managedStop(1, 100, 112, stop0, wide.oneR, wide), 104);
  // Ratchet only — a pullback never loosens the stop.
  assert.equal(managedStop(1, 100, 109, 104, wide.oneR, wide), 104);
});

test("swing-wide rides swing-lev's signals and is never pooled with the record", () => {
  const plans = autoShadowPlans("breakout", "4h", { tier: "high", factors: [] }, 5);
  const sources = plans.map((p) => p.source);
  assert.ok(sources.includes("swing-lev") && sources.includes("swing-wide"), "same signal, both sleeves");
  assert.ok(TWIN_SOURCES.includes("swing-wide" as never), "twins are excluded from the pooled totals");
  // 5m/15m breakouts belong to the fast family — the wide twin must not appear there.
  assert.ok(!autoShadowPlans("breakout", "5m", { tier: "high", factors: [] }, 5).map((p) => p.source).includes("swing-wide"));
  // Paper only: the guardian mirrors a 1R trail, so there is no live container to arm.
  assert.equal(liveContainerFor("swing-wide"), null);
});

// ── swing-tight (Sep 11 2026): the tighter-trail twin ────────────────────────────────────
test("swing-tight is swing-lev's container with a 0.5R trail once +1R", () => {
  const tight = exitParams("swing-tight", 2, 100);
  const live = exitParams("swing-lev", 2, 100);
  assert.equal(tight.maxHoldH, live.maxHoldH, "same hold as live — only the trail differs");
  assert.equal(tight.oneR, live.oneR, "same 4% stop");
  assert.equal(tight.carry, live.carry);
  assert.equal(tight.tightAfterR, 1);
  assert.equal(tight.tightTrailR, 0.5);
});

test("the tight trail keeps more of a ~1.2R move than the 1R trail — the ETH Sep 11 shape", () => {
  // entry 100, oneR 4 → +1R at 104. Peak 104.96 (= +1.24R, ETH's actual peak in R).
  const live = exitParams("swing-lev", 2, 100), tight = exitParams("swing-tight", 2, 100);
  const stopLive = managedStop(1, 100, 104.96, 96, 4, live);
  const stopTight = managedStop(1, 100, 104.96, 96, 4, tight);
  assert.ok(Math.abs(stopLive - 100.96) < 1e-9, "1R trail: peak − 4 = +0.24R locked");
  assert.ok(Math.abs(stopTight - 102.96) < 1e-9, "0.5R trail: peak − 2 = +0.74R locked");
  // Below +1R the two are identical: the tight trail has not engaged yet.
  assert.equal(managedStop(1, 100, 103.5, 96, 4, tight), managedStop(1, 100, 103.5, 96, 4, live));
});

test("swing-tight rides swing-lev's signals and is never pooled with the record", () => {
  const sources = autoShadowPlans("breakout", "4h", { tier: "high", factors: [] }, 5).map((p) => p.source);
  assert.ok(sources.includes("swing-lev") && sources.includes("swing-tight"), "same signal, both sleeves");
  assert.ok(TWIN_SOURCES.includes("swing-tight" as never), "twins are excluded from the pooled totals");
  assert.ok(!autoShadowPlans("breakout", "5m", { tier: "high", factors: [] }, 5).map((p) => p.source).includes("swing-tight"));
});
