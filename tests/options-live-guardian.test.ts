import assert from "node:assert/strict";
import test from "node:test";
import { OPTIONS_LIVE_RULES, closeBlockedBy, closeNetBid, drawdownHalt, entryOrderAction, etDay, exitDecision, invalidationLevel, openNetAsk, ownedRecordAfter, ownershipVerdict, type OwnedPositionRecord } from "../src/lib/options-live-guardian";
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

test("drawdown halt trips $300 under the high-water mark (20% once the high is past $1,500) and the mark only rises", () => {
  assert.deepEqual(drawdownHalt(1500, 1500), { halt: false, newHigh: 1500 });
  assert.deepEqual(drawdownHalt(1650, 1500), { halt: false, newHigh: 1650 });
  assert.deepEqual(drawdownHalt(1199, 1500), { halt: true, newHigh: 1500 });
  assert.deepEqual(drawdownHalt(1349, 1650), { halt: false, newHigh: 1650 });   // $301 under a $1,650 high: the halt there is 20% = $330
  assert.deepEqual(drawdownHalt(1319, 1650), { halt: true, newHigh: 1650 });
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

test("thesis invalidation: the underlying must trade beyond the range edge on two consecutive ticks; inside, stale or missing quotes reset the count", () => {
  const single: OwnedPositionRecord = { ...spread, kind: "long_call", width: 0, legs: [{ optionId: "L", side: "long", quantity: 1 }], invalidationPx: 99, signalDirection: "bullish", invalidationTicks: 0 };
  const held = [c("L", 0.6, 0.65, 100)];   // 1.2× entry: no other rule fires
  const q = (last: number, ageMin = 1) => ({ last, atMs: now - ageMin * 60_000 });
  const first = exitDecision(single, held, now, OPTIONS_LIVE_RULES, q(98.5));
  assert.equal(first.exit, false); assert.equal(first.invalidationTicks, 1); assert.match(first.reason, /SPY 98.5 below its 99 level \(tick 1 of 2\)/);
  const second = exitDecision({ ...single, invalidationTicks: 1 }, held, now, OPTIONS_LIVE_RULES, q(98.7));
  assert.equal(second.exit, true); assert.equal(second.quantity, undefined); assert.equal(second.limitPrice, 0.6); assert.match(second.reason, /thesis invalidated: SPY 98.7 below its 99 level on 2 consecutive ticks/);
  assert.equal(exitDecision({ ...single, invalidationTicks: 1 }, held, now, OPTIONS_LIVE_RULES, q(99.2)).invalidationTicks, 0, "back inside resets");
  assert.equal(exitDecision({ ...single, invalidationTicks: 1 }, held, now, OPTIONS_LIVE_RULES, q(98.5, 16)).invalidationTicks, 0, "a 16-minute-old quote is no quote");
  assert.equal(exitDecision({ ...single, invalidationTicks: 1 }, held, now, OPTIONS_LIVE_RULES, null).invalidationTicks, 0);
  assert.equal(exitDecision({ ...single, invalidationTicks: 1 }, held, now).exit, false, "no spot passed → rule skipped");
  assert.equal(exitDecision({ ...single, invalidationPx: null, invalidationTicks: 5 }, held, now, OPTIONS_LIVE_RULES, q(50)).invalidationTicks, 0, "no level on the record");
  const bear: OwnedPositionRecord = { ...single, kind: "long_put", signalDirection: "bearish", invalidationPx: 101, invalidationTicks: 1 };
  assert.equal(exitDecision(bear, held, now, OPTIONS_LIVE_RULES, q(101.5)).exit, true);
  assert.equal(exitDecision(bear, held, now, OPTIONS_LIVE_RULES, q(100.5)).exit, false);
  // The premium stop still wins, and carries the tick count for persistence.
  const stopped = exitDecision({ ...single, invalidationTicks: 1 }, [c("L", 0.2, 0.25, 100)], now, OPTIONS_LIVE_RULES, q(98.5));
  assert.match(stopped.reason, /premium stop/); assert.equal(stopped.invalidationTicks, 2);
  // What the guardian loop persists: the count (and the peak) — and nothing when neither moved.
  assert.deepEqual(ownedRecordAfter(single, first), { ...single, peakNet: 0.6, invalidationTicks: 1 });
  assert.equal(ownedRecordAfter({ ...single, peakNet: 0.6, invalidationTicks: 1 }, first), null);
  assert.equal(ownedRecordAfter({ ...single, peakNet: 0.6, invalidationTicks: 1 }, exitDecision({ ...single, peakNet: 0.6, invalidationTicks: 1 }, held, now, OPTIONS_LIVE_RULES, q(99.2)))?.invalidationTicks, 0);
});

test("partial exits: a 2-lot banks one contract at 2× entry and trails the rest; a 1-lot never partials; a spread at 91% of its width closes whole", () => {
  const two: OwnedPositionRecord = { ...spread, kind: "long_call", width: 0, legs: [{ optionId: "L", side: "long", quantity: 2 }] };   // entry 0.50
  const under = exitDecision(two, [c("L", 0.99, 1.05, 100)], now);
  assert.equal(under.exit, false); assert.equal(under.quantity, undefined);
  const partial = exitDecision(two, [c("L", 1.0, 1.05, 100)], now);
  assert.equal(partial.exit, true); assert.equal(partial.quantity, 1); assert.equal(partial.limitPrice, 1); assert.match(partial.reason, /partial: 1.00 ≥ 2× entry 0.50 — closing 1 of 2, trailing the rest/);
  const remainder = exitDecision({ ...two, legs: [{ optionId: "L", side: "long", quantity: 1 }], peakNet: 1 }, [c("L", 1.0, 1.05, 100)], now);
  assert.equal(remainder.exit, false); assert.match(remainder.reason, /trail armed/);
  assert.equal(exitDecision({ ...two, legs: [{ optionId: "L", side: "long", quantity: 1 }] }, [c("L", 1.5, 1.55, 100)], now).exit, false, "a 1-lot at 3× just trails");
  const twoSpread: OwnedPositionRecord = { ...spread, legs: spread.legs.map((l) => ({ ...l, quantity: 2 })) };   // width 1, entry 0.50
  const wide = exitDecision(twoSpread, [c("L", 1.7, 1.75, 100), c("S", 0.7, 0.79, 101)], now);   // net 0.91 = 91% of the width
  assert.equal(wide.exit, true); assert.equal(wide.quantity, undefined); assert.match(wide.reason, /max value: 0.91 is 91% of the 1.00 width — closing all/);
  assert.equal(exitDecision({ ...twoSpread, entryPrice: 0.4 }, [c("L", 1.6, 1.65, 100), c("S", 0.7, 0.79, 101)], now).quantity, 1, "at 81% of the width (2× a 0.40 entry) a 2-lot spread partials");
  assert.equal(exitDecision({ ...spread, entryPrice: 0.4 }, [c("L", 1.6, 1.65, 100), c("S", 0.7, 0.79, 101)], now).exit, false, "a 1-lot spread at 81% holds");
});

test("invalidation level is the edge the signal CLEARED, back inside by 0.5%: SOFI breakout at 12.10 over 10.20–12.00 → 11.94; two ticks at 11.90 exit, one holds; bearish mirror", () => {
  assert.equal(OPTIONS_LIVE_RULES.invalidationBufferPct, 0.5);
  assert.equal(invalidationLevel("bullish", 10.2, 12), 11.94);
  assert.equal(invalidationLevel("bearish", 10.2, 12), 10.251);
  assert.equal(invalidationLevel("bullish", 0, 12), null);
  const sofi: OwnedPositionRecord = { ...spread, kind: "long_call", width: 0, underlying: "SOFI", legs: [{ optionId: "L", side: "long", quantity: 1 }], invalidationPx: invalidationLevel("bullish", 10.2, 12), signalDirection: "bullish", invalidationTicks: 0 };
  const held = [c("L", 0.6, 0.65, 12)];
  const q = (last: number) => ({ last, atMs: now - 60_000 });
  const one = exitDecision(sofi, held, now, OPTIONS_LIVE_RULES, q(11.9));
  assert.equal(one.exit, false); assert.equal(one.invalidationTicks, 1);
  const two = exitDecision({ ...sofi, invalidationTicks: 1 }, held, now, OPTIONS_LIVE_RULES, q(11.9));
  assert.equal(two.exit, true); assert.match(two.reason, /thesis invalidated: SOFI 11.9 below its 11.94 level on 2 consecutive ticks/);
  assert.equal(exitDecision({ ...sofi, invalidationTicks: 1 }, held, now, OPTIONS_LIVE_RULES, q(11.95)).invalidationTicks, 0, "still above the level: a breakout holding the line is not a failure");
  const bear: OwnedPositionRecord = { ...sofi, kind: "long_put", signalDirection: "bearish", invalidationPx: invalidationLevel("bearish", 10.2, 12), invalidationTicks: 1 };
  assert.equal(exitDecision(bear, held, now, OPTIONS_LIVE_RULES, q(10.26)).exit, true);
  assert.equal(exitDecision(bear, held, now, OPTIONS_LIVE_RULES, q(10.25)).exit, false);
});

test("a partially filled 2-lot ENTRY is cancelled at once; an unfilled one only after the stale window; a close order is left to the window", () => {
  const t0 = now;
  assert.deepEqual(entryOrderAction({ action: "open", createdAtMs: t0, order: { state: "partially_filled" } }, t0 + 60_000).cancel, true);
  assert.match(entryOrderAction({ action: "open", createdAtMs: t0, order: { state: "partially_filled" } }, t0 + 60_000).reason, /partially filled entry — cancelling the rest now/);
  assert.equal(entryOrderAction({ action: "open", createdAtMs: t0, order: { state: "open" } }, t0 + 14 * 60_000).cancel, false);
  assert.equal(entryOrderAction({ action: "open", createdAtMs: t0, order: { state: "open" } }, t0 + 16 * 60_000).cancel, true);
  assert.equal(entryOrderAction({ action: "close", createdAtMs: t0, order: { state: "partially_filled" } }, t0 + 60_000).cancel, false, "a partially filled CLOSE keeps working inside the window");
  assert.equal(entryOrderAction({ action: "close", createdAtMs: t0, order: { state: "partially_filled" } }, t0 + 16 * 60_000).cancel, true);
  assert.equal(entryOrderAction({ action: "open", createdAtMs: t0, order: { state: "filled" } }, t0 + 60 * 60_000).cancel, false);
});

test("a wanted close names the live entry order it must cancel first; settled or terminal entries do not block", () => {
  const live = { action: "open" as const, state: "accepted", order: { id: "o-entry", state: "open" } };
  assert.deepEqual(closeBlockedBy([live]), { id: "o-entry", state: "open" });
  assert.deepEqual(closeBlockedBy([{ ...live, order: { id: "o-entry", state: "partially_filled" } }])?.id, "o-entry");
  assert.equal(closeBlockedBy([{ ...live, order: { id: "o-entry", state: "cancelled" } }]), null);
  assert.equal(closeBlockedBy([{ ...live, state: "settled" }]), null);
  assert.equal(closeBlockedBy([{ action: "close", state: "accepted", order: { id: "o-close", state: "open" } }]), null, "another close is the core's business, not a cancel");
  assert.equal(closeBlockedBy([]), null);
});

test("ownership: a quantity mismatch at the broker keeps the record and pages once; only legs entirely gone release", () => {
  const rec: OwnedPositionRecord = { ...spread, kind: "long_call", width: 0, legs: [{ optionId: "L", side: "long", quantity: 1 }] };
  assert.deepEqual(ownershipVerdict(rec, [{ optionId: "L", side: "long" }], true), { action: "manage", page: null });
  const kept = ownershipVerdict(rec, [{ optionId: "L", side: "long" }], false);   // broker shows the leg (at 2), the grouper did not match the 1-lot record
  assert.equal(kept.action, "keep"); assert.match(kept.page ?? "", /different quantity than the record .*Kept, not released/);
  assert.deepEqual(ownershipVerdict({ ...rec, mismatchPagedAtMs: now }, [{ optionId: "L", side: "long" }], false), { action: "keep", page: null }, "paged once");
  assert.deepEqual(ownershipVerdict(rec, [], false), { action: "release", page: null });
  assert.deepEqual(ownershipVerdict(rec, [{ optionId: "L", side: "short" }], false).action, "release", "the same contract on the other side is not our leg");
  assert.equal(ownershipVerdict(spread, [{ optionId: "S", side: "short" }], false).action, "keep", "one leg of a spread still there → keep");
});
