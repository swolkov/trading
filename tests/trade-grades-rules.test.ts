import assert from "node:assert/strict";
import test from "node:test";
import { disciplineRecapText, gradeAskText, gradeKey, matchGrades, gradeLine, gradeSignature, gradeSignatureOk, gradesRecapText, isGrade, parseGradeKey } from "../src/lib/trade-grades-rules";
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

// ---- the automatic discipline grade ----
const wide = (price = 7821.25, symbol: CopilotOrder["symbol"] = "MES", qty = 20): CopilotOrder => ({ orderId: 1, symbol, action: "Sell", kind: "stop", price, qty });
const pos = (iso: string | number, netPos: number, orders: CopilotOrder[] | null, fills: CopilotSnapshot["fills"] = [], symbol: CopilotOrder["symbol"] = "MES", netPrice = 7831.25): CopilotSnapshot =>
  ({ nowMs: typeof iso === "number" ? iso : Date.parse(iso), positions: netPos ? [{ symbol, netPos, netPrice }] : [], orders, prices: {}, fills });
const sellFill = (px: number, iso: string, qty = 20, symbol: CopilotOrder["symbol"] = "MES") => [{ symbol, action: "Sell" as const, qty, price: px, ms: Date.parse(iso) }];

test("discipline: an MES morning trade with a real stop, stopped out after 12 min, is by the book 6/6", () => {
  const a = step({ trips: {} }, pos("2026-09-24T14:30:00Z", 20, [wide()]));           // 10:30 ET
  const b = step(a.state, pos("2026-09-24T14:42:00Z", 0, [], sellFill(7821.25, "2026-09-24T14:41:50Z")));
  assert.equal(b.discipline.length, 1);
  assert.deepEqual({ score: b.discipline[0].score, broken: b.discipline[0].broken }, { score: 6, broken: [] });
  assert.match(b.messages.join("\n"), /📏 By the book 6\/6/);
});

test("discipline: MNQ at 3 PM, sold by hand after 1 min → 3 rules broken, named", () => {
  const mnqStop = { orderId: 1, symbol: "MNQ" as const, action: "Sell" as const, kind: "stop" as const, price: 30650, qty: 10 };
  const a = step({ trips: {} }, pos("2026-09-24T19:00:00Z", 10, [mnqStop], [], "MNQ", 30700));                         // 15:00 ET
  const b = step(a.state, pos("2026-09-24T19:01:00Z", 0, [], [{ symbol: "MNQ", action: "Sell", qty: 10, price: 30702, ms: Date.parse("2026-09-24T19:00:58Z") }], "MNQ"));
  const d = b.discipline[0];
  assert.equal(d.score, 3);
  assert.deepEqual(d.broken, ["not MES", "outside 9:30 AM–2 PM", "out by hand < 10 min"]);
  assert.match(b.messages.join("\n"), /📏 Discipline 3\/6 — broke: not MES · outside 9:30 AM–2 PM · out by hand < 10 min/);
});

test("discipline: back in within 10 min of a loss, and a too-tight stop, are both marked", () => {
  let st: CopilotState = { trips: {} };
  st = step(st, pos("2026-09-24T14:30:00Z", 20, [wide()])).state;
  st = step(st, pos("2026-09-24T14:42:00Z", 0, [], sellFill(7821.25, "2026-09-24T14:41:50Z"))).state;   // a loss
  st = step(st, pos("2026-09-24T14:45:00Z", 20, [wide(7827.75)])).state;                                  // back in 3 min later, 3.5-pt stop
  const r = step(st, pos("2026-09-24T14:58:00Z", 0, [], sellFill(7827.75, "2026-09-24T14:57:50Z")));
  assert.deepEqual(r.discipline[0].broken, ["< 10 min after a loss", "no stop or too tight"]);
});

test("discipline: the 6th trade of the day is past the limit", () => {
  let st: CopilotState = { trips: {} }; let last: ReturnType<typeof step> | null = null;
  for (let i = 0; i < 6; i++) {
    const t0 = Date.parse("2026-09-24T13:40:00Z") + i * 20 * 60_000;              // 9:40 ET onward, winners
    st = step(st, pos(t0, 20, [wide()])).state;
    last = step(st, pos(t0 + 12 * 60_000, 0, [], [{ symbol: "MES", action: "Sell", qty: 20, price: 7840, ms: t0 + 12 * 60_000 - 5_000 }]));
    st = last.state;
  }
  assert.deepEqual(last!.discipline[0].broken, ["past 5 trades / 2 losses"]);
});

test("discipline: an unknown exit price is never held against him; pre-rule saved state isn't scored", () => {
  const a = step({ trips: {} }, pos("2026-09-24T14:30:00Z", 20, [wide()]));
  const b = step(a.state, pos("2026-09-24T14:31:00Z", 0, []));                     // closed, fills unreadable
  assert.deepEqual(b.discipline[0].broken, []);
  const old = { ...a.state.trips.MES! } as Record<string, unknown>; delete old.entryRules;
  const c = step({ trips: { MES: old as never } }, pos("2026-09-24T14:40:00Z", 0, [], sellFill(7825, "2026-09-24T14:39:50Z")));
  assert.equal(c.discipline.length, 0);
});

test("discipline recap: by the book vs broke a rule, today and since start", () => {
  const rows = [{ score: 6, netUsd: 700 }, { score: 6, netUsd: -350 }, { score: 4, netUsd: -500 }];
  assert.equal(disciplineRecapText(rows.slice(0, 1), rows),
    "📏 Discipline — today: by the book 1 trade +$700 (100% win) · since start: by the book 2 trades +$350 (50% win) · broke a rule 1 trade −$500 (0% win)");
  assert.equal(disciplineRecapText([], []), null);
});

test("discipline: orders never read → the stop rule is unknown, not broken; no fills → no 'by hand' anywhere in the close", () => {
  const a = step({ trips: {} }, pos("2026-09-24T14:30:00Z", 20, null));          // orders unreadable the whole trip
  const b = step(a.state, pos("2026-09-24T14:31:00Z", 20, null));
  const c = step(b.state, pos("2026-09-24T14:32:00Z", 0, null));                 // closed after 2 min, fills unreadable
  const txt = c.messages.join("\n");
  assert.deepEqual(c.discipline[0].broken, []);
  assert.doesNotMatch(txt, /hands off for 10 minutes/);
  assert.doesNotMatch(txt, /no stop or too tight/);
});
