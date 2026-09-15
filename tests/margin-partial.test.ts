import assert from "node:assert/strict";
import test from "node:test";
import { legPnl, partialDue, partialFillPx, partialTradePnl, rollPeriods, type LegFees } from "../src/lib/margin-shadow-legs";
import { exitParams, managedStop } from "../src/lib/margin-shadow";

// C5a — swing-partial: bank 30% at +2R, trail the rest 2R. The arithmetic is pure
// (margin-shadow-legs.ts) and shared with the replay engine; the evaluator only decides WHEN.

const FEES: LegFees = { entry: 0.0025, taker: 0.0025, roll4h: 0.0003 };   // paper's constants, an alt

test("the partial fires on the first completed bar whose favourable extreme reaches +2R, once", () => {
  const p = exitParams("swing-partial", 2, 100);   // oneR 4 → +2R = 108
  assert.equal(partialDue(p.partialAtR, 1, 100, p.oneR, { h: 107.9, l: 103 }, false), false);
  assert.equal(partialDue(p.partialAtR, 1, 100, p.oneR, { h: 108, l: 103 }, false), true, "the touch is enough — a resting limit");
  assert.equal(partialDue(p.partialAtR, 1, 100, p.oneR, { h: 112, l: 103 }, true), false, "one partial per trade");
  assert.equal(partialDue(undefined, 1, 100, 4, { h: 200, l: 100 }, false), false, "profiles without a partial never fire");
  assert.equal(partialDue(2, -1, 100, 4, { h: 97, l: 92 }, false), true, "shorts mirror: the low reaches −2R");
  assert.equal(partialDue(2, -1, 100, 4, { h: 97, l: 92.1 }, false), false);
});

test("the partial fills at the level, or at the bar's open when it gapped through (never worse)", () => {
  assert.equal(partialFillPx(1, 100, 4, 2, 105), 108, "opened below the level → filled at the level");
  assert.equal(partialFillPx(1, 100, 4, 2, 110), 110, "gapped through → the better open");
  assert.equal(partialFillPx(-1, 100, 4, 2, 95), 92);
  assert.equal(partialFillPx(-1, 100, 4, 2, 90), 90);
  assert.equal(partialFillPx(1, 100, 4, 2, NaN), 108);
});

test("fee split: the banked leg pays its entry share, a taker exit and rollover to ITS time; the remainder to the final exit", () => {
  // entry 100, 30% banked at 108 after 10h (3 rollover periods), the rest out at 104 after 50h (13 periods)
  const r = partialTradePnl({ dir: 1, entry: 100, exit: 104, notional: 10_000, partial: { px: 108, t: 36_000, notional: 3_000 }, tOpen: 0, tExit: 180_000, carry: true, fees: FEES });
  const bankedGross = 3_000 * 0.08, bankedFees = 3_000 * (0.0025 + 0.0025 + 3 * 0.0003);
  const restGross = 7_000 * 0.04, restFees = 7_000 * (0.0025 + 0.0025 + 13 * 0.0003);
  assert.ok(Math.abs(r.pnl - (bankedGross - bankedFees + restGross - restFees)) < 1e-9, `pnl ${r.pnl}`);
  assert.ok(Math.abs(r.fees - (bankedFees + restFees)) < 1e-9);
  assert.equal(r.remainderNotional, 7_000);
  // Without carry, no rollover on either leg.
  const spot = partialTradePnl({ dir: 1, entry: 100, exit: 104, notional: 10_000, partial: { px: 108, t: 36_000, notional: 3_000 }, tOpen: 0, tExit: 180_000, carry: false, fees: FEES });
  assert.ok(Math.abs(spot.fees - 10_000 * 0.005) < 1e-9, "the entry fee is split pro-rata, never double-charged");
  // The whole-position entry fee equals the sum of the legs' entry shares.
  assert.ok(Math.abs((3_000 + 7_000) * FEES.entry - (3_000 * FEES.entry + 7_000 * FEES.entry)) < 1e-12);
  // A leg with no notional or a bad entry contributes nothing.
  assert.deepEqual(legPnl(1, 0, 104, 1000, 5, true, FEES), { pnl: 0, fees: 0 });
  assert.deepEqual(legPnl(1, 100, 104, 0, 5, true, FEES), { pnl: 0, fees: 0 });
  assert.equal(rollPeriods(0), 0); assert.equal(rollPeriods(0.1), 1); assert.equal(rollPeriods(4), 1); assert.equal(rollPeriods(4.01), 2); assert.equal(rollPeriods(-3), 0);
});

test("the banked leg is worth exactly what a full exit at the level would be, scaled by the fraction", () => {
  const full = legPnl(1, 100, 108, 10_000, 10, true, FEES);
  const third = legPnl(1, 100, 108, 3_000, 10, true, FEES);
  assert.ok(Math.abs(third.pnl - full.pnl * 0.3) < 1e-9);
  assert.ok(Math.abs(third.fees - full.fees * 0.3) < 1e-9);
});

test("a stop-out after the partial: the banked third is kept, the remainder loses at the breakeven stop", () => {
  // Peak reached +2R (108) → 2R trail sits at breakeven (100). Then the trade reverses to 100.
  const p = exitParams("swing-partial", 2, 100);
  assert.equal(managedStop(1, 100, 108, 96, p.oneR, p), 100, "at +2R the 2R trail is at breakeven, as swing-wide's");
  const r = partialTradePnl({ dir: 1, entry: 100, exit: 100, notional: 10_000, partial: { px: 108, t: 14_400, notional: 3_000 }, tOpen: 0, tExit: 28_800, carry: true, fees: FEES });
  const banked = 3_000 * (0.08 - 0.005 - 1 * 0.0003);
  const rest = 7_000 * (0 - 0.005 - 2 * 0.0003);
  assert.ok(Math.abs(r.pnl - (banked + rest)) < 1e-9);
  assert.ok(r.pnl > 0, "swing-wide would have lost the fees on this shape; the partial banked +2R on a third");
});

test("the container is swing-wide's plus the partial; managedStop ignores the partial fields", () => {
  const p = exitParams("swing-partial", 2, 100), w = exitParams("swing-wide", 2, 100);
  assert.deepEqual({ maxHoldH: p.maxHoldH, oneR: p.oneR, carry: p.carry, trailR: p.trailR }, { maxHoldH: w.maxHoldH, oneR: w.oneR, carry: w.carry, trailR: w.trailR });
  assert.equal(p.partialAtR, 2); assert.equal(p.partialFrac, 0.3);
  for (const peak of [101, 104, 108, 112, 116]) assert.equal(managedStop(1, 100, peak, 96, 4, p), managedStop(1, 100, peak, 96, 4, w), `peak ${peak}`);
});
