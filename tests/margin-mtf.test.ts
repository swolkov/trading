import assert from "node:assert/strict";
import test from "node:test";
import { mtfState, tfDirection } from "../src/lib/margin-mtf";
import type { TfFeatures } from "../src/lib/margin-scanner";

const feat = (close: number, sma20: number, prevClose20: number): TfFeatures => ({
  close, sma20, prevClose20, hh20: NaN, ll20: NaN, hh90: NaN, ll90: NaN, atr14: NaN, atrRatio30: NaN, volRatio20: NaN, rsi14: NaN,
  lastRange: NaN, dollarVol20: NaN, gapBars: 0, dupBars: 0, staleMs: 0, dataOk: true, dataReason: null,
});
const UP = feat(110, 100, 105);
const DOWN = feat(90, 100, 95);
const MIXED = feat(103, 100, 105);   // above the mean, below the close 20 bars ago

test("direction: up = above SMA20 AND above the close 20 bars ago; down = both below; else flat", () => {
  assert.equal(tfDirection(UP), "up");
  assert.equal(tfDirection(DOWN), "down");
  assert.equal(tfDirection(MIXED), "flat");
  assert.equal(tfDirection(feat(100, 100, 100)), "flat", "equality is flat");
  assert.equal(tfDirection(feat(110, NaN, 100)), "flat", "under-sampled is flat");
  assert.equal(tfDirection(undefined), "flat");
  assert.equal(tfDirection(null), "flat");
});

test("mtfState: U/U/U aligns long, D/D/D aligns short, anything else is null; missing series read flat", () => {
  const f = { "BTC:1d": UP, "BTC:4h": UP, "BTC:1h": UP, "ETH:1d": DOWN, "ETH:4h": DOWN, "ETH:1h": DOWN, "SOL:1d": UP, "SOL:4h": UP, "SOL:1h": MIXED, "XRP:1d": UP, "XRP:4h": DOWN, "XRP:1h": UP };
  assert.deepEqual(mtfState(f, "BTC"), { d1: "up", h4: "up", h1: "up", aligned: "long", text: "U/U/U" });
  assert.deepEqual(mtfState(f, "ETH"), { d1: "down", h4: "down", h1: "down", aligned: "short", text: "D/D/D" });
  assert.deepEqual(mtfState(f, "SOL"), { d1: "up", h4: "up", h1: "flat", aligned: null, text: "U/U/F" });
  assert.deepEqual(mtfState(f, "XRP"), { d1: "up", h4: "down", h1: "up", aligned: null, text: "U/D/U" });
  assert.deepEqual(mtfState(f, "DOGE"), { d1: "flat", h4: "flat", h1: "flat", aligned: null, text: "F/F/F" });
  // Two of three agreeing is NOT aligned — the stamp is strict so the slice means something.
  assert.equal(mtfState({ "A:1d": UP, "A:4h": UP, "A:1h": DOWN }, "A").aligned, null);
});
