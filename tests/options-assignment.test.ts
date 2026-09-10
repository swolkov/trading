import assert from "node:assert/strict";
import test from "node:test";
import { assessAssignment, extrinsicOf, worstLevel, type AssignmentInput } from "../src/lib/options-assignment";

/** The book's normal state: a 0.78-delta call, 60-120 DTE, no short leg, nothing to flag. */
const base: AssignmentInput = {
  longStrike: 85, longIsCall: true, spot: 101.49, dte: 99, contracts: 1, accountEquityUsd: 3500,
};
const codes = (i: Partial<AssignmentInput>) => assessAssignment({ ...base, ...i }).map((r) => r.code);

test("extrinsic value is price minus what exercising right now would pay", () => {
  assert.ok(Math.abs(extrinsicOf(17.00, 101.49, 85, true) - 0.51) < 1e-9);
  assert.equal(extrinsicOf(3.00, 101.49, 85, true), 0, "never negative");
  assert.ok(Math.abs(extrinsicOf(9.00, 101.49, 110, false) - 0.49) < 1e-9);
  assert.equal(extrinsicOf(2.00, 120, 110, true), 0);
});

test("a normal in-the-money call at 99 DTE flags nothing", () => {
  assert.deepEqual(assessAssignment(base), []);
  assert.equal(worstLevel([]), "none");
});

test("the small-account exercise trap: ITM long call the account cannot pay for", () => {
  // $85 strike = $8,500 of stock against $3,500 of equity.
  assert.ok(codes({ dte: 25 }).includes("exercise_capital"));
  // Silent through the normal hold — the book's 21-day floor is what handles it there, and a
  // warning on every position for three months is a warning nobody reads.
  assert.deepEqual(codes({ dte: 99 }), []);
  const near = assessAssignment({ ...base, dte: 3 });
  assert.equal(near.find((r) => r.code === "exercise_capital")?.level, "high", "urgent once expiry is close");
  assert.equal(assessAssignment({ ...base, dte: 25 }).find((r) => r.code === "exercise_capital")?.level, "watch");
  // Out of the money — nothing to exercise.
  assert.deepEqual(codes({ spot: 80 }), []);
  // A big enough account can simply take delivery.
  assert.deepEqual(codes({ accountEquityUsd: 50_000 }), []);
  // A SPREAD offsets it: the short leg is assigned alongside, so the exposure is the width.
  assert.ok(!codes({ shortStrike: 115, shortMid: 5.00 }).includes("exercise_capital"));
});

test("a short leg with no time value left is an early-assignment warning", () => {
  // Short $95 call, stock at $101.49: $6.49 intrinsic, mid $6.55 → $0.06 of time value.
  assert.ok(codes({ shortStrike: 95, shortMid: 6.55 }).includes("short_extrinsic_thin"));
  // Same strike with real time value left — the holder gains by waiting.
  assert.ok(!codes({ shortStrike: 95, shortMid: 8.00 }).includes("short_extrinsic_thin"));
  // Out of the money short legs are not assigned early.
  assert.ok(!codes({ shortStrike: 115, shortMid: 0.05 }).includes("short_extrinsic_thin"));
});

test("a dividend worth more than the short call's time value means expect assignment", () => {
  const withDiv = codes({ shortStrike: 95, shortMid: 7.20, daysToExDiv: 10, dividendAmount: 0.90 });
  assert.ok(withDiv.includes("ex_dividend_short_call"));
  // A dividend smaller than the time value given up is not a reason to exercise.
  assert.ok(!codes({ shortStrike: 95, shortMid: 7.20, daysToExDiv: 10, dividendAmount: 0.10 }).includes("ex_dividend_short_call"));
  // A dividend after this position expires cannot affect it.
  assert.ok(!codes({ shortStrike: 95, shortMid: 7.20, dte: 5, daysToExDiv: 40, dividendAmount: 0.90 }).includes("ex_dividend_short_call"));
});

test("pin risk only near the short strike and near expiry", () => {
  assert.ok(codes({ shortStrike: 101, shortMid: 2.00, dte: 1 }).includes("pin_risk"));
  assert.ok(!codes({ shortStrike: 101, shortMid: 2.00, dte: 40 }).includes("pin_risk"), "not an issue months out");
  assert.ok(!codes({ shortStrike: 130, shortMid: 0.50, dte: 1 }).includes("pin_risk"), "not near the strike");
});

test("the broker's forced-close window is flagged, never relied on", () => {
  const r = assessAssignment({ ...base, dte: 1, accountEquityUsd: 50_000 });
  assert.deepEqual(r.map((x) => x.code), ["forced_close_window"]);
  assert.match(r[0].message, /already have happened/);
});

test("findings are ordered worst-first and summarised by the worst level", () => {
  const r = assessAssignment({ ...base, dte: 1, shortStrike: 101, shortMid: 0.55 });
  assert.ok(r.length >= 2);
  assert.equal(r[0].level, "high", "a high finding must never sort below a watch");
  assert.equal(worstLevel(r), "high");
  assert.equal(worstLevel([{ level: "watch", code: "forced_close_window", message: "" }]), "watch");
});
