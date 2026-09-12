import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LIMITS, cmeOpen, dedupeKey, deskVerdict, entryRefusal, etDayKey, parseAlert, roundToTick, sizeEntry, tStatOf, tradePnlUsd,
  type AlertPayload, type DeskContext,
} from "../src/lib/futures-desk-rules";

const good = { secret: "x", desk: "futures", edge: "index_daily_mr", symbol: "ES", action: "entry", side: "long", price: 6500, stop: 6440, bar: "2026-09-14T21:00:00Z", tf: "1D" };
const okCtx: DeskContext = { enabled: true, openRoots: [], entriesToday: 0, dayPnlUsd: 0, equityUsd: 50_000, equityHighUsd: 50_000, guardianFreshMs: 60_000 };

test("parseAlert accepts the documented shape and normalises the bar", () => {
  const p = parseAlert(good);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.equal(p.alert.root, "ES");
  assert.equal(p.alert.bar, "2026-09-14T21:00:00.000Z");
  assert.equal(p.alert.stop, 6440);
});

test("parseAlert accepts TradingView's {{time}} as epoch milliseconds and as a numeric string", () => {
  const a = parseAlert({ ...good, bar: 1789420800000 });
  const b = parseAlert({ ...good, bar: "1789420800000" });
  assert.equal(a.ok && a.alert.bar, new Date(1789420800000).toISOString());
  assert.equal(b.ok && b.alert.bar, new Date(1789420800000).toISOString());
});

test("parseAlert refuses unknown edges, wrong markets, missing stops and stops on the wrong side", () => {
  assert.equal(parseAlert({ ...good, edge: "gold_rsi" }).ok, false);
  assert.equal(parseAlert({ ...good, symbol: "CL" }).ok, false);
  assert.equal(parseAlert({ ...good, stop: undefined }).ok, false);
  assert.equal(parseAlert({ ...good, stop: 6600 }).ok, false);
  assert.equal(parseAlert({ ...good, side: "short" }).ok, false);
  assert.equal(parseAlert({ ...good, desk: "crypto" }).ok, false);
  assert.equal(parseAlert({ ...good, action: "buy" }).ok, false);
});

test("an exit needs no stop; the same bar dedupes; a different bar does not", () => {
  const x = parseAlert({ ...good, action: "exit", stop: undefined });
  assert.equal(x.ok, true);
  const a = parseAlert(good), b = parseAlert({ ...good, price: 6501 }), c = parseAlert({ ...good, bar: "2026-09-15T21:00:00Z" });
  assert.ok(a.ok && b.ok && c.ok);
  if (a.ok && b.ok && c.ok) {
    assert.equal(dedupeKey(a.alert), dedupeKey(b.alert));
    assert.notEqual(dedupeKey(a.alert), dedupeKey(c.alert));
  }
});

test("sizing: 3% of $50k on MES with a 60-point stop = 4 micros; risk never exceeds the budget", () => {
  const p = parseAlert(good);
  assert.ok(p.ok);
  if (!p.ok) return;
  const s = sizeEntry(p.alert, DEFAULT_LIMITS);
  assert.equal(s.ok, true);
  assert.equal(s.micro, "MES");
  assert.equal(s.contracts, 4);                    // 1500 / (60*5 + 1.7) = 4.97 → 4
  assert.ok(s.riskUsd <= s.riskBudgetUsd);
});

test("sizing refuses below one contract and caps at the maximum", () => {
  const wide = parseAlert({ ...good, symbol: "NQ", price: 24000, stop: 23000 });   // 1000 pts × $2 = $2,000 > $1,500
  assert.ok(wide.ok);
  if (wide.ok) { const s = sizeEntry(wide.alert, DEFAULT_LIMITS); assert.equal(s.ok, false); assert.match(s.reason, /budget/); }
  const tight = parseAlert({ ...good, price: 6500, stop: 6499 });
  assert.ok(tight.ok);
  if (tight.ok) { const s = sizeEntry(tight.alert, DEFAULT_LIMITS); assert.equal(s.contracts, DEFAULT_LIMITS.maxContracts); }
});

test("roundToTick lands on the contract grid", () => {
  assert.equal(roundToTick(6440.13, 0.25), 6440.25);
  assert.equal(roundToTick(2431.07, 0.1), 2431.1);
  assert.equal(roundToTick(4.55017, 0.0005), 4.55);
});

test("entryRefusal: the container refuses in the right order", () => {
  const p = parseAlert(good); assert.ok(p.ok); if (!p.ok) return;
  const a: AlertPayload = p.alert;
  assert.equal(entryRefusal(a, okCtx, DEFAULT_LIMITS), null);
  assert.match(entryRefusal(a, { ...okCtx, enabled: false }, DEFAULT_LIMITS)!, /disabled/);
  assert.match(entryRefusal(a, { ...okCtx, guardianFreshMs: null }, DEFAULT_LIMITS)!, /guardian/);
  assert.match(entryRefusal(a, { ...okCtx, openRoots: ["ES"] }, DEFAULT_LIMITS)!, /already holding/);
  assert.match(entryRefusal(a, { ...okCtx, openRoots: ["NQ", "YM", "GC", "SI", "HG", "RTY"] }, DEFAULT_LIMITS)!, /positions already open/);
  assert.match(entryRefusal(a, { ...okCtx, entriesToday: 4 }, DEFAULT_LIMITS)!, /entries already today/);
  assert.match(entryRefusal(a, { ...okCtx, dayPnlUsd: -3000 }, DEFAULT_LIMITS)!, /paused/);
  assert.match(entryRefusal(a, { ...okCtx, equityUsd: 39_000 }, DEFAULT_LIMITS)!, /off its high/);
});

test("CME hours: closed Saturday, closed in the 17:00–18:00 ET break, open Sunday evening", () => {
  assert.equal(cmeOpen(new Date("2026-09-12T15:00:00Z")), false);         // Saturday
  assert.equal(cmeOpen(new Date("2026-09-14T21:30:00Z")), false);         // Monday 17:30 ET
  assert.equal(cmeOpen(new Date("2026-09-14T22:05:00Z")), true);          // Monday 18:05 ET
  assert.equal(cmeOpen(new Date("2026-09-13T23:00:00Z")), true);          // Sunday 19:00 ET
  assert.equal(cmeOpen(new Date("2026-09-18T21:30:00Z")), false);         // Friday 17:30 ET
  assert.equal(etDayKey(new Date("2026-09-14T03:00:00Z")), "2026-09-13"); // 23:00 ET the day before
});

test("P&L uses the micro point value and charges both sides", () => {
  assert.equal(tradePnlUsd("long", 6500, 6520, 2, 5), 20 * 5 * 2 - 4 * 0.85);
  assert.equal(tradePnlUsd("short", 6500, 6520, 1, 5), -100 - 1.7);
});

test("verdict wording matches the other desks", () => {
  assert.match(deskVerdict(0, 0, null, 0), /NO DATA/);
  assert.match(deskVerdict(12, 500, 2.5, 20), /TOO EARLY/);
  assert.match(deskVerdict(31, -5, 2.5, 20), /NO EDGE/);
  assert.match(deskVerdict(31, 500, 2.5, 20), /REAL EDGE/);
  assert.match(deskVerdict(31, 500, 1.2, 20), /PROMISING/);
  assert.equal(tStatOf([1, 1, 1]), null);
  assert.ok((tStatOf([1, 2, 3, 4]) ?? 0) > 3);
});
