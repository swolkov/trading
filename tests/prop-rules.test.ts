import assert from "node:assert/strict";
import test from "node:test";
import {
  PROP_KEEPALIVE_AFTER_DAYS, PROP_RISK_BASE_PCT, PROP_RISK_MAX_PCT, TRADEIFY_2STEP_100K,
  PROP_ESTIMATED_SNAPSHOT_BUFFER_PCT, decimalsOf, fmtQty, keepAliveDue, msSinceReset, msToNextReset, phaseProgress, propBreachState, propDayKey, propFloors, propRoom, propSize, sizingFloors, stopPriceFor, unitsFor,
} from "../src/lib/prop-rules";
import { dxOrderCode, dxQuantityStep, dxSymbolFor, coinOfDxSymbol } from "../src/lib/dxtrade";

const plan = TRADEIFY_2STEP_100K;

test("floors: daily from the 22:00 snapshot, max static from the start", () => {
  const f = propFloors(plan, 100_000);
  assert.equal(f.dailyFloor, 97_000);
  assert.equal(f.maxFloor, 94_000);
  // A day that starts up $1,500 moves the daily floor up with it; the max floor never moves.
  const g = propFloors(plan, 101_500);
  assert.equal(g.dailyFloor, 98_500);
  assert.equal(g.maxFloor, 94_000);
  // A day that starts down $2,000: daily floor $95,000 sits above the static $94,000, so the
  // daily limit still binds (room $3,000, not $4,000). Only from a $97,000 start do they meet.
  const h = propFloors(plan, 98_000);
  assert.equal(h.dailyFloor, 95_000);
  assert.equal(propRoom(plan, 98_000, h).room, 3_000);
  assert.equal(propRoom(plan, 96_500, propFloors(plan, 96_500)).room, 2_500);  // static binds below $97k
  // A LATE (estimated) snapshot lifts the SIZING floor by one 2%-rung stop-out with slip; the
  // real floors — the ones breach detection uses — are untouched.
  const real = propFloors(plan, 100_000);
  const sz = sizingFloors(plan, real, true);
  assert.equal(sz.dailyFloor, 97_000 + 100_000 * PROP_ESTIMATED_SNAPSHOT_BUFFER_PCT);
  assert.equal(sz.maxFloor, 94_000);
  assert.equal(sizingFloors(plan, real, false).dailyFloor, 97_000);
});

test("room and breach state", () => {
  const f = propFloors(plan, 100_000);
  assert.equal(propBreachState(plan, 100_000, f), "ok");
  assert.equal(propBreachState(plan, 98_400, f), "warn");      // $1,600 of $3,000 daily used = 53%
  assert.equal(propBreachState(plan, 97_500, f), "urgent");    // $2,500 of $3,000 = 83%
  assert.equal(propBreachState(plan, 97_000, f), "breached");  // touched the daily floor
  assert.equal(propBreachState(plan, 93_999, propFloors(plan, 99_000)), "breached"); // below the max floor
  const r = propRoom(plan, 99_000, f);
  assert.equal(r.dailyRoom, 2_000);
  assert.equal(r.maxRoom, 5_000);
  assert.equal(r.cushionPct, 5);
});

test("sizing: the 1.5% rung, fixed dollars, fits the room, refuses at the policy gates", () => {
  const f = propFloors(plan, 100_000);
  const full = propSize({ plan, equity: 100_000, floors: f, stopFrac: 0.04, entriesToday: 0, openPositions: 0 });
  assert.equal(full.ok, true);
  assert.equal(full.riskUsd, 1_500);
  assert.equal(full.notionalUsd, 37_500);
  assert.equal(full.riskPct, PROP_RISK_BASE_PCT);
  // Slots and the per-day cap refuse before any arithmetic.
  assert.match(propSize({ plan, equity: 100_000, floors: f, stopFrac: 0.04, entriesToday: 0, openPositions: 1 }).reason, /slots full/);
  assert.match(propSize({ plan, equity: 100_000, floors: f, stopFrac: 0.04, entriesToday: 1, openPositions: 0 }).reason, /daily entry cap/);
  // After a $1,642 loss today (yesterday's position stopped out this morning) the room is
  // $1,358: a full trade would breach the day, so it is sized DOWN rather than refused — and
  // the worst case must still leave an ABSOLUTE margin of $500 above the floor, not 10% of
  // whatever room is left.
  const down = propSize({ plan, equity: 98_358, floors: f, stopFrac: 0.04, entriesToday: 0, openPositions: 0 });
  assert.equal(down.ok, true);
  assert.ok(down.riskUsd < 1_500 && down.riskUsd > 375, `sized down to ${down.riskUsd}`);
  const worst = down.riskUsd * (1 + (0.003 + 0.0008 + 0.003) / 0.04);
  assert.ok(1_358 - worst >= 500 - 1e-6, `margin after a slipped stop-out is ${(1_358 - worst).toFixed(0)}, must be ≥ $500`);
  // Room too small for a quarter-size trade → refuse.
  const tiny = propSize({ plan, equity: 97_800, floors: f, stopFrac: 0.04, entriesToday: 0, openPositions: 0 });
  assert.equal(tiny.ok, false);
  assert.match(tiny.reason, /room too small/);
  // At or below a floor → refuse.
  assert.match(propSize({ plan, equity: 97_000, floors: f, stopFrac: 0.04, entriesToday: 0, openPositions: 0 }).reason, /no room/);
});

