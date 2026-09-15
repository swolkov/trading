import assert from "node:assert/strict";
import test from "node:test";
import { MACRO_EVENTS, etOffsetHours, eventUtcMs, macroEventWindows } from "../src/lib/macro-events";
import { eventPolicyNow, familyOf, mergeCalendar, normalizeFinnhub, staticCalendar, tierOf, type CalendarEvent } from "../src/lib/event-calendar";
import { EVENT_POLICY_MAX_AGE_MS, eventRiskMultiplier, resolveEventPolicy } from "../src/lib/margin-events";

const T = (iso: string) => Date.parse(iso);
const FOMC = T("2026-09-16T18:00:00Z");   // 14:00 ET under EDT

// ---- static table ----

test("ET → UTC: EDT (−4) through Oct 31 2026, EST (−5) from Nov 1; the rule, not a pinned year", () => {
  assert.equal(etOffsetHours("2026-10-31"), 4);
  assert.equal(etOffsetHours("2026-11-01"), 5);
  assert.equal(etOffsetHours("2026-03-07"), 5);
  assert.equal(etOffsetHours("2026-03-08"), 4);
  assert.equal(etOffsetHours("2027-03-13"), 5);
  assert.equal(etOffsetHours("2027-03-14"), 4);
  assert.equal(etOffsetHours("2027-11-07"), 5);
  assert.equal(eventUtcMs({ date: "2026-09-16", time: "14:00 ET" }), FOMC);
  assert.equal(eventUtcMs({ date: "2026-10-28", time: "14:00 ET" }), T("2026-10-28T18:00:00Z"));
  assert.equal(eventUtcMs({ date: "2026-12-09", time: "14:00 ET" }), T("2026-12-09T19:00:00Z"), "December FOMC is 19:00Z under EST");
  assert.equal(eventUtcMs({ date: "2026-12-10", time: "08:30 ET" }), T("2026-12-10T13:30:00Z"));
  assert.ok(Number.isNaN(eventUtcMs({ date: "2026-12-10", time: "tbd" })));
});

test("the static table carries NFP, PPI and the FOMC minutes with tiers, and macroEventWindows still works", () => {
  const names = MACRO_EVENTS.map((e) => `${e.date} ${e.name}`);
  for (const d of ["2026-10-02", "2026-11-06", "2026-12-04"]) assert.ok(names.some((n) => n.startsWith(d) && /Nonfarm/.test(n)), `NFP ${d}`);
  for (const d of ["2026-10-14", "2026-11-13", "2026-12-11"]) assert.ok(names.some((n) => n.startsWith(d) && /PPI/.test(n)), `PPI ${d}`);
  for (const d of ["2026-10-07", "2026-11-18", "2026-12-30"]) assert.ok(names.some((n) => n.startsWith(d) && /minutes/.test(n)), `minutes ${d}`);
  for (const e of MACRO_EVENTS) {
    assert.equal(e.approx, true);
    assert.equal(e.tier, /minutes|PPI|PCE/i.test(e.name) ? 2 : 1, e.name);
    assert.equal(tierOf(familyOf(e.name)!), e.tier, e.name);
  }
  const { upcoming, imminent } = macroEventWindows(new Date("2026-09-15T12:00:00Z"));
  assert.ok(upcoming.some((e) => e.name === "FOMC rate decision" && e.date === "2026-09-16"));
  assert.ok(imminent.some((e) => e.date === "2026-09-16"));
  assert.equal(staticCalendar().length, MACRO_EVENTS.length, "every static event parses to an instant");
});

// ---- policy clocks around the Sep 16 FOMC (static only) ----

test("fixed clocks around the 2026-09-16 18:00Z FOMC: paused ±30 min, reduced −12h..+2h, normal two days out", () => {
  const events = staticCalendar();
  const at = (iso: string) => eventPolicyNow(T(iso), events);
  assert.equal(at("2026-09-16T17:45:00Z").mode, "paused");
  assert.equal(at("2026-09-16T17:30:00Z").mode, "paused", "exactly 30 min before is paused");
  assert.equal(at("2026-09-16T18:25:00Z").mode, "paused");
  assert.equal(at("2026-09-16T18:30:00Z").mode, "paused", "exactly 30 min after is paused");
  assert.equal(at("2026-09-16T18:31:00Z").mode, "reduced");
  assert.equal(at("2026-09-16T19:59:00Z").mode, "reduced");
  assert.equal(at("2026-09-16T20:01:00Z").mode, "normal", "2h after the print is clear");
  assert.equal(at("2026-09-16T06:00:00Z").mode, "reduced", "12h before");
  assert.equal(at("2026-09-16T05:59:00Z").mode, "normal");
  assert.equal(at("2026-09-14T18:00:00Z").mode, "normal", "two days prior");
  const p = at("2026-09-16T17:45:00Z");
  assert.match(p.reason, /FOMC rate decision at 18:00Z \(in 15 min\)/);
  assert.equal(p.nextEvent?.name, "FOMC rate decision");
  assert.equal(p.nextEvent?.source, "static");
  assert.equal(p.at, "2026-09-16T17:45:00.000Z");
  assert.match(at("2026-09-14T18:00:00Z").reason, /next: FOMC rate decision 2026-09-16 18:00Z/);
});

