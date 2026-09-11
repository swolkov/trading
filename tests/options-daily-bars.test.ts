import assert from "node:assert/strict";
import test from "node:test";
import { completedSessionsOnly } from "../src/lib/rh-options-data";

// THE BUG THIS GUARDS (Sep 11 2026): Yahoo's `period2` is an exclusive end, so the default
// fetch never returned the current session — and the scan's freshness gate only admits an
// entry when the newest bar is TODAY's. The book could not open a position from the Sep 9
// port until this was caught. getDailyBars now fetches through tomorrow and applies this
// filter, so the newest bar is today's after the close and yesterday's before it.

const bar = (date: string, c = 100) => ({ t: `${date}T13:30:00.000Z`, o: c, h: c, l: c, c, v: 1 });
const bars = [bar("2026-09-09"), bar("2026-09-10"), bar("2026-09-11", 75.5)];

test("after the close, today's bar is the newest bar — the freshness gate can pass", () => {
  const out = completedSessionsOnly(bars, new Date("2026-09-11T21:32:00Z"));   // 17:32 ET, the desk job
  assert.equal(out.at(-1)?.t.slice(0, 10), "2026-09-11");
  assert.equal(out.length, 3);
});

test("during the session, today's half-finished bar is dropped", () => {
  const out = completedSessionsOnly(bars, new Date("2026-09-11T19:05:00Z"));   // 15:05 ET
  assert.equal(out.at(-1)?.t.slice(0, 10), "2026-09-10");
  assert.equal(out.length, 2);
});

test("exactly 16:00 ET counts as closed; 15:59 does not", () => {
  assert.equal(completedSessionsOnly(bars, new Date("2026-09-11T20:00:00Z")).length, 3);
  assert.equal(completedSessionsOnly(bars, new Date("2026-09-11T19:59:00Z")).length, 2);
});

test("a newest bar from a previous session is never dropped, whatever the hour", () => {
  const stale = bars.slice(0, 2);
  assert.equal(completedSessionsOnly(stale, new Date("2026-09-11T14:00:00Z")).length, 2);
  assert.equal(completedSessionsOnly(stale, new Date("2026-09-11T22:00:00Z")).length, 2);
});

test("the cron at 22:00 UTC (18:00 ET) sees today's bar", () => {
  assert.equal(completedSessionsOnly(bars, new Date("2026-09-11T22:00:00Z")).at(-1)?.t.slice(0, 10), "2026-09-11");
});

test("empty input is returned empty", () => {
  assert.deepEqual(completedSessionsOnly([], new Date()), []);
});
