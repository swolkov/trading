import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, dedupeKey, parseAlert, type AlertPayload } from "../src/lib/futures-desk-rules";
import {
  SLIP_PTS_PER_SIDE, WATCH_CAP_PER_ROOT_PER_DAY, YAHOO_FOR_ROOT, classifyError, entrySlipPts, excursionJobDue, pnlAfterSlip, sessionOf, slipModelUsd, slipPtsPerSide, toR,
  updateExcursion, watchCapReached, watchCard,
} from "../src/lib/futures-desk-journal";

const v1 = { secret: "x", desk: "futures", edge: "index_daily_mr", symbol: "ES", action: "entry", side: "long", price: 6500, stop: 6440, bar: "2026-09-14T21:00:00Z", tf: "1D" };
const v2 = { ...v1, atr: 40.25, rsi: 28.1, volRatio: 1.35, dist20h: -0.042, d1Up: true, h4Up: false };
function alertOf(body: Record<string, unknown>): AlertPayload { const p = parseAlert(body); if (!p.ok) throw new Error(p.reason); return p.alert; }

test("entry slip is signed from the trader's side: a long filled above the signal PAID, a short filled above was PAID TO", () => {
  assert.equal(entrySlipPts("long", 6500, 6501.25), 1.25);
  assert.equal(entrySlipPts("long", 6500, 6499), -1);
  assert.equal(entrySlipPts("short", 6500, 6498.75), 1.25);
  assert.equal(entrySlipPts("short", 6500, 6501), -1);
});

test("the slippage model: MNQ 1-lot round trip = $46.96; ES/NQ/GC measured, the rest labelled assumed; unknown root = 0", () => {
  assert.equal(slipModelUsd("NQ", 1, 2), 46.96);
  assert.equal(slipModelUsd("ES", 2, 5), 17.8);
  assert.equal(slipModelUsd("CL", 1, 100), 0);
  assert.equal(slipPtsPerSide("GC"), 0.5);
  for (const r of ["ES", "NQ", "GC"]) assert.equal(SLIP_PTS_PER_SIDE[r].source, "measured");
  for (const r of ["YM", "SI", "HG", "RTY"]) assert.equal(SLIP_PTS_PER_SIDE[r].source, "assumed");
  assert.equal(pnlAfterSlip(100, 46.96), 53.04);
  assert.equal(pnlAfterSlip(-30, 17.8), -47.8);
});

test("excursions on a fixture series, long: MFE from the highs, MAE from the lows, running across two folds", () => {
  const bars = [{ h: 6510, l: 6490 }, { h: 6530, l: 6495 }, { h: 6520, l: 6470 }];
  const first = updateExcursion(null, "long", 6500, bars.slice(0, 2));
  assert.deepEqual(first, { mfePts: 30, maePts: 10, bars: 2 });
  const second = updateExcursion(first, "long", 6500, bars.slice(2));
  assert.deepEqual(second, { mfePts: 30, maePts: 30, bars: 3 });
  assert.deepEqual(updateExcursion(null, "long", 6500, []), { mfePts: 0, maePts: 0, bars: 0 });
  assert.deepEqual(updateExcursion(null, "long", 6500, [{ h: 6499, l: 6480 }]), { mfePts: 0, maePts: 20, bars: 1 });   // never went green
});

test("excursions, short: favourable is DOWN", () => {
  const bars = [{ h: 6510, l: 6490 }, { h: 6530, l: 6495 }, { h: 6520, l: 6470 }];
  assert.deepEqual(updateExcursion(null, "short", 6500, bars), { mfePts: 30, maePts: 30, bars: 3 });
  assert.deepEqual(updateExcursion(null, "short", 6500, bars.slice(0, 1)), { mfePts: 10, maePts: 10, bars: 1 });
});

test("R math: points over the initial stop distance; unknown or zero stop → null", () => {
  assert.equal(toR(30, 60), 0.5);
  assert.equal(toR(-15, 60), -0.25);
  assert.equal(toR(30, 0), null); assert.equal(toR(30, null), null); assert.equal(toR(null, 60), null); assert.equal(toR(NaN, 60), null);
});

test("classifyError: the stamped class wins; legacy rows classify from their text; clean rows are null", () => {
  assert.equal(classifyError({ error_class: "roll_failed", note: "partial fill 1/2" }), "roll_failed");
  assert.equal(classifyError({ error_class: "bogus", note: "partial fill 1/2" }), "partial_fill");
  assert.equal(classifyError({ note: "partial fill 1/2" }), "partial_fill");
  assert.equal(classifyError({ exit_reason: "unprotected" }), "unprotected");
  assert.equal(classifyError({ reason: "filled 1× MESZ6 but could not be protected — closed" }), "unprotected");
  assert.equal(classifyError({ note: "roll MESU6 → MESZ6 FAILED to re-open: timeout" }), "roll_failed");
  assert.equal(classifyError({ reason: "close refused (MESZ6: stop still working after cancel) — the guardian retries" }), "close_refused");
  assert.equal(classifyError({ reason: "queued for more than 12h" }), "queue_expired");
  assert.equal(classifyError({ reason: "watch older than 24h" }), "queue_expired");
  assert.equal(classifyError({ reason: "auth: p-ticket backoff until 22:00" }), "auth_backoff");
  assert.equal(classifyError({ reason: "the demo holds contract #123 that the desk did not open" }), "foreign_position");
  assert.equal(classifyError({ note: "rolled from MESU6", exit_reason: "stop" }), null);
  assert.equal(classifyError({}), null);
});

