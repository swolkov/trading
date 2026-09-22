import assert from "node:assert/strict";
import test from "node:test";
import { parseSetup, recapText, resolveOutcome, setupCostShare, setupText, type Setup } from "../src/lib/setup-feed-rules";
import type { Bar } from "../src/lib/trading-room-rules";

// Wed Sep 23 2026, 10:00 ET = 14:00Z (EDT). The setup's 5-minute bar opened 10:00 and closed 10:05.
const BAR = Date.parse("2026-09-23T14:00:00Z");
const body = (o: Record<string, unknown> = {}) => ({ secret: "x", room: "trading", kind: "setup", symbol: "MES", side: "long", price: 7835.25, stop: 7831.75, orh: 7830, orl: 7820, vwap: 7828, bar: BAR, tf: "5", ...o });
const setup = (o: Partial<Setup> = {}): Setup => ({ ...(parseSetup(body()) as { ok: true; setup: Setup }).setup, ...o });
/** 1-minute bars from 10:05 ET: each [o, h, l, c]. */
function bars(rows: [number, number, number, number][], startMs = BAR + 5 * 60_000): Bar[] {
  return rows.map(([o, h, l, c], i) => ({ t: startMs + i * 60_000, o, h, l, c, v: 100 }));
}

test("parse: a good setup, the id is the chart's bar, ES maps to MES", () => {
  const p = parseSetup(body({ symbol: "ES" }));
  assert.ok(p.ok);
  if (p.ok) { assert.equal(p.setup.symbol, "MES"); assert.equal(p.setup.side, 1); assert.equal(p.setup.id, "MES|L|2026-09-23T14:00:00.000Z"); }
});

test("parse refuses: stop on the wrong side, unknown symbol, missing bar, bad side", () => {
  assert.equal(parseSetup(body({ stop: 7836 })).ok, false);
  assert.equal(parseSetup(body({ symbol: "CL" })).ok, false);
  assert.equal(parseSetup(body({ bar: null })).ok, false);
  assert.equal(parseSetup(body({ side: "up" })).ok, false);
  assert.equal(parseSetup(body({ side: "short" })).ok, false);            // short with a stop below price
  assert.equal(parseSetup(body({ side: "short", stop: 7838.75 })).ok, true);
});

test("the Slack line: stop, $ risk at 20, +2R, cost share on a tight stop, and that it is not a call", () => {
  const t = setupText(setup());
  assert.match(t, /MES higher low above VWAP after an opening-range break · 10:05 ET close 7835\.25/);
  assert.match(t, /stop 7831\.75 \(3\.50 pts\) → 20 MES risk \$350 · \+2R 7842\.25 · fees\+slip 26% of the stop/);
  assert.match(t, /not a call/);
  assert.equal(Math.round(setupCostShare("MNQ", 20) * 100), 8);
});

test("outcome: target through, entry one tick worse at the next minute's open", () => {
  // fill 7835.50 (open 7835.25 + 1 tick), risk 3.75 → target 7843.00
  const o = resolveOutcome(setup(), bars([[7835.25, 7837, 7834, 7836], [7836, 7843.25, 7835.5, 7843]]), BAR + 60 * 60_000);
  assert.equal(o.status, "done"); assert.equal(o.how, "target");
  assert.equal(Math.round(o.usd!), Math.round(7.5 * 5 * 20 - 2.06 * 20));
});

test("outcome: a bar touching both stop and target is the stop; stop fills one tick worse", () => {
  const o = resolveOutcome(setup(), bars([[7835.25, 7844, 7831, 7832]]), BAR + 60 * 60_000);
  assert.equal(o.how, "stop");
  assert.equal(Math.round(o.usd!), Math.round((7831.5 - 7835.5) * 5 * 20 - 2.06 * 20));
});

test("outcome: a target touched but not traded through does not fill", () => {
  const o = resolveOutcome(setup(), bars([[7835.25, 7843, 7834, 7842]]), BAR + 20 * 60_000);
  assert.equal(o.status, "open");
});

test("outcome: still running mid-session is open; after the session it goes flat at the last bar", () => {
  const b = bars([[7835.25, 7837, 7834, 7836], [7836, 7838, 7835, 7837]]);
  assert.equal(resolveOutcome(setup(), b, BAR + 30 * 60_000).status, "open");
  const after = resolveOutcome(setup(), b, Date.parse("2026-09-23T20:30:00Z"));
  assert.equal(after.how, "flat");
});

test("outcome: no bars at all is 'open' early and 'no-data' after 3 hours", () => {
  assert.equal(resolveOutcome(setup(), [], BAR + 30 * 60_000).status, "open");
  assert.equal(resolveOutcome(setup(), [], BAR + 4 * 3_600_000).status, "no-data");
});

test("outcome: short mirror", () => {
  const s = setup({ side: -1, price: 7835.25, stop: 7838.75 });
  // fill 7835.00, risk 3.75 → target 7827.50
  const o = resolveOutcome(s, bars([[7835.25, 7836, 7830, 7831], [7831, 7832, 7827.25, 7828]]), BAR + 60 * 60_000);
  assert.equal(o.how, "target");
});

test("recap: counts, the bracket's result, and what he took", () => {
  const t = recapText("2026-09-23", [
    { symbol: "MES", side: 1, r: 2, usd: 700, taken: true, hisUsd: 450 },
    { symbol: "MNQ", side: -1, r: -1.1, usd: -380, taken: false, hisUsd: null },
    { symbol: "MGC", side: 1, r: null, usd: null, taken: false, hisUsd: null },
  ]);
  assert.equal(t, "📊 Setups 2026-09-23: 3 flagged · a plain 2R bracket on all 2 scored = +0.9R (+$320 at 20) · you took 1 (+$450)");
  assert.equal(recapText("2026-09-23", []), null);
});