test("sizing: the cushion step raises the rung only once the buffer is there, and never past the cap", () => {
  const f = propFloors(plan, 104_000);
  // Equity $104,000 → cushion above the $94k floor is 10% → the 2% rung.
  const stepped = propSize({ plan, equity: 104_000, floors: f, stopFrac: 0.04, entriesToday: 0, openPositions: 0 });
  assert.equal(stepped.riskPct, PROP_RISK_MAX_PCT);
  assert.equal(stepped.riskUsd, 2_000);
  // $103,900 → 9.9% cushion → still the base rung.
  const g = propFloors(plan, 103_900);
  assert.equal(propSize({ plan, equity: 103_900, floors: g, stopFrac: 0.04, entriesToday: 0, openPositions: 0 }).riskPct, PROP_RISK_BASE_PCT);
  // A caller asking for 5% is clamped to the tested ceiling — inside the function, not only in config parsing.
  assert.equal(propSize({ plan, equity: 110_000, floors: propFloors(plan, 110_000), stopFrac: 0.04, entriesToday: 0, openPositions: 0, riskBasePct: 5, riskMaxPct: 5 }).riskUsd, 2_000);
});

test("trading day rolls at 22:00 UTC", () => {
  assert.equal(propDayKey(plan, Date.UTC(2026, 8, 11, 21, 59)), "2026-09-10");
  assert.equal(propDayKey(plan, Date.UTC(2026, 8, 11, 22, 0)), "2026-09-11");
  assert.equal(propDayKey(plan, Date.UTC(2026, 8, 12, 3, 0)), "2026-09-11");
  assert.equal(msToNextReset(plan, Date.UTC(2026, 8, 11, 21, 0)), 3_600_000);
  assert.equal(msToNextReset(plan, Date.UTC(2026, 8, 11, 22, 0)), 86_400_000);
  assert.equal(msSinceReset(plan, Date.UTC(2026, 8, 11, 22, 5)), 5 * 60_000);
  assert.equal(msSinceReset(plan, Date.UTC(2026, 8, 11, 21, 0)), 23 * 3_600_000);
});

test("keep-alive fires one day inside the 28-day warning", () => {
  const now = Date.UTC(2026, 8, 30);
  assert.equal(keepAliveDue(null, now), false);
  assert.equal(keepAliveDue(now - (PROP_KEEPALIVE_AFTER_DAYS - 1) * 86_400_000, now), false);
  assert.equal(keepAliveDue(now - PROP_KEEPALIVE_AFTER_DAYS * 86_400_000, now), true);
});

test("phase progress on closed balance", () => {
  const p1 = phaseProgress(plan, 1, 104_000);
  assert.equal(p1.target, 10_000);
  assert.equal(p1.progress, 0.4);
  assert.equal(p1.remaining, 6_000);
  const done = phaseProgress(plan, 1, 110_500);
  assert.equal(done.remaining, 0);
  assert.equal(done.progress, 1);
  const p2 = phaseProgress(plan, 2, 100_000);
  assert.equal(p2.target, 5_000);
  const funded = phaseProgress(plan, 3, 100_000);
  assert.equal(funded.label, "funded");
  assert.equal(funded.target, null);
});

test("units and stop prices round DOWN — never more size, never a looser stop", () => {
  assert.equal(unitsFor(37_500, 77_000, 0.01), 0.48);       // 0.487… → 0.48
  assert.equal(unitsFor(37_500, 75, 1), 500);
  assert.equal(unitsFor(37_500, 0.0000037, 1), 10_135_135_135);
  assert.equal(unitsFor(0, 100, 1), 0);
  assert.equal(stopPriceFor(77_312.2, 0.04, 0.01), 74_219.71);
  assert.equal(stopPriceFor(0.2036, 0.04, 0.0001), 0.1954);
  assert.equal(dxQuantityStep(77_000), 0.01);
  assert.equal(dxQuantityStep(150), 0.1);
  assert.equal(dxQuantityStep(0.5), 1);
  // The venue gets an exact decimal string — no float tails, never rounded up.
  assert.equal(fmtQty(57 * 0.01, 0.01), "0.57");
  assert.equal(fmtQty(0.29, 0.01), "0.29");
  assert.equal(fmtQty(0.57, 0.01), "0.57");
  assert.equal(fmtQty(3 * 0.1, 0.1), "0.3");
  assert.equal(fmtQty(0.487, 0.01), "0.48");
  assert.equal(fmtQty(10_135_135_135.7, 1), "10135135135");
  assert.equal(decimalsOf(0.01), 2);
  assert.equal(decimalsOf(1), 0);
  assert.equal(decimalsOf(0.000001), 6);
});

test("symbols and order codes", () => {
  assert.equal(dxSymbolFor("btc"), "BTC/USD");
  assert.equal(coinOfDxSymbol("PEPE/USD"), "PEPE");
  const a = dxOrderCode("pd"), b = dxOrderCode("pd");
  assert.notEqual(a, b);
  assert.match(a, /^pd-[a-z0-9]+-[a-z0-9]{6}$/);
});
