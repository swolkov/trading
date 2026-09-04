import assert from "node:assert/strict";
import test from "node:test";
import { pairMatchesSymbol } from "../src/lib/kraken-pairs";
import {
  EXEC_LOCK_TTL_MS,
  convictionMultiplier,
  execLockHeldSince,
  failClosedOnEmptyPositions,
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
