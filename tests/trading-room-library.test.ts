import assert from "node:assert/strict";
import test from "node:test";
import { ROOM_START_MS, dayGroups, equityCurve, filterRows, libraryCsv, libraryRows, libraryStats } from "../src/lib/trading-room-library";
import type { JournalRow } from "../src/lib/trading-room-journal";
import type { LedgerTrade } from "../src/lib/trading-room-ledger-rules";

const T0 = ROOM_START_MS + 3_600_000;
function jr(i: number, netUsd: number, netR: number | null, extra: Partial<JournalRow> = {}): JournalRow {
  return { id: `MES-${i}`, symbol: "MES", side: "long", qty: 20, entryTs: new Date(T0 + i * 3_600_000).toISOString(), exitTs: new Date(T0 + i * 3_600_000 + 600_000).toISOString(), entryPx: 7700, exitPx: 7701,
    grossUsd: netUsd + 40, feesUsd: 40, netUsd, stopPx: null, riskUsd: 650, riskSource: "atr-proxy", netR, mfeR: netR == null ? null : Math.max(netR, 0) + 0.5, maeR: 0.1, holdMin: 10, session: "open", dow: 1,
    nearestLevel: "VWAP", nearestLevelPx: 7699, distAtr: 0.1, eventFlag: null, setupTag: i % 2 ? "pdh" : null, why: null, grade: i % 2 ? "A" : null, open: false, fillIds: [i], ...extra };
}
const lt = (id: number, ms: number, gross: number, pairs = 3): LedgerTrade => ({ id, exitTs: new Date(ms).toISOString(), tradeDate: "2026-09-18", pairs, grossUsd: gross, bestPairUsd: gross, worstPairUsd: gross, runningGrossUsd: 0 });

test("library rows: journal trips plus broker records from before the room, newest first, efficiency = net R over MFE R", () => {
  const rows = libraryRows([jr(0, 600, 1), jr(1, -300, -0.5), jr(2, 0, 0, { open: true })], [lt(1, ROOM_START_MS - 86_400_000, 1125), lt(2, ROOM_START_MS + 10, 50)]);
  assert.equal(rows.length, 4, "the ledger trade after the room started is not duplicated");
  assert.equal(rows[0].id, "MES-2"); assert.equal(rows[3].kind, "record"); assert.equal(rows[3].netUsd, 1125); assert.equal(rows[3].pairs, 3);
  const win = rows.find((r) => r.id === "MES-0")!; assert.equal(win.efficiency, Math.round((1 / 1.5) * 100) / 100);
  assert.equal(rows.find((r) => r.id === "MES-1")!.efficiency, -1, "a loser: −0.5R over an MFE of 0.5R");
});

test("stats, filters, day groups, equity curve, csv", () => {
  const rows = libraryRows([jr(0, 600, 1), jr(1, -300, -0.5), jr(2, 200, 0.4), jr(3, 0, 0, { open: true })], [lt(1, ROOM_START_MS - 86_400_000, -100)]);
  const s = libraryStats(rows);
  assert.deepEqual([s.n, s.wins, s.losses, s.netUsd, s.feesUsd], [4, 2, 2, 400, 120]);
  assert.equal(s.expectancyUsd, 100); assert.equal(s.profitFactor, 800 / 400); assert.equal(s.bestUsd, 600); assert.equal(s.worstUsd, -300);
  assert.equal(s.maxDrawdownUsd, 300, "peak 500 after the first two (−100, +600), then −300");
  assert.equal(s.bySymbol[0].key, "MES"); assert.equal(s.byTag[0].key, "pdh"); assert.equal(s.byGrade[0].key, "A");
  assert.equal(filterRows(rows, { result: "win" }).length, 2); assert.equal(filterRows(rows, { kind: "record" }).length, 1); assert.equal(filterRows(rows, { tag: "PDH" }).length, 2);
  const curve = equityCurve(rows); assert.deepEqual(curve.map((c) => c.cum), [-100, 500, 200, 400]);
  const days = dayGroups(rows, (ms) => new Date(ms).toISOString().slice(0, 10)); assert.equal(days[0].day >= days[days.length - 1].day, true); assert.equal(days.reduce((a, d) => a + d.n, 0), 4);
  const csv = libraryCsv(rows); assert.equal(csv.split("\n").length, 6); assert.match(csv, /^kind,entry_utc/);
});
