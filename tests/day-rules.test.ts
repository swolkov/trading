import assert from "node:assert/strict";
import test from "node:test";
import { COOLDOWN_AFTER_LOSS_MS, DAY_MAX_LOSSES, DAY_MAX_TRADES, HANDS_OFF_MS, step, type CopilotSnapshot, type CopilotState } from "../src/lib/copilot-rules";
import { COPILOT_STALE_MS, dayRulesView, inWindow, mmss, untilText, windowState } from "../src/lib/day-rules";

// Wed Sep 23 2026 is EDT (UTC−4): 13:30Z = 9:30 AM ET.
const et = (hhmm: string, day = "2026-09-23") => Date.parse(`${day}T${hhmm}:00-04:00`);
const T0 = et("10:00");
const open = (ms: number, sym: "MES" | "MNQ" = "MES"): CopilotSnapshot => ({ nowMs: ms, positions: [{ symbol: sym, netPos: 2, netPrice: 7000 }], orders: [], prices: {}, fills: [] });
const flatAt = (ms: number, px: number, sym: "MES" | "MNQ" = "MES"): CopilotSnapshot => ({ nowMs: ms, positions: [], orders: [], prices: {}, fills: [{ symbol: sym, action: "Sell", qty: 2, price: px, ms: ms - 1_000 }] });
function run(steps: CopilotSnapshot[], start: CopilotState = { trips: {} }): CopilotState {
  let st = start;
  for (const s of steps) st = step(st, s).state;
  return st;
}

test("the window matches the co-pilot's own entry check at both edges (weekday)", () => {
  for (const hhmm of ["09:29", "09:30", "13:59", "14:00", "08:00", "16:00"]) {
    const ms = et(hhmm);
    const st = run([open(ms)]);
    assert.equal(inWindow(ms), st.trips.MES!.entryRules!.window, `at ${hhmm}`);
  }
});

test("weekend: the window stays closed and the next open is Monday 9:30 ET", () => {
  const sat = et("10:00", "2026-09-26");
  assert.equal(inWindow(sat), false);
  const w = windowState(sat);
  assert.equal(w.open, false);
  assert.equal(w.opensAtMs, et("09:30", "2026-09-28"));
});

test("window: open → close time today; before the open → today's 9:30; after 2 PM → tomorrow's 9:30", () => {
  assert.deepEqual(windowState(et("10:00")), { open: true, opensAtMs: null, closesAtMs: et("14:00") });
  assert.equal(windowState(et("08:15")).opensAtMs, et("09:30"));
  assert.equal(windowState(et("14:00")).opensAtMs, et("09:30", "2026-09-24"));
  // Friday afternoon rolls to Monday
  assert.equal(windowState(et("15:00", "2026-09-25")).opensAtMs, et("09:30", "2026-09-28"));
});

test("window across the DST change: Monday Nov 2 2026 opens at 9:30 EST (14:30Z)", () => {
  const fri = Date.parse("2026-10-30T19:00:00Z");   // Fri 3 PM EDT
  assert.equal(windowState(fri).opensAtMs, Date.parse("2026-11-02T14:30:00Z"));
});

test("counts come straight from the co-pilot's day tally", () => {
  const st = run([open(T0), flatAt(T0 + 60_000, 6990), open(T0 + 20 * 60_000), flatAt(T0 + 21 * 60_000, 7010)]);
  const v = dayRulesView({ ...st, lastOkMs: T0 + 21 * 60_000 }, T0 + 22 * 60_000);
  assert.equal(v.trades, st.day!.trades);
  assert.equal(v.trades, 2);
  assert.equal(v.losses, 1);
  assert.equal(v.maxTrades, DAY_MAX_TRADES);
  assert.equal(v.maxLosses, DAY_MAX_LOSSES);
  assert.equal(v.done, false);
  assert.equal(v.planSymbol, "MES");
  assert.equal(v.copilot.stale, false);
});

test("cooldown runs for 10 minutes after a LOSS only", () => {
  const lost = run([open(T0), flatAt(T0 + 60_000, 6990)]);
  const v = dayRulesView(lost, T0 + 3 * 60_000);
  assert.equal(v.cooldownUntilMs, T0 + 60_000 + COOLDOWN_AFTER_LOSS_MS);
  assert.equal(dayRulesView(lost, T0 + 60_000 + COOLDOWN_AFTER_LOSS_MS).cooldownUntilMs, null);
  const won = run([open(T0), flatAt(T0 + 60_000, 7010)]);
  assert.equal(dayRulesView(won, T0 + 3 * 60_000).cooldownUntilMs, null);
});

test("done for the day at 2 losses or 5 trades", () => {
  let st: CopilotState = { trips: {} };
  st = run([open(T0), flatAt(T0 + 60_000, 6990), open(T0 + 20 * 60_000), flatAt(T0 + 21 * 60_000, 6990)], st);
  const v = dayRulesView(st, T0 + 30 * 60_000);
  assert.equal(v.losses, 2);
  assert.equal(v.done, true);
  assert.match(v.doneReason!, /2 losses/);
  const five = dayRulesView({ trips: {}, day: { key: "2026-09-23", trades: 5, losses: 0, netUsd: 0 } }, T0);
  assert.equal(five.done, true);
  assert.match(five.doneReason!, /5 trades/);
  assert.equal(dayRulesView({ trips: {}, day: { key: "2026-09-23", trades: 4, losses: 1, netUsd: 0 } }, T0).done, false);
});

test("the tally resets at the 18:00 ET trading-day roll, like step() does", () => {
  const saved: CopilotState = { trips: {}, day: { key: "2026-09-23", trades: 5, losses: 2, netUsd: -500 } };
  assert.equal(dayRulesView(saved, et("17:59")).trades, 5);
  const after = dayRulesView(saved, et("18:00"));
  assert.equal(after.tradingDay, "2026-09-24");
  assert.equal(after.trades, 0);
  assert.equal(after.losses, 0);
  assert.equal(after.done, false);
});

test("hands off: an open trip counts down 10 minutes from when the co-pilot first saw it", () => {
  const st = run([open(T0)]);
  const v = dayRulesView(st, T0 + 4 * 60_000);
  assert.deepEqual(v.handsOff, [{ symbol: "MES", untilMs: T0 + HANDS_OFF_MS }]);
  assert.deepEqual(dayRulesView(st, T0 + HANDS_OFF_MS).handsOff, []);
});

test("no saved state: counts unknown (null), co-pilot flagged stale", () => {
  const v = dayRulesView(null, T0, false);
  assert.equal(v.trades, null);
  assert.equal(v.losses, null);
  assert.equal(v.done, false);
  assert.equal(v.copilot.enabled, false);
  assert.equal(v.copilot.stale, true);
  assert.equal(dayRulesView({ trips: {}, lastOkMs: T0 - COPILOT_STALE_MS - 1 }, T0).copilot.stale, true);
});

test("countdown text", () => {
  assert.equal(mmss(0), "00:00");
  assert.equal(mmss(-5_000), "00:00");
  assert.equal(mmss(599_100), "10:00");
  assert.equal(mmss(61_000), "01:01");
  assert.equal(untilText(59 * 60_000), "59:00");
  assert.equal(untilText(3 * 3_600_000 + 5 * 60_000), "3h 05m");
  assert.equal(untilText(2 * 86_400_000 + 4 * 3_600_000), "2d 4h");
});
