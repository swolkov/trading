import assert from "node:assert/strict";
import test from "node:test";
import {
  FEES_RT_PER_CONTRACT_USD, TEST_RULES, bootstrapPMeanPositive, dayTally, excursion, riskPerContract, roundTripsFromFills, scoreboard, sessionBucket,
  type JournalFill, type JournalRow,
} from "../src/lib/trading-room-journal";
import { INSTRUMENTS, type Bar } from "../src/lib/trading-room-rules";

const T0 = Date.parse("2026-09-21T13:35:00Z");   // Mon 09:35 ET
const f = (id: number, symbol: JournalFill["symbol"], min: number, action: "Buy" | "Sell", qty: number, price: number): JournalFill => ({ id, symbol, ts: T0 + min * 60_000, action, qty, price });

test("round trips: a plain long, a scale-in with two exits, a flip, and an open position — at his size", () => {
  const trips = roundTripsFromFills([
    f(1, "MES", 0, "Buy", 20, 7700), f(2, "MES", 12, "Sell", 20, 7705),                       // +5 pts × $5 × 20 = $500 gross
    f(3, "MNQ", 20, "Sell", 10, 29900), f(4, "MNQ", 25, "Sell", 10, 29910), f(5, "MNQ", 40, "Buy", 5, 29880), f(6, "MNQ", 45, "Buy", 15, 29870),
    f(7, "MGC", 60, "Buy", 4, 4400), f(8, "MGC", 70, "Sell", 6, 4402), f(9, "MGC", 80, "Buy", 2, 4399),   // long 4 → flip to short 2 → cover
    f(10, "MES", 90, "Buy", 25, 7710),                                                            // still open
  ]);
  assert.equal(trips.length, 5);
  const closed = trips.filter((t) => !t.open).sort((a, b) => a.entryTs - b.entryTs);
  assert.equal(closed.length, 4);
  const [mes, mnq, mgcLong, mgcShort] = closed;
  assert.deepEqual([mes.symbol, mes.side, mes.qty, mes.grossUsd, mes.feesUsd], ["MES", "long", 20, 500, FEES_RT_PER_CONTRACT_USD * 20]);
  // MNQ: short 20 at avg 29905, covered 5 @ 29880 + 15 @ 29870 = avg 29872.5 → +32.5 pts × $2 × 20 = $1,300
  assert.equal(mnq.side, "short"); assert.equal(mnq.qty, 20); assert.equal(Math.round(mnq.grossUsd), 1300);
  assert.deepEqual(mnq.fillIds, [3, 4, 5, 6]);
  // MGC: long 4 @ 4400 closed by 4 of the 6-lot sell @ 4402 → +2 × $10 × 4 = $80; the other 2 open a short @ 4402 covered @ 4399 → +3 × $10 × 2 = $60
  assert.deepEqual([mgcLong.side, mgcLong.qty, mgcLong.grossUsd], ["long", 4, 80]);
  assert.deepEqual([mgcShort.side, mgcShort.qty, mgcShort.grossUsd], ["short", 2, 60]);
  const open = trips.find((t) => t.open)!;
  assert.deepEqual([open.symbol, open.qty, open.grossUsd], ["MES", 25, 0]);
});

test("session buckets and R sources", () => {
  assert.equal(sessionBucket(Date.parse("2026-09-21T13:35:00Z")), "open");
  assert.equal(sessionBucket(Date.parse("2026-09-21T17:00:00Z")), "midday");
  assert.equal(sessionBucket(Date.parse("2026-09-21T22:30:00Z")), "overnight");
  assert.deepEqual(riskPerContract(INSTRUMENTS.MES, 7700, 7690, 3), { usd: 50, source: "stop" });
  assert.deepEqual(riskPerContract(INSTRUMENTS.MES, 7700, null, 3), { usd: 30, source: "atr-proxy" });
  assert.equal(riskPerContract(INSTRUMENTS.MES, 7700, null, null), null);
});

test("excursions come from the bars inside the trade only", () => {
  const bars: Bar[] = [0, 1, 2, 3, 4].map((i) => ({ t: T0 + i * 60_000, o: 100, h: 100 + i, l: 100 - i, c: 100, v: 1 }));
  const e = excursion(bars, "long", 100, T0 + 60_000, T0 + 3 * 60_000)!;
  assert.deepEqual(e, { mfePts: 3, maePts: 3 });
  const s = excursion(bars, "short", 100, T0 + 60_000, T0 + 2 * 60_000)!;
  assert.deepEqual(s, { mfePts: 2, maePts: 2 });
  assert.equal(excursion([], "long", 100, T0, T0 + 1), null);
});