test("a tier-2 print only REDUCES, and only within ±30 min", () => {
  const ppi = staticCalendar().filter((e) => e.family === "ppi");   // 2026-10-14 08:30 ET = 12:30Z
  const at = (iso: string) => eventPolicyNow(T(iso), ppi);
  assert.equal(at("2026-10-14T12:20:00Z").mode, "reduced");
  assert.equal(at("2026-10-14T12:30:00Z").mode, "reduced");
  assert.equal(at("2026-10-14T12:59:00Z").mode, "reduced");
  assert.equal(at("2026-10-14T13:01:00Z").mode, "normal");
  assert.equal(at("2026-10-14T11:00:00Z").mode, "normal", "no 12h lead for tier 2");
  assert.match(at("2026-10-14T12:20:00Z").reason, /tier 2 within ±30 min/);
  // The minutes are tier 2 too — a name with both "FOMC" and "Minutes" must not read as tier 1.
  assert.equal(familyOf("FOMC Minutes"), "minutes");
  assert.equal(familyOf("FOMC rate decision"), "fomc");
  assert.equal(familyOf("Fed Interest Rate Decision"), "fomc");
  assert.equal(familyOf("Nonfarm Payrolls"), "nfp");
  assert.equal(familyOf("Retail Sales"), null);
  assert.equal(eventPolicyNow(T("2026-09-16T18:00:00Z"), []).mode, "normal");
  assert.equal(eventPolicyNow(T("2026-09-16T18:00:00Z"), []).nextEvent, null);
});

// ---- Finnhub normalisation + merge ----

test("normalizeFinnhub keeps US high-impact prints that match the regex; time is parsed as UTC", () => {
  const rows = [
    { country: "US", event: "FOMC Interest Rate Decision", time: "2026-09-16 18:30:00", impact: "high", actual: null, estimate: null, prev: null, unit: "%" },
    { country: "US", event: "CPI m/m", time: "2026-10-13 12:30:00", impact: "high", actual: null, estimate: null, prev: null, unit: "%" },
    { country: "US", event: "Retail Sales", time: "2026-10-15 12:30:00", impact: "high", actual: null, estimate: null, prev: null, unit: "%" },   // not in the regex
    { country: "US", event: "PPI m/m", time: "2026-10-14 12:30:00", impact: "medium", actual: null, estimate: null, prev: null, unit: "%" },     // not high
    { country: "DE", event: "CPI", time: "2026-10-13 06:00:00", impact: "high", actual: null, estimate: null, prev: null, unit: "%" },           // not US
    { country: "US", event: "PCE Price Index", time: "garbage", impact: "high", actual: null, estimate: null, prev: null, unit: "%" },           // unparseable
  ];
  const out = normalizeFinnhub(rows);
  assert.deepEqual(out.map((e) => [e.family, e.tier, e.source, new Date(e.atMs).toISOString()]), [
    ["fomc", 1, "finnhub", "2026-09-16T18:30:00.000Z"],
    ["cpi", 1, "finnhub", "2026-10-13T12:30:00.000Z"],
  ]);
  assert.deepEqual(normalizeFinnhub([]), []);
  assert.deepEqual(normalizeFinnhub(undefined as unknown as []), []);
});

