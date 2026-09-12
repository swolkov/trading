import assert from "node:assert/strict";
import test from "node:test";
import { nextDayReservation, parseDayState } from "../src/lib/margin-day-state";
import { bookExposureMatches, entryExposureRefusal, parsePyramidMarker, recoverPyramidWithIO, recoveryBlocksPair, type PyramidMarker } from "../src/lib/margin-pyramid-recovery";

const parent = { ordertxid: "P", id: "p", pair: "ETHUSD:BTNL", side: "long" };
const add = { ...parent, ordertxid: "A", id: "a" };
const marker: PyramidMarker = { parent: "P", txid: "A", ts: 1 };
function io(overrides: Partial<Parameters<typeof recoverPyramidWithIO>[1]> = {}) {
  return {
    readMarker: async () => marker,
    ledgerCorrupt: false,
    isOurs: (p: typeof parent) => p.ordertxid === "P",
    ledgerHas: () => false,
    parentOf: () => null as string | null,
    record: async () => true,
    markLedgered: async () => {},
    ...overrides,
  };
}

test("marker parse fails closed on malformed state; only absent state is clear", () => {
  assert.equal(parsePyramidMarker(null), null);
  for (const raw of ['{}', 'null', '{"parent":"P","ts":null}', '{"parent":"P","ts":1,"txid":""}', '{"parent":"P","ts":1,"ledgered":"true"}']) {
    assert.throws(() => parsePyramidMarker(raw));
  }
});

test("unreadable marker blocks every pair without any ownership write", async () => {
  let writes = 0;
  const result = await recoverPyramidWithIO([parent, add], io({ readMarker: async () => { throw Error("DB unavailable"); }, record: async () => { writes++; return true; } }));
  assert.equal(result.status, "unresolved");
  assert.equal(recoveryBlocksPair(result, "BTCUSD"), true);
  assert.equal(writes, 0);
});

test("failed ownership persistence preserves affected pair protection indefinitely", async () => {
  let marked = false;
  const result = await recoverPyramidWithIO([parent, add], io({ record: async () => false, markLedgered: async () => { marked = true; } }));
  assert.equal(result.status, "unresolved");
  assert.equal(recoveryBlocksPair(result, "ETH/USD"), true);
  assert.equal(recoveryBlocksPair(result, "BTC/USD"), false);
  assert.equal(marked, false);
});

test("an old marker without a transaction ID never adopts a manual position or expires open", async () => {
  let wrote = false;
  const result = await recoverPyramidWithIO([parent, { ...add, ordertxid: "MANUAL" }], io({ readMarker: async () => ({ parent: "P", ts: 1 }), record: async () => { wrote = true; return true; } }));
  assert.equal(result.status, "unresolved");
  assert.equal(wrote, false);
});

test("recovery requires the exact add on the parent's pair and side", async () => {
  for (const position of [{ ...add, ordertxid: "MANUAL" }, { ...add, side: "short" }, { ...add, pair: "BTCUSD" }]) {
    let wrote = false;
    const result = await recoverPyramidWithIO([parent, position], io({ record: async () => { wrote = true; return true; } }));
    assert.equal(result.status, "unresolved");
    assert.equal(wrote, false);
  }
});

test("confirmed recovery records the exact add against the owned parent", async () => {
  const calls: string[] = [];
  const result = await recoverPyramidWithIO([parent, add], io({ record: async (m, p) => { calls.push(`${m.txid}:${p.ordertxid}`); return true; }, markLedgered: async () => { calls.push("marked"); } }));
  assert.equal(result.status, "recovered");
  assert.deepEqual(calls, ["A:P", "marked"]);
});

test("ledgered marker cannot hide missing or conflicting durable ownership", async () => {
  const marked = async () => ({ ...marker, ledgered: true });
  assert.equal((await recoverPyramidWithIO([parent], io({ readMarker: marked }))).status, "unresolved");
  assert.equal((await recoverPyramidWithIO([parent, add], io({ readMarker: marked, ledgerHas: () => true, parentOf: () => "OTHER" }))).status, "unresolved");
  assert.equal((await recoverPyramidWithIO([parent, add], io({ readMarker: marked, ledgerCorrupt: true }))).status, "unresolved");
});

test("durable parent link remains valid if marker cleanup fails", async () => {
  const result = await recoverPyramidWithIO([parent, add], io({ ledgerHas: () => true, parentOf: () => "P", markLedgered: async () => { throw Error("DB cleanup failed"); } }));
  assert.equal(result.status, "clear");
});

test("new or unknown pair exposure invalidates a snapshot stop replacement", () => {
  assert.equal(bookExposureMatches(10, 20), false, "unledgered add must not lose its stop");
  assert.equal(bookExposureMatches(0, 10), false, "newer book's stops must survive an old flat snapshot");
  assert.equal(bookExposureMatches(10, NaN), false);
  assert.equal(bookExposureMatches(10, 10), true);
  assert.equal(bookExposureMatches(0, 0), true);
});

test("stacking permission never permits manual or opposing exposure", () => {
  assert.ok(entryExposureRefusal([{ side: "long", owned: false }], "long"));
  assert.ok(entryExposureRefusal([{ side: "short", owned: true }], "long"));
  assert.equal(entryExposureRefusal([{ side: "long", owned: true }], "long"), null);
});


test("daily entry state refuses missing, malformed, future or uncountable records", () => {
  const now = Date.parse("2026-09-12T12:00:00Z");
  for (const raw of [null, "", "{}", "null", JSON.stringify({ date: "2026-09-12", entries: -1, lastEntryIso: null }), JSON.stringify({ date: "2026-09-12", entries: 2, lastEntryIso: null }), JSON.stringify({ date: "2026-09-13", entries: 0, lastEntryIso: null }), JSON.stringify({ date: "2026-02-30", entries: 0, lastEntryIso: null })]) assert.throws(() => parseDayState(raw, now));
});

test("UTC rollover resets the allowance but preserves cooldown", () => {
  const last = "2026-09-11T23:59:50Z";
  const now = Date.parse("2026-09-12T00:00:10Z");
  const s = parseDayState(JSON.stringify({ date: "2026-09-11", entries: 5, lastEntryIso: last }), now);
  assert.deepEqual(s, { date: "2026-09-12", entries: 0, lastEntryIso: last });
  assert.equal(now - Date.parse(s.lastEntryIso!), 20_000);
  assert.deepEqual(nextDayReservation(s, now), { date: "2026-09-12", entries: 1, lastEntryIso: new Date(now).toISOString() });
});

test("reservation records each attempted broker entry before any receipt is needed", () => {
  const now = Date.parse("2026-09-12T12:00:00Z");
  const before = { date: "2026-09-12", entries: 4, lastEntryIso: "2026-09-12T10:00:00Z" };
  const reserved = nextDayReservation(before, now);
  assert.equal(reserved.entries, 5);
  assert.equal(parseDayState(JSON.stringify(reserved), now).entries, 5, "restart sees consumed allowance even without a broker response");
});