test("sessionOf at each ET boundary (EDT: ET = UTC − 4)", () => {
  const at = (utc: string) => sessionOf(new Date(utc));
  assert.equal(at("2026-09-15T21:59:00Z"), "break");        // 17:59 ET — inside the CME pause
  assert.equal(at("2026-09-15T22:00:00Z"), "overnight");    // 18:00
  assert.equal(at("2026-09-16T05:59:00Z"), "overnight");    // 01:59
  assert.equal(at("2026-09-16T06:00:00Z"), "european");     // 02:00
  assert.equal(at("2026-09-16T10:59:00Z"), "european");     // 06:59
  assert.equal(at("2026-09-16T11:00:00Z"), "premarket");    // 07:00
  assert.equal(at("2026-09-16T13:29:00Z"), "premarket");    // 09:29
  assert.equal(at("2026-09-16T13:30:00Z"), "open");         // 09:30
  assert.equal(at("2026-09-16T13:59:00Z"), "open");         // 09:59
  assert.equal(at("2026-09-16T14:00:00Z"), "morning");      // 10:00
  assert.equal(at("2026-09-16T15:29:00Z"), "morning");      // 11:29
  assert.equal(at("2026-09-16T15:30:00Z"), "midday");       // 11:30
  assert.equal(at("2026-09-16T17:59:00Z"), "midday");       // 13:59
  assert.equal(at("2026-09-16T18:00:00Z"), "power");        // 14:00
  assert.equal(at("2026-09-16T19:29:00Z"), "power");        // 15:29
  assert.equal(at("2026-09-16T19:30:00Z"), "close");        // 15:30
  assert.equal(at("2026-09-16T20:59:00Z"), "close");        // 16:59
  assert.equal(at("2026-09-16T21:00:00Z"), "break");        // 17:00
});

test("the MFE/MAE fold is due once per ET day, from 17:05 ET", () => {
  assert.equal(excursionJobDue(undefined, new Date("2026-09-16T21:04:00Z")), false);   // 17:04 ET
  assert.equal(excursionJobDue(undefined, new Date("2026-09-16T21:05:00Z")), true);    // 17:05 ET
  assert.equal(excursionJobDue("2026-09-16", new Date("2026-09-16T21:05:00Z")), false); // already folded today
  assert.equal(excursionJobDue("2026-09-15", new Date("2026-09-16T23:30:00Z")), true);  // yesterday's key, 19:30 ET
  assert.equal(excursionJobDue("2026-09-15", new Date("2026-09-16T14:00:00Z")), false); // 10:00 ET — bars not complete
  assert.equal(YAHOO_FOR_ROOT.ES, "ES=F"); assert.equal(YAHOO_FOR_ROOT.HG, "HG=F");
});

test("parseAlert: a v1 payload (no new fields) parses exactly as before", () => {
  const a = alertOf(v1);
  assert.deepEqual(a, { edge: "index_daily_mr", root: "ES", action: "entry", side: "long", price: 6500, stop: 6440, bar: "2026-09-14T21:00:00.000Z", timeframe: "1D", note: "" });
  assert.equal("atr" in a, false); assert.equal("d1Up" in a, false);
});

test("parseAlert: v2 optional fields ride along typed; booleans accept true/false, 'true'/'false', 1/0; null fields are absent", () => {
  const a = alertOf(v2);
  assert.equal(a.atr, 40.25); assert.equal(a.rsi, 28.1); assert.equal(a.volRatio, 1.35); assert.equal(a.dist20h, -0.042); assert.equal(a.d1Up, true); assert.equal(a.h4Up, false);
  const b = alertOf({ ...v1, d1Up: "true", h4Up: 0, atr: "12.5", rsi: null, volRatio: "NaN" });
  assert.equal(b.d1Up, true); assert.equal(b.h4Up, false); assert.equal(b.atr, 12.5); assert.equal("rsi" in b, false); assert.equal("volRatio" in b, false);
  assert.equal(dedupeKey(alertOf(v1)), dedupeKey(alertOf(v2)));   // context never changes the event's identity
});

test("parseAlert: watch is a third action; its projected stop is checked like an entry's, and it may omit the stop", () => {
  const w = alertOf({ ...v2, action: "watch", stop: 6455 });
  assert.equal(w.action, "watch"); assert.equal(w.stop, 6455);
  assert.notEqual(dedupeKey(w), dedupeKey(alertOf(v2)));   // an entry on the same bar is a different event
  assert.equal(alertOf({ ...v1, action: "watch", stop: undefined }).stop, null);
  assert.equal(parseAlert({ ...v1, action: "watch", stop: 6600 }).ok, false);
  assert.equal(parseAlert({ ...v1, action: "hold" }).ok, false);
  assert.equal(parseAlert({ ...v1, action: "entry", stop: undefined }).ok, false);
});

test("the watch card sizes the alert on paper and never places anything; the cap is three per root per day", () => {
  const opts = { grade: "normal" as const, stage: "A" as const, budgetMult: 1 };
  assert.equal(watchCard(alertOf({ ...v1, action: "watch", stop: 6460 }), DEFAULT_LIMITS, opts), "dry run: 1× MES · stop 40 pts · risk $201.70 of $250 (normal · stage A)");
  assert.equal(watchCard(alertOf({ ...v1, action: "watch" }), DEFAULT_LIMITS, opts), "dry run: one MES risks $301.70 against a $250 budget (normal · stage A) — refused, never stretched");
  assert.equal(watchCard(alertOf({ ...v1, action: "watch", stop: undefined }), DEFAULT_LIMITS, opts), "dry run: no stop on the watch alert — unsized");
  assert.equal(WATCH_CAP_PER_ROOT_PER_DAY, 3);
  assert.equal(watchCapReached(2), false); assert.equal(watchCapReached(3), true); assert.equal(watchCapReached(7), true);
});