test("mergeCalendar: Finnhub wins on time, the static table survives an outage, sources are labelled, the past is dropped", () => {
  const now = T("2026-09-15T12:00:00Z");
  const statics = staticCalendar();
  // Outage: nothing from Finnhub → the FOMC is still there, from the static table.
  const outage = mergeCalendar([], statics, now);
  const fomc = outage.find((e) => e.family === "fomc" && e.atMs === FOMC);
  assert.ok(fomc && fomc.source === "static");
  assert.equal(eventPolicyNow(T("2026-09-16T17:50:00Z"), outage).mode, "paused", "static alone still pauses the FOMC");
  // Finnhub says 18:30Z for the same event → its time wins and the source says both spoke.
  const fh = normalizeFinnhub([{ country: "US", event: "FOMC Interest Rate Decision", time: "2026-09-16 18:30:00", impact: "high" }]);
  const merged = mergeCalendar(fh, statics, now);
  const fomcs = merged.filter((e) => e.family === "fomc" && new Date(e.atMs).toISOString().startsWith("2026-09-16"));
  assert.equal(fomcs.length, 1, "deduped by date + family");
  assert.equal(fomcs[0].atMs, T("2026-09-16T18:30:00Z"));
  assert.equal(fomcs[0].source, "finnhub+static");
  assert.equal(fomcs[0].approx, false);
  assert.equal(eventPolicyNow(T("2026-09-16T17:50:00Z"), merged).mode, "reduced", "40 min before the corrected time is reduced, not paused");
  assert.equal(eventPolicyNow(T("2026-09-16T18:05:00Z"), merged).mode, "paused");
  // A Finnhub-only event carries its own label; a print more than 24h old is gone.
  const extra = normalizeFinnhub([{ country: "US", event: "PCE Price Index", time: "2026-09-25 12:30:00", impact: "high" }]);
  const withExtra = mergeCalendar(extra, statics, now);
  assert.equal(withExtra.find((e) => e.family === "pce")?.source, "finnhub");
  assert.ok(!withExtra.some((e) => e.atMs < now - 24 * 3600_000), "Sep 11 CPI is dropped");
  for (let i = 1; i < withExtra.length; i++) assert.ok(withExtra[i].atMs >= withExtra[i - 1].atMs, "sorted");
});

// ---- the executor's read ----

test("resolveEventPolicy: stale/missing/unparseable → reduced; fresh → as written; the off switch → normal", () => {
  const now = T("2026-09-16T12:00:00Z");
  const fresh = JSON.stringify({ mode: "paused", reason: "FOMC", nextEvent: null, at: new Date(now - 5 * 60_000).toISOString() });
  assert.equal(resolveEventPolicy(fresh, null, now).mode, "paused");
  assert.equal(resolveEventPolicy(fresh, null, now).stale, false);
  assert.equal(resolveEventPolicy(null, null, now).mode, "reduced");
  assert.match(resolveEventPolicy(null, null, now).reason, /policy stale\/missing/);
  assert.equal(resolveEventPolicy("", null, now).mode, "reduced");
  assert.equal(resolveEventPolicy("{not json", null, now).mode, "reduced");
  assert.equal(resolveEventPolicy(JSON.stringify({ mode: "open", at: new Date(now).toISOString() }), null, now).mode, "reduced", "an unknown mode is not trusted");
  const stale = JSON.stringify({ mode: "normal", reason: "clear", nextEvent: null, at: new Date(now - EVENT_POLICY_MAX_AGE_MS - 1).toISOString() });
  assert.equal(resolveEventPolicy(stale, null, now).mode, "reduced", "a normal policy older than 20 min reads as reduced");
  assert.equal(resolveEventPolicy(stale, null, now).stale, true);
  const edge = JSON.stringify({ mode: "normal", reason: "clear", nextEvent: null, at: new Date(now - EVENT_POLICY_MAX_AGE_MS).toISOString() });
  assert.equal(resolveEventPolicy(edge, null, now).mode, "normal", "exactly 20 min old is still fresh");
  // The operator's off switch beats everything, including a paused window.
  assert.equal(resolveEventPolicy(fresh, "false", now).mode, "normal");
  assert.equal(resolveEventPolicy(null, "false", now).mode, "normal");
  assert.equal(resolveEventPolicy(fresh, "true", now).mode, "paused", "only the literal \"false\" switches it off");
});

test("eventRiskMultiplier: normal 1, reduced 0.5, paused 0", () => {
  assert.equal(eventRiskMultiplier("normal"), 1);
  assert.equal(eventRiskMultiplier("reduced"), 0.5);
  assert.equal(eventRiskMultiplier("paused"), 0);
});

test("a paused policy sizes nothing through the chain; reduced halves the A+ rung", async () => {
  const { liveRiskPctChain } = await import("../src/lib/margin-risk-tiers");
  assert.equal(liveRiskPctChain({ basePct: 4, conviction: "high", ddMult: 1, eventMult: eventRiskMultiplier("paused"), decayMult: 1 }), 0);
  assert.equal(liveRiskPctChain({ basePct: 4, conviction: "high", ddMult: 1, eventMult: eventRiskMultiplier("reduced"), decayMult: 1 }), 4);
  assert.equal(liveRiskPctChain({ basePct: 4, conviction: "high", ddMult: 0.5, eventMult: eventRiskMultiplier("reduced"), decayMult: 1 }), 2);
});

test("policy over a merged calendar is deterministic for the same clock", () => {
  const events: CalendarEvent[] = mergeCalendar([], staticCalendar(), T("2026-09-15T00:00:00Z"));
  const a = eventPolicyNow(FOMC - 10 * 60_000, events);
  const b = eventPolicyNow(FOMC - 10 * 60_000, events);
  assert.deepEqual(a, b);
});
