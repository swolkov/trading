import assert from "node:assert/strict";
import test from "node:test";
import { tickPlan } from "../src/lib/options-desk-schedule";

const at = (iso: string) => tickPlan(Date.parse(iso));
test("guard every 5 minutes inside 09:30–16:05 ET on weekdays, entry at :05/:35 inside 09:35–15:35, collect at 17:32", () => {
  assert.deepEqual(at("2026-09-14T13:30:00Z").guard, true);    // 09:30 ET Monday
  assert.deepEqual(at("2026-09-14T13:32:00Z").guard, false);   // 09:32
  assert.deepEqual(at("2026-09-14T13:35:00Z"), { guard: true, entry: true, collect: false, etMinute: "2026-09-14T09:35" });
  assert.equal(at("2026-09-14T14:05:00Z").entry, true);        // 10:05
  assert.equal(at("2026-09-14T19:35:00Z").entry, true);        // 15:35 — the desk itself refuses the last 30 min
  assert.equal(at("2026-09-14T20:05:00Z").entry, false);       // 16:05: guard only
  assert.equal(at("2026-09-14T20:05:00Z").guard, true);
  assert.equal(at("2026-09-14T20:10:00Z").guard, false);       // 16:10: done for the day
  assert.deepEqual(at("2026-09-14T21:32:00Z").collect, true);  // 17:32 ET
  assert.equal(at("2026-09-13T14:00:00Z").guard, false);       // Sunday
  assert.equal(at("2026-09-13T21:32:00Z").collect, false);
});
test("standard time shifts the same ET clock", () => {
  assert.equal(at("2026-12-14T14:30:00Z").guard, true);        // 09:30 EST
  assert.equal(at("2026-12-14T13:35:00Z").entry, false);       // 08:35 EST — not yet
});
