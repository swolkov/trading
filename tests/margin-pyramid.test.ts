import assert from "node:assert/strict";
import test from "node:test";
import { FOUR_H_SEC, fourHourBarComplete, isFourHourClose, liveContainerFor, pyramidAddDue, pyramidAddNotional, pyramidBookOf } from "../src/lib/margin-live-risk";
import { exitParams, managedStop } from "../src/lib/margin-shadow";
import { autoShadowPlans, TWIN_SOURCES } from "../src/lib/margin-auto-plans";

// SWING-PYR (Sep 12 2026): swing-wide plus ONE risk-sized add when a completed 4h bar closes
// ≥ +1R. These pin the rule paper scores and live runs to the replay that justified it
// (scripts/backtest-variants.ts Q2f: +$125/trade over swing-wide, t=2.63, worst −$499).

test("swing-pyr is swing-wide's container plus addAtR=1 — on paper and live, identically", () => {
  const paper = exitParams("swing-pyr", 2, 100), wide = exitParams("swing-wide", 2, 100);
  assert.equal(paper.oneR, wide.oneR); assert.equal(paper.trailR, 2); assert.equal(paper.maxHoldH, 24 * 7);
  assert.equal(paper.addAtR, 1);
  assert.equal(wide.addAtR, undefined, "swing-wide never adds");
  assert.equal(exitParams("swing-lev", 2, 100).addAtR, undefined, "the record never adds");
  assert.deepEqual(liveContainerFor("swing-pyr"), { stopPct: 4, maxHoldH: 168, makerEntries: null, trailR: 2, addAtR: 1 });
  assert.equal(liveContainerFor("swing-wide")!.addAtR, undefined);
  assert.equal(liveContainerFor("swing-lev")!.addAtR, undefined);
});

test("swing-pyr rides swing-lev's 4h signals as a twin and is never pooled", () => {
  const sources = autoShadowPlans("breakout", "4h", { tier: "high", factors: [] }, 5).map((p) => p.source);
  assert.ok(sources.includes("swing-pyr"));
  assert.ok(TWIN_SOURCES.includes("swing-pyr" as never));
  assert.ok(!autoShadowPlans("breakout", "5m", { tier: "high", factors: [] }, 5).map((p) => p.source).includes("swing-pyr"));
  assert.ok(!autoShadowPlans("breakout", "4h", { tier: "med", factors: [] }, 5).map((p) => p.source).includes("swing-pyr"), "high conviction only");
});

test("the add is sized so the second unit risks exactly one R to the resting stop, never more than a unit", () => {
  // First unit: $9,200 notional, 4% stop → risks $368. Stop now at breakeven (100).
  const risk = 368, unit = 9200;
  // Added at +1R (104): distance 4/104 = 3.85% → $9,568 wanted, capped at the unit.
  assert.equal(pyramidAddNotional(risk, "long", 104, 100, unit), unit);
  // Added at +1.8R (107.2): distance 7.2/107.2 = 6.72% → $5,480 — the ~2R exposure a
  // same-notional add would have carried is exactly what this prevents.
  assert.ok(Math.abs(pyramidAddNotional(risk, "long", 107.2, 100, unit) - (risk * 107.2) / 7.2) < 1e-9);
  assert.ok(pyramidAddNotional(risk, "long", 107.2, 100, unit) < unit);
  // Stop already ratcheted to +0.5R (102) with the close at +1.2R (104.8): distance 2.8/104.8
  // → $13,774 wanted, capped at the unit (the add is never bigger than the first unit).
  assert.equal(pyramidAddNotional(risk, "long", 104.8, 102, unit), unit);
  // Shorts mirror.
  assert.ok(Math.abs(pyramidAddNotional(risk, "short", 96, 100, unit) - (risk * 96) / 4) < 1e-9, "short at 96 with the stop at 100: 4/96 = 4.17%");
  assert.ok(Math.abs(pyramidAddNotional(risk, "short", 92.8, 100, unit) - (risk * 92.8) / 7.2) < 1e-9);
  // No distance, wrong side, or junk → no add.
  assert.equal(pyramidAddNotional(risk, "long", 100, 100, unit), 0);
  assert.equal(pyramidAddNotional(risk, "long", 99, 100, unit), 0, "stop above a long's price is not protection");
  assert.equal(pyramidAddNotional(risk, "long", 100.05, 100, unit), 0, "under 0.1% is noise");
  assert.equal(pyramidAddNotional(0, "long", 104, 100, unit), 0);
  assert.equal(pyramidAddNotional(risk, "long", 104, 100, 0), 0);
  assert.equal(pyramidAddNotional(NaN, "long", 104, 100, unit), 0);
});

