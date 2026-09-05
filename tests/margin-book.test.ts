import assert from "node:assert/strict";
import test from "node:test";
import { applyReconcile, planReconcile, safeStopString, type BookStop } from "../src/lib/margin-book";

const stop = (txid: string, price: number, vol: number, extra: Partial<BookStop> = {}): BookStop =>
  ({ txid, ordertype: "stop-loss", side: "sell", price, vol, volExec: 0, opentm: 1, ...extra });
const book = (vol: number, targetLevel: number, px = 105) => ({ side: "long" as const, vol, targetLevel, px, priceDecimals: 2, lotDecimals: 4 });

test("flat book: every stop of ours on the pair+side is swept (a resting stop would OPEN)", () => {
  const p = planReconcile(book(0, 97), [stop("A", 97, 1), stop("B", 98, 1, { ordertype: "trailing-stop" })]);
  assert.deepEqual(p.cancel.sort(), ["A", "B"]);
  assert.equal(p.place, null);
  assert.equal(p.covered, true);
});

test("naked book: one exact reduce-only stop at the target, rounding-safe", () => {
  const p = planReconcile(book(1, 97), []);
  assert.deepEqual(p.place, { level: "97.00", vol: "1.0000" });
  assert.deepEqual(p.cancel, []);
  assert.equal(p.covered, true);
});

test("already covered: a single exact stop at or above the target is the keeper, nothing else happens", () => {
  const p = planReconcile(book(1, 97), [stop("A", 97, 1)]);
  assert.equal(p.keeper, "A");
  assert.equal(p.place, null);
  assert.deepEqual(p.cancel, []);
  const better = planReconcile(book(1, 97), [stop("A", 100, 1)]);
  assert.equal(better.keeper, "A", "a better-than-target resting stop is never loosened");
});

test("duplicates: keep the best-priced (tie → newest), cancel the rest", () => {
  const p = planReconcile(book(1, 97), [stop("A", 97, 1, { opentm: 1 }), stop("B", 98, 1, { opentm: 2 }), stop("C", 98, 1, { opentm: 3 })]);
  assert.equal(p.keeper, "C");
  assert.deepEqual(p.cancel.sort(), ["A", "B"]);
});

test("oversized attached stop (position partially closed by hand): replaced by an exact stop", () => {
  // 1 unit left against a 10-unit attached stop — the sell would open 9 short.
  const p = planReconcile(book(1, 97), [stop("A", 97, 10)]);
  assert.deepEqual(p.place, { level: "97.00", vol: "1.0000" });
  assert.deepEqual(p.cancel, ["A"]);
});

test("complementary partial stops: replaced by one exact stop at the best resting level", () => {
  const p = planReconcile(book(1, 97), [stop("A", 97, 0.4), stop("B", 99, 0.6)]);
  assert.deepEqual(p.place, { level: "99.00", vol: "1.0000" });
  assert.deepEqual(p.cancel.sort(), ["A", "B"]);
});

test("ratchet: target above the resting stop → place at target first, cancel the old after", () => {
  const p = planReconcile(book(1, 103, 110), [stop("A", 97, 1)]);
  assert.deepEqual(p.place, { level: "103.00", vol: "1.0000" });
  assert.deepEqual(p.cancel, ["A"]);
});

test("executed volume counts: a stop with 40% already executed does not cover a full book", () => {
  const p = planReconcile(book(1, 97), [stop("A", 97, 1, { volExec: 0.4 })]);
  assert.deepEqual(p.place, { level: "97.00", vol: "1.0000" });
  assert.deepEqual(p.cancel, ["A"]);
});

test("trailing stop: full trailing cover is left alone (fixed extras removed); a shortfall is covered exactly", () => {
  const full = planReconcile(book(1, 97), [stop("T", 3, 1, { ordertype: "trailing-stop" }), stop("F", 97, 1)]);
  assert.equal(full.place, null);
  assert.deepEqual(full.cancel, ["F"]);
  assert.equal(full.covered, true);
  const short = planReconcile(book(10, 97), [stop("T", 3, 1, { ordertype: "trailing-stop" })]);
  assert.deepEqual(short.place, { level: "97.00", vol: "9.0000" });
});

test("unknown trigger price or no price → blocked, nothing is touched", () => {
  assert.ok(planReconcile(book(1, 97), [stop("A", 0, 1)]).blocked);
  assert.ok(planReconcile(book(1, 97, 0), []).blocked);
  const b = planReconcile(book(1, 97), [stop("A", 0, 1)]);
  assert.deepEqual(b.cancel, []);
  assert.equal(b.place, null);
});

test("target at or through the market → blocked (the breach path decides), existing cover kept", () => {
  const p = planReconcile(book(1, 105.001, 105), [stop("A", 97, 1)]);
  assert.ok(p.blocked);
  assert.deepEqual(p.cancel, []);
});

test("safeStopString checks the ROUNDED trigger", () => {
  assert.equal(safeStopString("long", 102.9997, 103, 2), null);
  assert.equal(safeStopString("long", 102.9, 103, 2), "102.90");
  assert.equal(safeStopString("short", 97.0003, 97, 2), null);
  assert.equal(safeStopString("short", 97.2, 97, 2), "97.20");
});

test("applyReconcile: place first; a failed placement cancels nothing; failed cancels are reported", async () => {
  const calls: string[] = [];
  const okIO = { placeStop: async (l: string, v: string) => { calls.push(`place ${l} ${v}`); return "NEW"; }, cancel: async (t: string) => { calls.push(`cancel ${t}`); } };
  const plan = planReconcile(book(1, 103, 110), [stop("A", 97, 1)]);
  const o1 = await applyReconcile(plan, okIO);
  assert.deepEqual(calls, ["place 103.00 1.0000", "cancel A"]);
  assert.equal(o1.placed, "NEW"); assert.deepEqual(o1.cancelled, ["A"]); assert.equal(o1.covered, true);
  const failPlace = { placeStop: async () => { throw new Error("EOrder:Insufficient"); }, cancel: async () => { throw new Error("should not cancel"); } };
  const o2 = await applyReconcile(plan, failPlace);
  assert.ok(o2.placeFailed); assert.deepEqual(o2.cancelled, []); assert.equal(o2.covered, false);
  let n = 0;
  const failCancel = { placeStop: async () => "NEW", cancel: async () => { n++; throw new Error("EOrder:Unknown order"); } };
  const o3 = await applyReconcile(plan, failCancel);
  assert.deepEqual(o3.failedCancels, ["A"]); assert.equal(n, 2, "one retry"); assert.equal(o3.covered, true);
  const blocked = await applyReconcile(planReconcile(book(1, 97, 0), []), okIO);
  assert.equal(blocked.covered, false);
});
