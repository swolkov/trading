import assert from "node:assert/strict";
import test from "node:test";
import { closeNetBid, drawdownHalt, etDay, exitDecision, openNetAsk, type OwnedPositionRecord } from "../src/lib/options-live-guardian";
import { OPTIONS_LIVE_ACCOUNT, type LiveContract } from "../src/lib/options-live-policy";

const now = Date.parse("2026-09-14T15:00:00Z");
const c = (optionId: string, bid: number, ask: number, strike: number): LiveContract => ({ optionId, underlying: "SPY", kind: "call", strike, expiry: "2026-10-16", multiplier: 100, bid, ask, quoteAtMs: now });
const spread: OwnedPositionRecord = { id: "ref", accountNumber: OPTIONS_LIVE_ACCOUNT, openingRefId: "ref", kind: "call_debit", direction: "debit", entryPrice: 0.5, width: 1, openedAtMs: now - 3600_000, expiry: "2026-10-16", underlying: "SPY",
  legs: [{ optionId: "L", side: "long", quantity: 1 }, { optionId: "S", side: "short", quantity: 1 }] };

test("close price is the executable net: sell the long at bid, buy the short at ask", () => {
  assert.equal(closeNetBid(spread, [c("L", 1.2, 1.3, 100), c("S", 0.7, 0.8, 101)]), 0.4);
  assert.equal(closeNetBid(spread, [c("L", 1.2, 1.3, 100)]), null);   // a leg without a quote → no price, no exit
  assert.equal(openNetAsk([{ optionId: "L", side: "buy" }, { optionId: "S", side: "sell" }], [c("L", 1.2, 1.3, 100), c("S", 0.7, 0.8, 101)]), 0.6);
});

test("exit rules: half the premium stops, double takes profit, the last week times out, otherwise hold", () => {
  assert.match(exitDecision(spread, [c("L", 0.9, 1.0, 100), c("S", 0.7, 0.8, 101)], now).reason, /premium stop/);       // net 0.20 ≤ 0.25
  assert.match(exitDecision(spread, [c("L", 1.8, 1.9, 100), c("S", 0.7, 0.8, 101)], now).reason, /target/);             // net 1.00 ≥ 1.00 → capped at width 1
  assert.equal(exitDecision(spread, [c("L", 1.8, 1.9, 100), c("S", 0.7, 0.8, 101)], now).limitPrice, 1);
  const hold = exitDecision(spread, [c("L", 1.2, 1.3, 100), c("S", 0.7, 0.8, 101)], now);
  assert.equal(hold.exit, false); assert.match(hold.reason, /holding/);
  const late = exitDecision(spread, [c("L", 1.2, 1.3, 100), c("S", 0.7, 0.8, 101)], Date.parse("2026-10-12T15:00:00Z"));
  assert.equal(late.exit, true); assert.match(late.reason, /time exit/);
  const worthless = exitDecision(spread, [c("L", 0, 0.05, 100), c("S", 0, 0.05, 101)], now);
  assert.equal(worthless.exit, false); assert.match(worthless.reason, /worthless/);
  assert.equal(exitDecision({ ...spread, direction: "credit" }, [], now).exit, false);
});

test("drawdown halt trips $300 under the high-water mark and the mark only rises", () => {
  assert.deepEqual(drawdownHalt(1500, 1500), { halt: false, newHigh: 1500 });
  assert.deepEqual(drawdownHalt(1650, 1500), { halt: false, newHigh: 1650 });
  assert.deepEqual(drawdownHalt(1349, 1650), { halt: true, newHigh: 1650 });
  assert.equal(etDay(Date.parse("2026-09-14T03:30:00Z")), "2026-09-13");   // 23:30 ET the night before
});
