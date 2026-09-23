import assert from "node:assert/strict";
import test from "node:test";
import { execVerb, executions, pnlAt, usd0 } from "../src/lib/trading-room-replay-rules";
import { roundTripsFromFills } from "../src/lib/trading-room-journal";

// His MNQ short, Sep 23 2026 9:53 AM ET: sold 15, bought 5 back higher, covered 10 far lower. Journal: +$2,605 net.
const T = Date.parse("2026-09-23T13:53:00Z");
const fills = [
  { ts: new Date(T).toISOString(), action: "Sell" as const, qty: 15, price: 30864.25 },
  { ts: new Date(T + 9 * 60_000).toISOString(), action: "Buy" as const, qty: 5, price: 30875 },
  { ts: new Date(T + 22 * 60_000).toISOString(), action: "Buy" as const, qty: 10, price: 30727.08 },
];

test("executions: each fill says what it did and what an exit banked — and they add up to the journal's gross", () => {
  const ex = executions("short", fills, 2);
  assert.deepEqual(ex.map((e) => e.role), ["open", "reduce", "close"]);
  assert.deepEqual(ex.map((e) => e.posAfter), [15, 10, 0]);
  assert.equal(ex[0].realizedUsd, null);
  assert.equal(ex[1].realizedUsd, -107.5, "5 bought back 10.75 points higher");
  assert.equal(Math.round(ex[2].realizedUsd!), 2743, "10 covered 137.17 points lower");
  const trip = roundTripsFromFills(fills.map((f, i) => ({ id: i + 1, symbol: "MNQ" as const, ts: Date.parse(f.ts), action: f.action, qty: f.qty, price: f.price })))[0];
  assert.equal(Math.round(ex.reduce((a, e) => a + (e.realizedUsd ?? 0), 0)), Math.round(trip.grossUsd));
  assert.equal(Math.round(trip.netUsd), 2605, "the journal's number for this trade");
  assert.equal(execVerb("short", ex[0]), "opened short"); assert.equal(execVerb("short", ex[1]), "covered 5"); assert.equal(execVerb("short", ex[2]), "covered 10 · flat");
});

test("pnlAt: open P&L while on, banked after exits, nothing before the entry", () => {
  const ex = executions("short", fills, 2);
  assert.deepEqual(pnlAt("short", ex, 2, T - 1, 30900), { pos: 0, avgPx: null, openUsd: 0, bankedUsd: 0 });
  const mid = pnlAt("short", ex, 2, T + 60_000, 30850);
  assert.equal(mid.pos, 15); assert.equal(Math.round(mid.openUsd), Math.round(14.25 * 2 * 15));
  const after5 = pnlAt("short", ex, 2, T + 10 * 60_000, 30800);
  assert.equal(after5.pos, 10); assert.equal(after5.bankedUsd, -107.5); assert.equal(Math.round(after5.openUsd), Math.round(64.25 * 2 * 10));
  const done = pnlAt("short", ex, 2, T + 60 * 60_000, 30700);
  assert.equal(done.pos, 0); assert.equal(done.openUsd, 0); assert.equal(Math.round(done.bankedUsd), 2636);
});

test("executions: scale-in averages the cost; a flip fill only closes what was on", () => {
  const ex = executions("long", [
    { ts: "2026-09-23T14:00:00Z", action: "Buy", qty: 10, price: 100 },
    { ts: "2026-09-23T14:01:00Z", action: "Buy", qty: 10, price: 110 },
    { ts: "2026-09-23T14:02:00Z", action: "Sell", qty: 25, price: 120 },
  ], 5);
  assert.deepEqual(ex.map((e) => e.role), ["open", "add", "close"]);
  assert.equal(ex[1].avgPx, 105); assert.equal(ex[2].qty, 20); assert.equal(ex[2].realizedUsd, 15 * 5 * 20);
});

test("usd0 is ASCII and grouped", () => { assert.equal(usd0(2743.4), "+$2,743"); assert.equal(usd0(-107.5), "-$108"); });
