import assert from "node:assert/strict";
import test from "node:test";
import { gradeAskText, gradeKey, matchGrades, gradeLine, gradeSignature, gradeSignatureOk, gradesRecapText, isGrade, parseGradeKey } from "../src/lib/trade-grades-rules";
import { step, type CopilotOrder, type CopilotSnapshot, type CopilotState } from "../src/lib/copilot-rules";

const T0 = Date.parse("2026-09-24T14:00:00Z");
const SECRET = "s3cret";

test("key round-trips; junk keys are refused", () => {
  const k = gradeKey("MES", 1, T0);
  assert.equal(k, `MES|L|${T0}`);
  assert.deepEqual(parseGradeKey(k), { symbol: "MES", side: 1, openedMs: T0 });
  assert.deepEqual(parseGradeKey(gradeKey("MGC", -1, T0))?.side, -1);
  for (const bad of ["", "ES|L|1790000000000", "MES|X|1790000000000", "MES|L|abc", `MES|L|${T0}|x`, "MES|L|1"]) assert.equal(parseGradeKey(bad), null, bad);
});

test("grades: only A, B, C", () => {
  assert.ok(isGrade("A") && isGrade("B") && isGrade("C"));
  assert.ok(!isGrade("a") && !isGrade("D") && !isGrade(""));
});

test("signature: verifies its own key, refuses another key, another secret, or a truncated sig", () => {
  const k = gradeKey("MNQ", -1, T0), sig = gradeSignature(k, SECRET);
  assert.ok(gradeSignatureOk(k, sig, SECRET));
  assert.ok(!gradeSignatureOk(gradeKey("MNQ", -1, T0 + 1), sig, SECRET));
  assert.ok(!gradeSignatureOk(k, sig, "other"));
  assert.ok(!gradeSignatureOk(k, sig.slice(0, 20), SECRET));
});

test("the Slack line: three signed links on the public webhook path, one per grade", () => {
  const txt = gradeAskText("MES", 1, T0, "https://app.example/", SECRET);
  assert.match(txt, /Grade this MES long now, before it plays out/);
  const links = [...txt.matchAll(/<(https:\/\/app\.example\/api\/webhook\/trading-room\/grade\?k=([^&]+)&g=([ABC])&sig=([0-9a-f]{32}))\|/g)];
  assert.deepEqual(links.map((m) => m[3]), ["A", "B", "C"]);
  for (const m of links) assert.ok(gradeSignatureOk(decodeURIComponent(m[2]), m[4], SECRET));
});

test("grade line and recap: counts, net, win rate; the 50-trade note", () => {
  const rows = [{ grade: "A" as const, netUsd: 500 }, { grade: "A" as const, netUsd: -200 }, { grade: "C" as const, netUsd: -350 }];
  assert.equal(gradeLine(rows), "A 2 trades +$300 (50% win) · C 1 trade −$350 (0% win)");
  assert.equal(gradeLine([]), null);
  assert.match(gradesRecapText([], rows)!, /today: none graded · since start: A 2 trades \+\$300 .* \(3\/50 before it means much\)/);
  assert.equal(gradesRecapText([], []), null);
});

// ---- the co-pilot asks once per entry, when its card goes out ----
const stop = (price: number): CopilotOrder => ({ orderId: 1, symbol: "MES", action: "Sell", kind: "stop", price, qty: 20 });
const snap = (dt: number, netPos: number, orders: CopilotOrder[] | null, price?: number): CopilotSnapshot =>
  ({ nowMs: T0 + dt, positions: netPos ? [{ symbol: "MES", netPos, netPrice: 7831.25 }] : [], orders, prices: price != null ? { MES: price } : {}, fills: [] });

test("co-pilot: one grade ask per entry, with the card; none on later polls; a new entry asks again", () => {
  let st: CopilotState = { trips: {} };
  const asks: number[] = [];
  for (const s of [snap(0, 20, [stop(7827.75)]), snap(15_000, 20, null, 7833), snap(30_000, 20, null, 7835), snap(700_000, 0, []), snap(1_400_000, 20, [stop(7827.75)])]) {
    const r = step(st, s); st = r.state; asks.push(r.gradeAsks.length);
  }
  assert.deepEqual(asks, [1, 0, 0, 0, 1]);
  const first = step({ trips: {} }, snap(0, 20, [stop(7827.75)]));
  assert.deepEqual(first.gradeAsks, [{ symbol: "MES", side: 1, openedMs: T0 }]);
});

