import assert from "node:assert/strict";
import test from "node:test";
import { pairMatchesSymbol } from "../src/lib/kraken-pairs";
import {
  DEFAULT_MAX_LEVERAGE,
  EXEC_LOCK_TTL_MS,
  LEV_CAP_AT_5K,
  LEV_CAP_AT_10K,
  LEV_CAP_AT_20K,
  convictionMultiplier,
  effectiveMaxLeverage,
  execLockHeldSince,
  failClosedOnEmptyPositions,
  leverageCapForEquity,
  liveRiskFraction,
  liveRiskPct,
  pairHasExposure,
  parseLiveRiskBasePct,
} from "../src/lib/margin-live-risk";

test("conviction: high 2x, low 0.5x, null/med/garbage 1x never high", () => {
  assert.equal(convictionMultiplier("high"), 2);
  assert.equal(convictionMultiplier("low"), 0.5);
  assert.equal(convictionMultiplier("med"), 1);
  assert.equal(convictionMultiplier(null), 1);
  assert.equal(convictionMultiplier(undefined), 1);
  assert.equal(convictionMultiplier("HIGH"), 1);
  assert.equal(convictionMultiplier("maybe"), 1);
});

test("live risk defaults 3%, high conviction 6% ceiling, unset key uses 3", () => {
  assert.equal(parseLiveRiskBasePct(undefined), 3);
  assert.equal(parseLiveRiskBasePct(NaN), 3);
  assert.equal(parseLiveRiskBasePct(0), 3);
  assert.equal(parseLiveRiskBasePct(0.5), 0.5);
  assert.equal(parseLiveRiskBasePct(9), 6);
  assert.equal(liveRiskPct(3, "med"), 3);
  assert.equal(liveRiskPct(3, "high"), 6);
  assert.equal(liveRiskPct(3, "low"), 1.5);
  assert.equal(liveRiskPct(3, null), 3);
  assert.equal(liveRiskFraction(3, "high"), 0.06);
  assert.equal(liveRiskFraction(3, "low"), 0.015);
});

test("empty OpenPositions while margin in use fails closed (degraded Kraken read)", () => {
  assert.equal(failClosedOnEmptyPositions(0, 120), true);
  assert.equal(failClosedOnEmptyPositions(0, null), true);
  assert.equal(failClosedOnEmptyPositions(0, undefined), true);
  assert.equal(failClosedOnEmptyPositions(0, 0), false);
  assert.equal(failClosedOnEmptyPositions(1, 120), false);
});

test("anti-stack is either-direction: opposing exposure on the pair is a netting risk", () => {
  const longBtc = ["XXBTZUSD"];
  assert.equal(pairHasExposure("BTC/USD", longBtc, [], pairMatchesSymbol), true);
  assert.equal(pairHasExposure("ETH/USD", longBtc, [], pairMatchesSymbol), false);
  assert.equal(pairHasExposure("BTC/USD", [], ["XBTUSD"], pairMatchesSymbol), true);
  assert.equal(pairHasExposure("SOL/USD", [], [], pairMatchesSymbol), false);
});

test("exec lock TTL outlives the 300s webhook maxDuration", () => {
  assert.ok(EXEC_LOCK_TTL_MS > 300_000);
  assert.equal(execLockHeldSince(""), null);
  assert.equal(execLockHeldSince("2026-09-04T12:00:00.000Z#abc123"), "2026-09-04T12:00:00.000Z");
  assert.equal(execLockHeldSince("2026-09-04T12:00:00.000Z"), "2026-09-04T12:00:00.000Z");
  assert.equal(execLockHeldSince("not-a-date#x"), null);
});

test("paper fraction path equals executor percent path (no silent drift)", () => {
  // Paper stores 3% as 0.03; the executor parses the config key as 3. Same helper both ways.
  assert.equal(liveRiskFraction(0.03 * 100, "high"), 0.06);
  assert.equal(liveRiskFraction(0.03 * 100, "low"), 0.015);
  assert.equal(liveRiskFraction(0.03 * 100, null), 0.03);
  assert.equal(liveRiskFraction(9, "high"), 0.06); // ceiling on the base, then on the product
});

test("leverage cap grows with equity; risk % is a different knob", () => {
  assert.equal(leverageCapForEquity(5_000), LEV_CAP_AT_5K);
  assert.equal(leverageCapForEquity(9_999), LEV_CAP_AT_5K);
  assert.equal(leverageCapForEquity(10_000), LEV_CAP_AT_10K);
  assert.equal(leverageCapForEquity(19_999), LEV_CAP_AT_10K);
  assert.equal(leverageCapForEquity(20_000), LEV_CAP_AT_20K);
  assert.equal(leverageCapForEquity(50_000), LEV_CAP_AT_20K);
  // Missing/garbage equity fails closed to the $5k rung, never "treat as large".
  assert.equal(leverageCapForEquity(0), LEV_CAP_AT_5K);
  assert.equal(leverageCapForEquity(-1), LEV_CAP_AT_5K);
  assert.equal(leverageCapForEquity(NaN), LEV_CAP_AT_5K);
  assert.equal(DEFAULT_MAX_LEVERAGE, 5);
});

