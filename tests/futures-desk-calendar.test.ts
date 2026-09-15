import assert from "node:assert/strict";
import { test } from "node:test";
import { staticCalendar } from "../src/lib/event-calendar";
import {
  CME_HOLIDAYS_2026, EVENT_POLICY_KEY, EVENT_REDUCED_MULT, cmeHolidayOn, cmeHolidayRefusal, cmeOpenForEntry, deskCalendar, deskEventPolicy, etHHMM, eventContextOf,
  eventWindowText, parseEventPolicy, rollWindowRefusal,
} from "../src/lib/futures-desk-calendar";
import { DEFAULT_LIMITS, EVENT_POLICY_FRESH_MS, cmeOpen, entryRefusal, parseAlert, type AlertPayload, type DeskContext } from "../src/lib/futures-desk-rules";
import { deskContextOf } from "../src/lib/futures-desk-risk";
import { futuresHealth } from "../src/lib/futures-health";

const body = { secret: "x", desk: "futures", edge: "index_daily_mr", symbol: "ES", action: "entry", side: "long", price: 6500, stop: 6460, bar: "2026-09-14T21:00:00Z", tf: "1D" };
function alertOf(over: Record<string, unknown> = {}): AlertPayload { const p = parseAlert({ ...body, ...over }); if (!p.ok) throw new Error(p.reason); return p.alert; }
const es = alertOf();
const okCtx: DeskContext = {
  enabled: true, openRoots: [], entriesToday: 0, dayPnlUsd: 0, equityUsd: 50_000, equityHighUsd: 50_000, guardianFreshMs: 60_000,
  openRiskUsd: 0, sameClusterSameSideRiskUsd: 0, dailyLossRemainingUsd: 750, ddMult: 1, newRiskUsd: 250,
  eventMode: "normal", eventPolicyAgeMs: 60_000, eventWindow: null, budgetMult: 1, cmeHoliday: null,
};
/** The static table pinned to the FOMC of Sep 16 2026 (14:00 ET = 18:00Z) so the test does not drift as MACRO_EVENTS is refreshed. */
const fomc = staticCalendar([{ date: "2026-09-16", time: "14:00 ET", name: "FOMC rate decision", approx: true, tier: 1 }]);

// ---- CME holidays: entries only ------------------------------------------------------------------
test("CME holidays: a closed day refuses entries all day; an early close refuses from the close; exits keep the plain cmeOpen", () => {
  assert.equal(CME_HOLIDAYS_2026.length, 7);
  const xmas = new Date("2026-12-25T15:00:00Z");                                  // Fri 10:00 ET — a normal cmeOpen instant
  assert.equal(cmeOpen(xmas), true);
  assert.equal(cmeOpenForEntry(xmas), false);
  assert.equal(cmeHolidayRefusal(xmas), "CME holiday: Christmas Day — closed; entry refused");
  assert.equal(cmeHolidayOn(new Date("2027-01-01T15:00:00Z"))?.name, "New Year's Day");
  const thanksAm = new Date("2026-11-26T15:00:00Z");                              // Thu 10:00 ET — before the 13:00 early close
  assert.equal(cmeOpenForEntry(thanksAm), true); assert.equal(cmeHolidayRefusal(thanksAm), null);
  const thanksPm = new Date("2026-11-26T18:00:00Z");                              // 13:00 ET — the close itself refuses
  assert.equal(cmeOpenForEntry(thanksPm), false);
  assert.equal(cmeHolidayRefusal(thanksPm), "CME early close 13:00 ET (Thanksgiving) — entry refused for the rest of the day");
  assert.equal(cmeOpen(thanksPm), true);                                          // the guardian's exits, drains and rolls still see an open market
  assert.equal(cmeHolidayRefusal(new Date("2026-11-27T18:10:00Z")), null);       // day after: 13:10 ET is before its 13:15 close
  assert.equal(cmeHolidayRefusal(new Date("2026-11-27T18:15:00Z")), "CME early close 13:15 ET (day after Thanksgiving) — entry refused for the rest of the day");
  assert.equal(cmeHolidayRefusal(new Date("2026-12-24T23:00:00Z")), "CME early close 13:15 ET (Christmas Eve) — entry refused for the rest of the day");   // 18:00 ET reopen: still the holiday
  assert.equal(cmeHolidayRefusal(new Date("2026-09-15T15:00:00Z")), null);
  assert.equal(cmeOpenForEntry(new Date("2026-09-12T15:00:00Z")), false);        // Saturday: cmeOpen is false, so is the entry clock
  // In the container the holiday text IS the refusal, after the calendar checks and before position checks.
  assert.equal(entryRefusal(es, { ...okCtx, cmeHoliday: cmeHolidayRefusal(xmas) }, DEFAULT_LIMITS), "CME holiday: Christmas Day — closed; entry refused");
});