test("co-pilot: an entry without a stop asks when its card goes out after the grace period", () => {
  const a = step({ trips: {} }, snap(0, 20, []));
  assert.equal(a.gradeAsks.length, 0);
  const b = step(a.state, snap(45_000, 20, []));
  assert.equal(b.gradeAsks.length, 1);
});

test("co-pilot: entries after 2 PM ET carry the afternoon note; morning entries don't", () => {
  const at = (iso: string): CopilotSnapshot => ({ nowMs: Date.parse(iso), positions: [{ symbol: "MES", netPos: 20, netPrice: 7831.25 }], orders: [stop(7827.75)], prices: {}, fills: [] });
  assert.match(step({ trips: {} }, at("2026-09-24T18:30:00Z")).messages.join("\n"), /⏰ After 2 PM ET/);    // 14:30 ET
  assert.doesNotMatch(step({ trips: {} }, at("2026-09-24T14:30:00Z")).messages.join("\n"), /After 2 PM/);  // 10:30 ET
  assert.doesNotMatch(step({ trips: {} }, at("2026-09-24T22:30:00Z")).messages.join("\n"), /After 2 PM/);  // 18:30 ET
});

// ---- review fixes ----
test("matching: a quick exit + re-entry between two polls gives the grade to the trip he graded, not the later one", () => {
  // trip A fills 10:00:00, co-pilot sees it 10:00:50 (the grade key); he exits 10:01:00 and re-enters 10:01:20 (trip B)
  const g = [{ symbol: "MES", side: 1 as const, openedMs: T0 + 50_000 }];
  const trips = [{ symbol: "MES", side: 1 as const, entryMs: T0 }, { symbol: "MES", side: 1 as const, entryMs: T0 + 80_000 }];
  assert.deepEqual(matchGrades(g, trips), [0]);
});

test("matching: latest entry at or before the sighting (+5 s skew); older than 3 min or another side/market → none; each trip once", () => {
  const tr = [{ symbol: "MES", side: 1 as const, entryMs: T0 - 200_000 }, { symbol: "MES", side: 1 as const, entryMs: T0 - 60_000 }, { symbol: "MES", side: 1 as const, entryMs: T0 + 4_000 }];
  assert.deepEqual(matchGrades([{ symbol: "MES", side: 1, openedMs: T0 }], tr), [2]);                         // +4 s skew is fine, latest wins
  assert.deepEqual(matchGrades([{ symbol: "MES", side: 1, openedMs: T0 - 190_000 }], tr), [0]);
  assert.deepEqual(matchGrades([{ symbol: "MES", side: -1, openedMs: T0 }, { symbol: "MNQ", side: 1, openedMs: T0 }], tr), [-1, -1]);
  assert.deepEqual(matchGrades([{ symbol: "MES", side: 1, openedMs: T0 }, { symbol: "MES", side: 1, openedMs: T0 + 1_000 }], tr), [2, 1]);
  assert.deepEqual(matchGrades([{ symbol: "MES", side: 1, openedMs: T0 + 400_000 }], tr), [-1]);          // > 3 min after the last entry
});

test("signature: anything but 32 lowercase hex is refused without throwing (multi-byte, uppercase, short)", () => {
  const k = gradeKey("MES", 1, T0);
  assert.equal(gradeSignatureOk(k, "é".repeat(32), SECRET), false);
  assert.equal(gradeSignatureOk(k, gradeSignature(k, SECRET).toUpperCase(), SECRET), false);
  assert.equal(gradeSignatureOk(k, "", SECRET), false);
});

test("co-pilot: a quick trade that closed before its card went out still gets a grade ask (once)", () => {
  const a = step({ trips: {} }, snap(0, 20, []));                    // no stop → no card yet
  const b = step(a.state, snap(20_000, 0, []));                     // closed after 20 s
  assert.equal(b.gradeAsks.length, 1);
  assert.equal(b.gradeAsks[0].openedMs, T0);
  assert.equal(b.gradeAsks[0].closed, true);
  assert.match(gradeAskText("MES", 1, T0, "https://x", SECRET, true), /Grade that quick MES long you just closed — how was the ENTRY\?/);
  const c = step(b.state, snap(40_000, 0, []));
  assert.equal(c.gradeAsks.length, 0);
});