test("operator ceiling cannot be exceeded by the ladder; ladder cannot be exceeded by the ceiling", () => {
  // $5k live book: even with ceiling 5, actual cap is 2.
  assert.equal(effectiveMaxLeverage(5, 5_000), 2);
  assert.equal(effectiveMaxLeverage(DEFAULT_MAX_LEVERAGE, 5_000), 2);
  // Grown book, ceiling 5 → 3× then 5×.
  assert.equal(effectiveMaxLeverage(5, 10_000), 3);
  assert.equal(effectiveMaxLeverage(5, 20_000), 5);
  // Operator who wants to stay at 2× forever still can.
  assert.equal(effectiveMaxLeverage(2, 50_000), 2);
  // cfg < 2 means entries disabled — returned as-is so the executor can refuse.
  assert.equal(effectiveMaxLeverage(1, 50_000), 1);
});

// ---- Sep 5 2026: live mirrors paper's container ----
import { LIVE_MAX_HOLD_H, LIVE_STOP_DEFAULT_PCT, liveNotional, managedStopTarget, stopNeedsRatchet } from "../src/lib/margin-live-risk";

test("live container constants equal paper's selective sleeve (3% stop, 48h)", () => {
  assert.equal(LIVE_STOP_DEFAULT_PCT, 3);
  assert.equal(LIVE_MAX_HOLD_H, 48);
});

test("liveNotional is paper's positionNotional on real equity: risk ÷ stop, capped at leverage × equity", () => {
  // $5,300 equity, 3% risk, 3% stop → $5,300 (1×); high conviction 6% → $10,600 = 2× cap.
  assert.equal(Math.round(liveNotional(5300, 0.03, 0.03, 2)), 5300);
  assert.equal(Math.round(liveNotional(5300, 0.06, 0.03, 2)), 10_600);
  // Tighter stop buys a bigger position for the same dollar risk, until the leverage cap binds.
  assert.equal(Math.round(liveNotional(5300, 0.03, 0.015, 2)), 10_600);
  assert.equal(Math.round(liveNotional(5300, 0.03, 0.015, 3)), 10_600);   // 3× cap = $15,900; risk cap $10,600 binds
  // Growth: double the equity, double the dollars at the same 3%.
  assert.equal(Math.round(liveNotional(10_600, 0.03, 0.03, 3)), 10_600);
  // The optional per-trade ceiling still works when set; 0 means none.
  assert.equal(liveNotional(5300, 0.03, 0.03, 2, 100), 200);
  assert.equal(liveNotional(0, 0.03, 0.03, 2), 0);
  assert.equal(liveNotional(5300, 0.03, 0, 2), 0);
});

test("managedStopTarget reproduces paper's exit: breakeven at +1R, then trail 1R, never looser", () => {
  const entry = 100, oneR = 3, initial = 97;
  assert.equal(managedStopTarget("long", entry, 102.9, initial, oneR), 97, "below +1R: unchanged");
  assert.equal(managedStopTarget("long", entry, 103, initial, oneR), 100, "at +1R: breakeven");
  assert.equal(managedStopTarget("long", entry, 106, initial, oneR), 103, "at +2R: trails 1R behind the peak");
  assert.equal(managedStopTarget("long", entry, 106, 104, oneR), 104, "never loosens an already-higher stop");
  // Short mirrored.
  assert.equal(managedStopTarget("short", entry, 97.5, 103, oneR), 103);
  assert.equal(managedStopTarget("short", entry, 97, 103, oneR), 100);
  assert.equal(managedStopTarget("short", entry, 94, 103, oneR), 97);
  // Garbage fails safe (returns the current stop).
  assert.equal(managedStopTarget("long", 0, 106, initial, oneR), initial);
  assert.equal(managedStopTarget("long", entry, NaN, initial, oneR), initial);
});

test("stopNeedsRatchet only moves a resting order for a real improvement (≥0.05% of price)", () => {
  assert.equal(stopNeedsRatchet("long", 97, 100, 105), true);
  assert.equal(stopNeedsRatchet("long", 100, 100.01, 105), false);   // 0.01% — not worth an order
  assert.equal(stopNeedsRatchet("long", 100, 99, 105), false);       // looser is never a ratchet
  assert.equal(stopNeedsRatchet("short", 103, 100, 95), true);
  assert.equal(stopNeedsRatchet("short", 100, 101, 95), false);
  assert.equal(stopNeedsRatchet("long", 97, 100, 0), false);
});
