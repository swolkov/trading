import assert from "node:assert/strict";
import test from "node:test";
import { closeNetBid, drawdownHalt, etDay, exitDecision, openNetAsk, type OwnedPositionRecord } from "../src/lib/options-live-guardian";
import { OPTIONS_LIVE_ACCOUNT, type LiveContract } from "../src/lib/options-live-policy";
import { guardianExDivExit } from "../src/lib/options-events";

const now = Date.parse("2026-09-14T15:00:00Z");
const c = (optionId: string, bid: number, ask: number, strike: number): LiveContract => ({ optionId, underlying: "SPY", kind: "call", strike, expiry: "2026-10-16", multiplier: 100, bid, ask, quoteAtMs: now });
const spread: OwnedPositionRecord = { id: "ref", accountNumber: OPTIONS_LIVE_ACCOUNT, openingRefId: "ref", kind: "call_debit", direction: "debit", entryPrice: 0.5, width: 1, openedAtMs: now - 3600_000, expiry: "2026-10-16", underlying: "SPY",
  legs: [{ optionId: "L", side: "long", quantity: 1 }, { optionId: "S", side: "short", quantity: 1 }] };

test("close price is the executable net: sell the long at bid, buy the short at ask", () => {
  assert.equal(closeNetBid(spread, [c("L", 1.2, 1.3, 100), c("S", 0.7, 0.8, 101)]), 0.4);
  assert.equal(closeNetBid(spread, [c("L", 1.2, 1.3, 100)]), null);   // a leg without a quote → no price, no exit
  assert.equal(openNetAsk([{ optionId: "L", side: "buy" }, { optionId: "S", side: "sell" }], [c("L", 1.2, 1.3, 100), c("S", 0.7, 0.8, 101)]), 0.6);
});

test("exit rules: half the premium stops, full width exits, the last week times out, otherwise hold", () => {
  assert.match(exitDecision(spread, [c("L", 0.9, 1.0, 100), c("S", 0.7, 0.8, 101)], now).reason, /premium stop/);       // net 0.20 ≤ 0.25
  assert.match(exitDecision(spread, [c("L", 1.8, 1.9, 100), c("S", 0.7, 0.8, 101)], now).reason, /max value/);          // net 1.00 = full width 1
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

test("trail: no fixed target — armed at 1.5× entry, exits when half the best gain is given back, peak is returned for persistence", () => {
  const single: OwnedPositionRecord = { ...spread, kind: "long_call", width: 0, legs: [{ optionId: "L", side: "long", quantity: 1 }] };   // entry 0.50
  const early = exitDecision(single, [c("L", 0.7, 0.75, 100)], now);                       // 1.4× — not armed, holds
  assert.equal(early.exit, false); assert.equal(early.peakNet, 0.7); assert.doesNotMatch(early.reason, /trail armed/);
  const armed = exitDecision({ ...single, peakNet: 0.7 }, [c("L", 1.2, 1.25, 100)], now);   // 2.4× — armed, holds, peak 1.2
  assert.equal(armed.exit, false); assert.equal(armed.peakNet, 1.2); assert.match(armed.reason, /trail armed/);
  const pulled = exitDecision({ ...single, peakNet: 1.2 }, [c("L", 0.9, 0.95, 100)], now);  // floor = 0.5 + 0.7 × 0.5 = 0.85; 0.90 holds
  assert.equal(pulled.exit, false); assert.equal(pulled.peakNet, 1.2);
  const trailed = exitDecision({ ...single, peakNet: 1.2 }, [c("L", 0.85, 0.9, 100)], now); // 0.85 ≤ 0.85 → out with the gain kept
  assert.equal(trailed.exit, true); assert.match(trailed.reason, /trail: 0.85 ≤ 0.85 after a peak of 1.20/); assert.equal(trailed.limitPrice, 0.85);
  const restart = exitDecision(single, [c("L", 0.85, 0.9, 100)], now);                      // a record without a peak cannot invent one: 1.7× just arms
  assert.equal(restart.exit, false); assert.equal(restart.peakNet, 0.85);
  assert.match(exitDecision({ ...single, peakNet: 3 }, [c("L", 0.2, 0.25, 100)], now).reason, /premium stop/);   // the stop still wins below half
});

test("ex-dividend exit: a call debit spread with its short call in the money closes when the ex-date is two days out, not three, and never out of the money", () => {
  const pos = { ...spread, exDivAt: "2026-09-16", shortStrike: 101 };                       // now = Sep 14 15:00Z → ex-date open is 1.9 days out
  const q = (last: number, ageMin = 1) => ({ last, atMs: now - ageMin * 60_000 });
  assert.equal(guardianExDivExit(pos, q(101.5), now).exit, true);
  assert.match(guardianExDivExit(pos, q(101.5), now).reason, /ex-dividend exit: short call 101 is in the money \(spot 101.5\) with ex-dividend 2026-09-16/);
  assert.equal(guardianExDivExit({ ...pos, exDivAt: "2026-09-17" }, q(101.5), now).exit, false);   // 2.9 days out
  assert.equal(guardianExDivExit(pos, q(100.5), now).exit, false);                                   // out of the money
  assert.equal(guardianExDivExit(pos, null, now).exit, false);                                       // no quote → rule skipped, said so
  assert.match(guardianExDivExit(pos, null, now).reason, /quote unavailable/);
  assert.equal(guardianExDivExit(pos, q(101.5, 16), now).exit, false);                               // a 16-minute-old quote is no quote
  assert.match(guardianExDivExit(pos, q(101.5, 16), now).reason, /quote is 16 min old — treated as unavailable/);
  assert.equal(guardianExDivExit(pos, q(101.5, 15), now).exit, true);
  assert.equal(guardianExDivExit({ ...pos, kind: "long_call" }, q(101.5), now).exit, false);
  assert.equal(guardianExDivExit({ ...pos, exDivAt: "2026-09-10" }, q(101.5), now).exit, false);   // already past
  // A projected date is a ±7-day window: act from its earliest plausible day.
  assert.equal(guardianExDivExit({ ...pos, exDivAt: "2026-09-22", exDivSource: "projected" }, q(101.5), now).exit, true);    // window opens Sep 15 → 0.9 days out
  assert.equal(guardianExDivExit({ ...pos, exDivAt: "2026-09-25", exDivSource: "projected" }, q(101.5), now).exit, false);   // window opens Sep 18 → 3.9 days out
  assert.equal(guardianExDivExit({ ...pos, exDivAt: "2026-09-10", exDivSource: "projected" }, q(101.5), now).exit, true);    // window runs to Sep 17 — still live
  assert.equal(guardianExDivExit({ ...pos, exDivAt: "2026-09-05", exDivSource: "projected" }, q(101.5), now).exit, false);   // window closed Sep 12
});