test("the worst case of a pyramid book is one R plus the second unit's fees — never two R", () => {
  // Long from 100, 1R = 4, stop at breakeven. Add at any close from +1R to +1.99R, then a full
  // reversal to the stop: unit 1 loses 0, unit 2 loses (close − 100)/close × its notional = risk.
  const risk = 368, unit = 9200;
  for (const close of [104, 105, 106, 107, 107.9]) {
    const n2 = pyramidAddNotional(risk, "long", close, 100, unit);
    const lossAtStop = (n2 * (close - 100)) / close;
    assert.ok(lossAtStop <= risk + 1e-9, `close ${close}: unit 2 loses $${lossAtStop.toFixed(0)} at the stop`);
  }
  // And the same-notional add the replay REJECTED would have lost ~1.8R here (up to 2R):
  assert.ok((unit * (107.9 - 100)) / 107.9 > 1.8 * risk);
});

test("the add fires on a completed 4h close at or beyond +addAtR, once per book", () => {
  assert.equal(pyramidAddDue(1, 1.0, false), true, "exactly +1R counts");
  assert.equal(pyramidAddDue(1, 0.99, false), false);
  assert.equal(pyramidAddDue(1, 2.5, false), true);
  assert.equal(pyramidAddDue(1, 2.5, true), false, "one add per book, ever");
  assert.equal(pyramidAddDue(undefined, 5, false), false, "a container without addAtR never adds");
  assert.equal(pyramidAddDue(0, 5, false), false);
  assert.equal(pyramidAddDue(1, NaN, false), false);
});

test("4h bar arithmetic: the closing 1-min bar, and completion by open time", () => {
  const open = 1789171200;   // 2026-09-12 00:00:00 UTC — a 4h boundary
  assert.equal(open % FOUR_H_SEC, 0);
  assert.equal(isFourHourClose(open + FOUR_H_SEC - 60), true, "the 03:59 bar closes the 00:00 4h bar");
  assert.equal(isFourHourClose(open + FOUR_H_SEC - 120), false);
  assert.equal(isFourHourClose(open), false, "the 4h bar's own open minute is not its close");
  assert.equal(isFourHourClose(NaN), false);
  assert.equal(fourHourBarComplete(open, open + FOUR_H_SEC - 1), false, "not until its close time");
  assert.equal(fourHourBarComplete(open, open + FOUR_H_SEC), true);
  assert.equal(fourHourBarComplete(NaN, open), false);
});

test("paper's add on the 2R trail keeps the trail on the FIRST unit's entry and R", () => {
  // The trail never looks at the add: from entry 100 / R 4, a +3R peak trails to 104 whether or
  // not a second unit exists. The add changes P&L, not the exit rule.
  const p = exitParams("swing-pyr", 2, 100);
  assert.equal(managedStop(1, 100, 112, 96, 4, p), 104);
  assert.equal(managedStop(1, 100, 108, 96, 4, p), 100, "+2R: still breakeven on the 2R trail");
  assert.equal(managedStop(1, 100, 104, 96, 4, p), 100);
});

test("a pyramid book is exactly one parent plus add-ons that name it; anything else is stacked", () => {
  const A = { ordertxid: "A" }, B = { ordertxid: "B" }, C = { ordertxid: "C" };
  const led = (m: Record<string, string>) => (t: string) => m[t] ?? null;
  assert.equal(pyramidBookOf([A], led({})), null, "a single tranche is a plain book");
  assert.deepEqual(pyramidBookOf([A, B], led({ B: "A" })), { parent: A, addOns: [B] });
  assert.deepEqual(pyramidBookOf([B, A], led({ B: "A" })), { parent: A, addOns: [B] }, "order does not matter");
  assert.equal(pyramidBookOf([A, B], led({})), null, "two independent entries are stacked");
  assert.equal(pyramidBookOf([A, B], led({ B: "Z" })), null, "an add-on whose parent is gone is stacked");
  assert.equal(pyramidBookOf([A, B, C], led({ B: "A", C: "B" })), null, "an add-on of an add-on is stacked");
  assert.deepEqual(pyramidBookOf([A, B, C], led({ B: "A", C: "A" })), { parent: A, addOns: [B, C] });
  assert.equal(pyramidBookOf([B, C], led({ B: "A", C: "A" })), null, "add-ons without their parent are stacked");
});
