import assert from "node:assert/strict";
import test from "node:test";
import { ATR_STOP, atrStopFrac, autoShadowPlans } from "../src/lib/margin-auto-plans";
import { exitParams, positionNotional } from "../src/lib/margin-shadow";
import { coinMtfTrend } from "../src/lib/margin-regime";
import type { TfFeatures } from "../src/lib/margin-scanner";

// C5d — swing-atr: stop = clamp(2 × ATR14 ÷ close, 2%, 8%), risk-sized to that stop.
// C5c — swing-mtf: the coin's own 1d AND 4h close above SMA20.

test("the ATR stop is clamped to 2–8% and unusable ATRs open nothing", () => {
  assert.deepEqual(ATR_STOP, { mult: 2, min: 0.02, max: 0.08 });
  assert.equal(atrStopFrac(0.005), 0.02, "floor");
  assert.equal(atrStopFrac(0.015), 0.03);
  assert.equal(atrStopFrac(0.02), 0.04, "an ATR of 2% is exactly swing-wide's stop");
  assert.equal(atrStopFrac(0.035), 0.07);
  assert.equal(atrStopFrac(0.09), 0.08, "ceiling");
  for (const bad of [0, -1, NaN, Infinity, null, undefined]) assert.equal(atrStopFrac(bad), null, String(bad));
});

test("the row's stop fraction sizes the trade: a wider stop → a smaller position for the SAME dollar risk", () => {
  // ref equity $5,000, risk 6%: $300 at risk. 4% stop → $7,500; 8% → $3,750; 2% → $15,000 (capped at 5× equity = $25,000: not binding).
  assert.ok(Math.abs(positionNotional("swing-atr", 5, 100, 5000, 0.06, 0.04) - 7500) < 1e-9);
  assert.ok(Math.abs(positionNotional("swing-atr", 5, 100, 5000, 0.06, 0.08) - 3750) < 1e-9);
  assert.ok(Math.abs(positionNotional("swing-atr", 5, 100, 5000, 0.06, 0.02) - 15000) < 1e-9);
  assert.ok(Math.abs(positionNotional("swing-atr", 5, 100, 5000, 0.06, null) - 7500) < 1e-9, "no row stop → the 4% default");
  // Risk to the stop is the same dollar amount for every stop width.
  for (const f of [0.02, 0.04, 0.08]) {
    const n = positionNotional("swing-atr", 5, 100, 5000, 0.06, f);
    assert.ok(Math.abs(n * f - 300) < 1e-9, `risk at ${f}`);
  }
  // Every other source ignores the argument.
  assert.equal(positionNotional("swing-wide", 5, 100, 5000, 0.06, 0.08), positionNotional("swing-wide", 5, 100, 5000, 0.06));
  assert.equal(positionNotional("selective", 5, 100, 5000, 0.06, 0.08), positionNotional("selective", 5, 100, 5000, 0.06));
  assert.equal(exitParams("swing-atr", 2, 100, 0.065).oneR, 6.5);
});

test("the plan carries the stop fraction; without an ATR the twin opens nothing", () => {
  const high = { tier: "high", factors: [] };
  const withAtr = autoShadowPlans("breakout", "4h", high, 5, { btcUp: true }, "SOL/USD", { atrFrac: 0.0125 });
  assert.deepEqual(withAtr.find((p) => p.source === "swing-atr"), { source: "swing-atr", lev: 5, stopFrac: 0.025 });
  assert.equal(autoShadowPlans("breakout", "4h", high, 5, { btcUp: true }, "SOL/USD", { atrFrac: null }).some((p) => p.source === "swing-atr"), false);
  assert.equal(autoShadowPlans("breakout", "5m", high, 5, { btcUp: true }, "SOL/USD", { atrFrac: 0.0125 }).some((p) => p.source === "swing-atr"), false, "4h only");
});

const feat = (close: number, sma20: number): TfFeatures => ({ close, ret1: 0, sma20, prevClose20: 0, hh20: 0, ll20: 0, hh90: 0, ll90: 0, atr14: 1, atrRatio30: 1, volRatio20: 1, rsi14: 50, lastRange: 0.01, dollarVol20: 1, gapBars: 0, dupBars: 0, staleMs: 0, dataOk: true, dataReason: null });

test("coinMtfTrend: 1d close > SMA20(1d) AND 4h close > SMA20(4h); anything missing reads null", () => {
  assert.equal(coinMtfTrend({ "SOL:1d": feat(101, 100), "SOL:4h": feat(101, 100) }, "SOL"), true);
  assert.equal(coinMtfTrend({ "SOL:1d": feat(99, 100), "SOL:4h": feat(101, 100) }, "SOL"), false, "daily below");
  assert.equal(coinMtfTrend({ "SOL:1d": feat(101, 100), "SOL:4h": feat(99, 100) }, "SOL"), false, "4h below");
  assert.equal(coinMtfTrend({ "SOL:1d": feat(100, 100), "SOL:4h": feat(101, 100) }, "SOL"), false, "at the average is not above");
  assert.equal(coinMtfTrend({ "SOL:4h": feat(101, 100) }, "SOL"), null, "no daily series");
  assert.equal(coinMtfTrend({ "SOL:1d": feat(101, NaN), "SOL:4h": feat(101, 100) }, "SOL"), null, "under-sampled daily");
  assert.equal(coinMtfTrend(null, "SOL"), null);
  assert.equal(coinMtfTrend({ "BTC:1d": feat(101, 100), "BTC:4h": feat(101, 100) }, "SOL"), null, "another coin's features do not count");
});
