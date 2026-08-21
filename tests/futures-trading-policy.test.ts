import assert from "node:assert/strict";
import test from "node:test";
import {
  isBrokerAccountClear,
  isEngineLeaseValid,
  livePolicySessionMultiplier,
  overnightMarginContractCap,
  selectFuturesSymbols,
} from "../src/lib/futures-trading-policy";

test("emergency flatten is complete only when positions and working orders are both clear", () => {
  assert.equal(isBrokerAccountClear([], []), true);
  assert.equal(isBrokerAccountClear([{ netPos: 0 }], [{ ordStatus: "Canceled" }]), true);
  assert.equal(isBrokerAccountClear([{ netPos: 1 }], []), false);
  assert.equal(isBrokerAccountClear([], [{ ordStatus: "Working" }]), false);
  assert.equal(isBrokerAccountClear([], [{ ordStatus: "Accepted" }]), false);
});

test("an old generation loses mutation authority before a standby may take over", () => {
  const renewedAt = 1_000_000;
  const oldLeaseValidUntil = renewedAt + 75_000;
  const standbyTakeoverAt = renewedAt + 90_000;
  assert.equal(isEngineLeaseValid(true, oldLeaseValidUntil, renewedAt + 74_999), true);
  assert.equal(isEngineLeaseValid(true, oldLeaseValidUntil, renewedAt + 75_000), false);
  assert.equal(isEngineLeaseValid(true, oldLeaseValidUntil, standbyTakeoverAt), false);
  assert.equal(isEngineLeaseValid(false, standbyTakeoverAt + 75_000, standbyTakeoverAt), false);
});

test("live and live-clone demo trade all three micros below the full-size threshold", () => {
  assert.deepEqual(selectFuturesSymbols({
    mode: "live",
    accountEquity: 4_367,
    liveMirrorEquity: 0,
    demoLiveClone: true,
    fullSizeThreshold: 60_000,
  }), ["MGC", "MNQ", "MES"]);

  assert.deepEqual(selectFuturesSymbols({
    mode: "demo",
    accountEquity: 59_000,
    liveMirrorEquity: 4_367,
    demoLiveClone: true,
    fullSizeThreshold: 60_000,
  }), ["MGC", "MNQ", "MES"]);
});

test("the contract ladder switches all three roots together at the threshold", () => {
  assert.deepEqual(selectFuturesSymbols({
    mode: "live",
    accountEquity: 60_000,
    liveMirrorEquity: 0,
    demoLiveClone: true,
    fullSizeThreshold: 60_000,
  }), ["GC", "NQ", "ES"]);

  assert.deepEqual(selectFuturesSymbols({
    mode: "demo",
    accountEquity: 10_000,
    liveMirrorEquity: 4_367,
    demoLiveClone: false,
    fullSizeThreshold: 60_000,
  }), ["GC", "NQ", "ES"]);
});

test("an explicit whitelist can only reduce the selected universe", () => {
  assert.deepEqual(selectFuturesSymbols({
    mode: "live",
    accountEquity: 4_367,
    liveMirrorEquity: 0,
    demoLiveClone: true,
    fullSizeThreshold: 60_000,
    whitelist: ["MGC", "MES"],
  }), ["MGC", "MES"]);
});

test("MNQ and MES are RTH-only under the live policy", () => {
  for (const symbol of ["MNQ", "MES"]) {
    assert.equal(livePolicySessionMultiplier(symbol, "morning", 4_367, 3_000), 1);
    assert.equal(livePolicySessionMultiplier(symbol, "midday", 4_367, 3_000), 0.5);
    assert.equal(livePolicySessionMultiplier(symbol, "afternoon", 4_367, 3_000), 1);
    assert.equal(livePolicySessionMultiplier(symbol, "eth_evening", 4_367, 3_000), 0);
    assert.equal(livePolicySessionMultiplier(symbol, "eth_europe", 4_367, 3_000), 0);
  }
});

test("MGC gains qualified evening and London access only when margin permits", () => {
  assert.equal(livePolicySessionMultiplier("MGC", "eth_evening", 2_999, 3_000), 0);
  assert.equal(livePolicySessionMultiplier("MGC", "eth_europe", 2_999, 3_000), 0);
  assert.equal(livePolicySessionMultiplier("MGC", "eth_evening", 3_000, 3_000), 1);
  assert.equal(livePolicySessionMultiplier("MGC", "eth_europe", 3_000, 3_000), 1);
  assert.equal(livePolicySessionMultiplier("MGC", "eth_asia", 4_367, 3_000), 0);
});

test("open, close, pre-market, and exchange halt remain blocked", () => {
  for (const session of ["open", "close", "pre_market", "halt"]) {
    assert.equal(livePolicySessionMultiplier("MGC", session, 4_367, 3_000), 0);
  }
});

test("overnight margin caps both micro and full-size gold and fails closed on unknown margin", () => {
  assert.equal(overnightMarginContractCap(4_367, 2_242.90, 0.9), 1);
  assert.equal(overnightMarginContractCap(60_000, 22_429, 0.9), 2);
  assert.equal(overnightMarginContractCap(60_000, undefined, 0.9), 0);
  assert.equal(overnightMarginContractCap(60_000, 22_429, 1.1), 0);
});