// ---- the event policy ------------------------------------------------------------------------------
test("FOMC Sep 16 2026 14:00 ET: paused 17:30–18:30Z, reduced from 06:00Z and until 20:00Z, normal outside; source is static", () => {
  const at = (iso: string) => deskEventPolicy(new Date(iso), fomc);
  assert.equal(at("2026-09-16T05:59:00Z").mode, "normal");
  const early = at("2026-09-16T06:00:00Z");
  assert.equal(early.mode, "reduced"); assert.equal(early.until, "2026-09-16T17:30:00.000Z"); assert.equal(early.event?.name, "FOMC rate decision");
  assert.equal(at("2026-09-16T17:29:00Z").mode, "reduced");
  const paused = at("2026-09-16T17:30:00Z");
  assert.equal(paused.mode, "paused"); assert.equal(paused.until, "2026-09-16T18:30:00.000Z"); assert.equal(paused.source, "static");
  assert.equal(at("2026-09-16T18:30:00Z").mode, "paused");
  const after = at("2026-09-16T18:31:00Z");
  assert.equal(after.mode, "reduced"); assert.equal(after.until, "2026-09-16T20:00:00.000Z");
  assert.equal(at("2026-09-16T20:01:00Z").mode, "normal"); assert.equal(at("2026-09-16T20:01:00Z").until, null); assert.equal(at("2026-09-16T20:01:00Z").event, null);
  assert.equal(paused.at, "2026-09-16T17:30:00.000Z");
  assert.equal(eventWindowText(paused), "FOMC rate decision 14:00 ET — paused until 14:30");
  assert.equal(eventWindowText(early), null);
  assert.equal(etHHMM(Date.parse("2026-09-16T18:00:00Z")), "14:00");
  // The real table carries this FOMC too (the guardian's default calendar).
  assert.ok(deskCalendar(new Date("2026-09-15T16:00:00Z")).some((e) => e.name === "FOMC rate decision" && e.atMs === Date.parse("2026-09-16T18:00:00Z")));
  assert.equal(EVENT_POLICY_KEY, "futures_desk_event_policy");
});

test("a tier-2 print (FOMC minutes) reduces for ±30 min, never pauses", () => {
  const minutes = staticCalendar([{ date: "2026-10-07", time: "14:00 ET", name: "FOMC minutes", approx: true, tier: 2 }]);
  const p = deskEventPolicy(new Date("2026-10-07T18:10:00Z"), minutes);
  assert.equal(p.mode, "reduced"); assert.equal(p.until, "2026-10-07T18:30:00.000Z"); assert.equal(p.event?.tier, 2);
  assert.equal(deskEventPolicy(new Date("2026-10-07T12:00:00Z"), minutes).mode, "normal");
});