function row(i: number, netR: number, netUsd: number, extra: Partial<JournalRow> = {}): JournalRow {
  return { id: `MES-${i}`, symbol: "MES", side: "long", qty: 20, entryTs: new Date(T0 + i * 3_600_000).toISOString(), exitTs: new Date(T0 + i * 3_600_000 + 600_000).toISOString(), entryPx: 7700, exitPx: 7701,
    grossUsd: netUsd + 30, feesUsd: 30, netUsd, stopPx: 7690, riskUsd: 1000, riskSource: "stop", netR, mfeR: 1, maeR: 0.5, holdMin: 10, session: "open", dow: 1,
    nearestLevel: "VWAP", nearestLevelPx: 7699, distAtr: 0.01, eventFlag: null, setupTag: null, why: null, open: false, fillIds: [i], ...extra };
}

test("the 40-trade test: collecting below 40, then pass / fail on the pre-registered checks", () => {
  const few = Array.from({ length: 10 }, (_, i) => row(i, 0.5, 500));
  assert.equal(scoreboard(few).verdict.status, "collecting");
  // 40 trades: 26 winners of +1R, 14 losers of −1R → mean +0.3R, t ≈ 2.0, PF 26/14, PF without top two 24/14
  const good = Array.from({ length: 40 }, (_, i) => row(i, i % 20 < 13 ? 1 : -1, i % 20 < 13 ? 1000 : -1000));
  const g = scoreboard(good);
  assert.equal(g.closed, 40);
  assert.ok(g.tStat != null && g.tStat > 1.5, `t ${g.tStat}`);
  assert.equal(g.profitFactor, 26 / 14);
  assert.equal(g.profitFactorWithoutTopTwo, 24 / 14);
  assert.ok((g.bootstrapPMeanPositive ?? 0) > 0.85);
  assert.equal(g.verdict.status, "pass");
  // Same 40 but the whole profit is two outliers → fails "without the top two".
  const lumpy = Array.from({ length: 40 }, (_, i) => (i < 2 ? row(i, 20, 20000) : row(i, -0.5, -500)));
  const l = scoreboard(lumpy);
  assert.equal(l.verdict.status, "fail");
  assert.ok((l.profitFactorWithoutTopTwo ?? 1) < 1);
  // Open trades never count.
  const withOpen = [...good, row(99, 0, 0, { open: true })];
  assert.equal(scoreboard(withOpen).closed, 40);
  assert.equal(TEST_RULES.minTrades, 40);
});

test("bootstrap is deterministic under the fixed seed and needs five trades", () => {
  assert.equal(bootstrapPMeanPositive([1, 1, 1]), null);
  const a = bootstrapPMeanPositive([1, -1, 1, 1, -1, 1, 0.5, -0.2], 2000);
  const b = bootstrapPMeanPositive([1, -1, 1, 1, -1, 1, 0.5, -0.2], 2000);
  assert.equal(a, b);
  assert.ok(a != null && a > 0.5 && a < 1);
});

test("splits: sessions, markets and the print window are reported from the closed rows", () => {
  const rows = [row(0, 1, 1000), row(1, -1, -1000, { session: "midday" }), row(2, 2, 2000, { symbol: "MGC", session: "open" })];
  const sb = scoreboard(rows, 30 * 60_000, [Date.parse(rows[1].entryTs) + 10 * 60_000]);
  assert.deepEqual(sb.eventWindow, { inside: { n: 1, netUsd: -1000 }, outside: { n: 2, netUsd: 3000 } });
  assert.equal(sb.bySession.find((s) => s.session === "open")?.n, 2);
  assert.equal(sb.bySymbol.find((s) => s.symbol === "MGC")?.netUsd, 2000);
  assert.equal(sb.avgContracts, 20);
});

test("the day's tally counts only closed trips that exited on that exchange day", () => {
  const key = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const rows = [row(0, 1, 1000), row(1, -1, -1000), row(2, 0.5, 500, { open: true }), { ...row(3, 2, 2000), exitTs: "2026-09-22T15:00:00.000Z" }];
  const t = dayTally(rows, key, "2026-09-21");
  assert.deepEqual([t.n, t.netUsd, t.feesUsd, t.wins, t.losses, t.contracts], [2, 0, 60, 1, 1, 40]);
  assert.equal(dayTally(rows, key, "2026-09-22").n, 1);
});