test("the entry path: paused refuses with the window, reduced halves the budget on top of the tier, stale or missing refuses", () => {
  const now = Date.parse("2026-09-16T17:45:00Z");
  const pausedRaw = JSON.stringify(deskEventPolicy(new Date(now), fomc));
  const paused = eventContextOf(pausedRaw, now);
  assert.equal(paused.mode, "paused"); assert.equal(paused.ageMs, 0); assert.equal(paused.budgetMult, 1);
  assert.equal(entryRefusal(es, { ...okCtx, eventMode: paused.mode, eventPolicyAgeMs: paused.ageMs, eventWindow: paused.window }, DEFAULT_LIMITS), "event window: FOMC rate decision 14:00 ET — paused until 14:30");
  const reducedRaw = JSON.stringify(deskEventPolicy(new Date("2026-09-16T15:00:00Z"), fomc));
  const reduced = eventContextOf(reducedRaw, Date.parse("2026-09-16T15:05:00Z"));
  assert.equal(reduced.mode, "reduced"); assert.equal(reduced.budgetMult, EVENT_REDUCED_MULT); assert.equal(reduced.window, null);
  assert.equal(entryRefusal(es, { ...okCtx, eventMode: "reduced", eventPolicyAgeMs: reduced.ageMs, eventWindow: null, budgetMult: 0.5, newRiskUsd: 125 }, DEFAULT_LIMITS), null);
  // Composition with the drawdown tier: tier 2 (×0.5) in a reduced window sizes at ×0.25.
  const ctx = deskContextOf({
    enabled: true, state: { equity: 47_000, equityHigh: 50_000, dayKey: "2026-09-16", dayStartEquity: 47_000, balance: 47_000, dayStartBalance: 47_000, guardianAt: "2026-09-16T15:04:00Z" },
    open: [], entriesToday: 0, limits: DEFAULT_LIMITS, alert: { root: "ES", side: "long" }, newRiskUsd: 250 * 0.5 * reduced.budgetMult, now: new Date("2026-09-16T15:05:00Z"), dayKey: "2026-09-16",
    event: reduced, budgetMult: 0.5 * reduced.budgetMult, cmeHoliday: null,
  });
  if ("refusal" in ctx) throw new Error(ctx.refusal);
  assert.equal(ctx.budgetMult, 0.25); assert.equal(ctx.newRiskUsd, 62.5); assert.equal(ctx.eventMode, "reduced");   // eventMode is what the entry stamps on the signal and the trade row
  // Stale (21 min) and missing both refuse, before any position check; unreadable JSON reads as missing, never as normal.
  const stale = eventContextOf(JSON.stringify({ mode: "normal", at: new Date(now - 21 * 60_000).toISOString() }), now);
  assert.equal(stale.ageMs, 21 * 60_000); assert.ok((stale.ageMs as number) > EVENT_POLICY_FRESH_MS);
  assert.equal(entryRefusal(es, { ...okCtx, eventMode: "normal", eventPolicyAgeMs: stale.ageMs }, DEFAULT_LIMITS), "event calendar not checked in the last 20 minutes");
  const missing = eventContextOf(null, now);
  assert.equal(missing.mode, null); assert.equal(missing.ageMs, null); assert.equal(missing.budgetMult, 1);
  assert.equal(entryRefusal(es, { ...okCtx, eventMode: null, eventPolicyAgeMs: null, openRoots: ["ES"] }, DEFAULT_LIMITS), "event calendar not checked in the last 20 minutes");
  for (const raw of ["{", "[]", JSON.stringify({ mode: "open", at: "2026-09-16T17:45:00Z" }), JSON.stringify({ mode: "normal" })]) assert.equal(parseEventPolicy(raw), null);
  // A stale REDUCED policy does not halve anything — it refuses instead.
  const staleReduced = eventContextOf(JSON.stringify({ mode: "reduced", at: new Date(now - 25 * 60_000).toISOString() }), now);
  assert.equal(staleReduced.budgetMult, 1);
  assert.equal(entryRefusal(es, { ...okCtx, eventMode: "reduced", eventPolicyAgeMs: staleReduced.ageMs }, DEFAULT_LIMITS), "event calendar not checked in the last 20 minutes");
  // Round trip through the key.
  assert.deepEqual(parseEventPolicy(pausedRaw), JSON.parse(pausedRaw));
});

test("health reads the policy: mode, when, fresh; and the entry clock on a holiday", () => {
  const at = Date.parse("2026-09-16T17:45:00Z");
  const h = futuresHealth({ futures_desk_event_policy: JSON.stringify(deskEventPolicy(new Date(at - 60_000), fomc)) }, at).desk;
  assert.equal(h.eventMode, "paused"); assert.equal(h.eventPolicyAt, "2026-09-16T17:44:00.000Z"); assert.equal(h.eventPolicyFresh, true); assert.equal(h.cmeOpenForEntry, true);
  const none = futuresHealth({}, at).desk;
  assert.equal(none.eventMode, null); assert.equal(none.eventPolicyFresh, false);
  assert.equal(futuresHealth({}, Date.parse("2026-12-25T15:00:00Z")).desk.cmeOpenForEntry, false);
});

// ---- the roll window --------------------------------------------------------------------------------
test("rollWindowRefusal: Sep 17 12:00 ET against a Sep 18 09:30 ET expiry refuses with the one string; Sep 15 does not", () => {
  const exp = "2026-09-18T13:30:00Z";
  assert.equal(rollWindowRefusal("MESU6", exp, new Date("2026-09-17T16:00:00Z"), 3), "MESU6 expires in 1 day — inside the roll window; entry refused");
  assert.equal(rollWindowRefusal("MESU6", exp, new Date("2026-09-16T16:00:00Z"), 3), "MESU6 expires in 2 days — inside the roll window; entry refused");
  assert.equal(rollWindowRefusal("MESU6", exp, new Date("2026-09-15T16:00:00Z"), 3), null);
  assert.equal(rollWindowRefusal("MESU6", null, new Date("2026-09-17T16:00:00Z"), 3), null);
  assert.equal(rollWindowRefusal("MGCZ6", "2026-11-27T14:30:00Z", new Date("2026-11-10T16:00:00Z"), 21), "MGCZ6 expires in 17 days — inside the roll window; entry refused");
});
