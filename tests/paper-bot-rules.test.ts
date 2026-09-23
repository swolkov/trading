import assert from "node:assert/strict";
import test from "node:test";
import { BOT_FEE_RT, botContracts, botDay, botEntryText, botExitText, botRecapText, botRunner, runPaperBot, simulateTrade, type Settled } from "../src/lib/paper-bot-rules";
import type { Setup } from "../src/lib/setup-feed-rules";
import type { Bar } from "../src/lib/trading-room-rules";

// Wed Sep 23 2026, 10:00 ET = 14:00Z. A setup's 5-minute bar opens at `at` and closes 5 minutes later.
const T = Date.parse("2026-09-23T14:00:00Z");
const MIN = 60_000;
const mk = (o: Partial<Setup> & { atMs?: number } = {}): Setup => {
  const atMs = o.atMs ?? T;
  const side = o.side ?? 1, symbol = o.symbol ?? "MES";
  return { id: `${symbol}|${side === 1 ? "L" : "S"}|${new Date(atMs).toISOString()}`, symbol, side, at: new Date(atMs).toISOString(), price: o.price ?? 7800, stop: o.stop ?? 7796, orh: null, orl: null, vwap: null };
};
/** 1-minute bars from `start`: each [o, h, l, c]. */
const bars = (rows: [number, number, number, number][], start = T + 5 * MIN): Bar[] => rows.map(([o, h, l, c], i) => ({ t: start + i * MIN, o, h, l, c, v: 1 }));
const LATE = Date.parse("2026-09-24T01:00:00Z");   // long after the session

test("sizing: floor($400 ÷ risk per contract), max 20; 0 when one contract is already over", () => {
  assert.equal(botContracts("MES", 4), 20);          // $20/contract → 20
  assert.equal(botContracts("MES", 10.75), 7);       // $53.75 → 7
  assert.equal(botContracts("MNQ", 101.5), 1);       // $203 → 1
  assert.equal(botContracts("MGC", 9.4), 4);         // $94 → 4
  assert.equal(botContracts("MGC", 45), 0);          // $450 for one
  assert.equal(botRunner(20), 5); assert.equal(botRunner(7), 1); assert.equal(botRunner(3), 0);
});

test("long: stop first → −1R plus a tick of slippage and fees", () => {
  // fill 7800.25 (open 7800 + 1 tick), stop 7796 → risk 4.25 pts → 18 contracts
  const t = simulateTrade(mk(), bars([[7800, 7801, 7799, 7800], [7800, 7800.5, 7795.5, 7796]]), LATE);
  assert.equal(t.status, "done"); assert.equal(t.how, "stop"); assert.equal(t.contracts, 18);
  const expGross = (7795.75 - 7800.25) * 5 * 18;
  assert.equal(Math.round(t.grossUsd!), Math.round(expGross));
  assert.equal(Math.round(t.usd!), Math.round(expGross - BOT_FEE_RT * 18));
});

test("long: +2R sells all but the runner; runner stopped at breakeven", () => {
  // fill 7800.25, risk 4.25, +2R = 7808.75 → 18 contracts, runner 4, sell 14
  const t = simulateTrade(mk(), bars([[7800, 7802, 7799, 7801], [7801, 7809, 7800.5, 7808], [7808, 7808.5, 7800, 7800.5]]), LATE);
  assert.equal(t.status, "done"); assert.equal(t.how, "runner stop"); assert.equal(t.runner, 4);
  const exp = 14 * 8.5 * 5 + 4 * (7800 - 7800.25) * 5;   // runner out at entry − 1 tick
  assert.equal(Math.round(t.grossUsd!), Math.round(exp));
});

test("long: runner trails 5R behind the best price once +5R, and is taken out on the trail", () => {
  // risk 4.25 · +5R = 7821.50 · best 7830.25 (+7R) → trail 7830.25 − 21.25 = 7809.00
  const t = simulateTrade(mk(), bars([[7800, 7809, 7799, 7808.5], [7808.5, 7830.25, 7808, 7829], [7829, 7829.5, 7808.5, 7809]]), LATE);
  assert.equal(t.how, "runner trail");
  const exp = 14 * 8.5 * 5 + 4 * (7808.75 - 7800.25) * 5;   // trail 7809.00 − 1 tick
  assert.equal(Math.round(t.grossUsd!), Math.round(exp));
  assert.ok(t.peakR! > 6.9 && t.peakR! < 7.1);
});

test("short mirrors: stop above, target below", () => {
  // fill 7799.75, stop 7804 → risk 4.25 → 18; +2R = 7791.25
  const t = simulateTrade(mk({ side: -1, stop: 7804 }), bars([[7800, 7801, 7798, 7799], [7799, 7799.5, 7791, 7792], [7792, 7800, 7791.5, 7799.5]]), LATE);
  assert.equal(t.how, "runner stop");
  assert.equal(Math.round(t.grossUsd!), Math.round(14 * 8.5 * 5 + 4 * -0.25 * 5));
});

test("a bar touching both stop and target is the stop; a gap through the stop fills at the open", () => {
  const both = simulateTrade(mk(), bars([[7800, 7801, 7799, 7800], [7800, 7810, 7795, 7800]]), LATE);
  assert.equal(both.how, "stop");
  const gap = simulateTrade(mk(), bars([[7800, 7801, 7799, 7800], [7790, 7791, 7789, 7790]]), LATE);
  assert.equal(gap.how, "stop");
  assert.equal(Math.round(gap.grossUsd!), Math.round((7789.75 - 7800.25) * 5 * 18));
});

test("too-wide stop is skipped with the reason; an open past the stop is skipped", () => {
  const wide = simulateTrade(mk({ symbol: "MGC", price: 4340, stop: 4290 }), bars([[4340, 4341, 4339, 4340]]), LATE);
  assert.equal(wide.status, "skipped"); assert.match(wide.skip!, /stop too wide/);
  const past = simulateTrade(mk(), bars([[7795, 7796, 7794, 7795]]), LATE);
  assert.equal(past.status, "skipped"); assert.match(past.skip!, /opened past the stop/);
});

test("still running when bars end → open (entered), also after the session when the feed never reached the close", () => {
  const b = bars([[7800, 7801, 7799, 7800.5], [7800.5, 7802, 7800, 7801]]);
  const live = simulateTrade(mk(), b, T + 20 * MIN);
  assert.equal(live.status, "open"); assert.equal(live.entered, true);
  assert.equal(simulateTrade(mk(), b, LATE).status, "open");
});

test("flat 5 minutes before the close (15:55 ET for the index micros)", () => {
  const at = Date.parse("2026-09-23T19:40:00Z");   // 15:40 ET bar → entry 15:45
  const b = bars(Array.from({ length: 15 }, () => [7800, 7801, 7799, 7800.5] as [number, number, number, number]), at + 5 * MIN);
  const t = simulateTrade(mk({ atMs: at }), b, LATE);
  assert.equal(t.how, "flat");
  assert.equal(t.exitMs, Date.parse("2026-09-23T19:54:00Z"));
});

// ---- the day ----
const winBars = (start: number): Bar[] => bars([[7800, 7801, 7799, 7800], [7800, 7809, 7800, 7808.9], [7808.9, 7809, 7800, 7800]], start);
const lossBars = (start: number): Bar[] => bars([[7800, 7801, 7799, 7800], [7800, 7800, 7795, 7795.5]], start);
function dayOf(kinds: ("win" | "loss")[], gapMin = 30) {
  const setups: Setup[] = [], all: Bar[] = [];
  kinds.forEach((k, i) => {
    const at = T + i * gapMin * MIN;
    setups.push(mk({ atMs: at }));
    all.push(...(k === "win" ? winBars(at + 5 * MIN) : lossBars(at + 5 * MIN)));
  });
  return { setups, bars: { MES: all } };
}

test("max 5 trades a day: the 6th setup is skipped", () => {
  const d = dayOf(["win", "win", "win", "win", "win", "win"]);
  const out = runPaperBot(d.setups, d.bars, new Map(), LATE);
  assert.deepEqual(out.map((t) => t.tradeNo ?? null), [1, 2, 3, 4, 5, null]);
  assert.equal(out[5].status, "skipped"); assert.match(out[5].skip!, /5 trades today/);
});

test("done after 2 losing trades", () => {
  const d = dayOf(["loss", "loss", "win"]);
  const out = runPaperBot(d.setups, d.bars, new Map(), LATE);
  assert.equal(out[2].status, "skipped"); assert.match(out[2].skip!, /2 losses today/);
});

test("10-minute cooldown after a loss; after a win there is none", () => {
  const d = dayOf(["loss", "win"], 8);        // next entry 8 min after the first → ~6 min after the loss exit
  assert.match(runPaperBot(d.setups, d.bars, new Map(), LATE)[1].skip ?? "", /cooldown/);
  const w = dayOf(["win", "win"], 8);
  const o = runPaperBot(w.setups, w.bars, new Map(), LATE);
  assert.equal(o[1].status, "done");
});

test("one position at a time: a setup while the previous trade is still running is skipped", () => {
  const s1 = mk(), s2 = mk({ atMs: T + 2 * MIN, symbol: "MNQ", price: 30700, stop: 30690 });
  const b = { MES: bars([[7800, 7801, 7799, 7800], [7800, 7802, 7799, 7801], [7801, 7802, 7800, 7801], [7801, 7802, 7800, 7801], [7801, 7802, 7800, 7801], [7801, 7802, 7795, 7796]]), MNQ: bars([[30700, 30701, 30699, 30700]], T + 7 * MIN) };
  const out = runPaperBot([s1, s2], b, new Map(), LATE);
  assert.equal(out[1].status, "skipped"); assert.match(out[1].skip!, /already in a trade/);
});

test("an undecided trade holds every later setup open (decisions keep the day's order)", () => {
  const s1 = mk(), s2 = mk({ atMs: T + 60 * MIN });
  // the first trade is still running (no stop, no target) right through the second setup's bars
  const b = { MES: bars(Array.from({ length: 65 }, () => [7800, 7801, 7799, 7800.5] as [number, number, number, number])) };
  const out = runPaperBot([s1, s2], b, new Map(), T + 70 * MIN);
  assert.equal(out[0].entered, true);
  assert.equal(out[0].status, "open"); assert.equal(out[1].status, "open");
});

test("settled rows are trusted as stored; their losses still count toward the day", () => {
  const d = dayOf(["win", "win", "win"]);
  const settled = new Map<string, Settled>([
    [d.setups[0].id, { id: d.setups[0].id, status: "done", entered: true, entryMs: T + 5 * MIN, exitMs: T + 7 * MIN, grossUsd: -300, tradeNo: 1 }],
    [d.setups[1].id, { id: d.setups[1].id, status: "done", entered: true, entryMs: T + 35 * MIN, exitMs: T + 37 * MIN, grossUsd: -300, tradeNo: 2 }],
  ]);
  const out = runPaperBot(d.setups, d.bars, settled, LATE);
  assert.equal(out[0].grossUsd, -300);
  assert.match(out[2].skip ?? "", /2 losses today/);
});

test("a breakeven scratch is not a loss", () => {
  // runner-only exit at entry − 1 tick after the sale at +2R is a winning trade overall; a pure scratch: gross 0
  const d = dayOf(["win", "win", "win"]);
  const settled = new Map<string, Settled>([[d.setups[0].id, { id: d.setups[0].id, status: "done", entered: true, exitMs: T + 7 * MIN, grossUsd: 0, tradeNo: 1 }],
    [d.setups[1].id, { id: d.setups[1].id, status: "done", entered: true, exitMs: T + 37 * MIN, grossUsd: 0, tradeNo: 2 }]]);
  assert.equal(runPaperBot(d.setups, d.bars, settled, LATE)[2].status, "done");
});

test("trading day starts 18:00 ET", () => {
  assert.equal(botDay(Date.parse("2026-09-23T21:59:00Z")), "2026-09-23");   // 17:59 ET
  assert.equal(botDay(Date.parse("2026-09-23T22:00:00Z")), "2026-09-24");   // 18:00 ET
});

test("Slack text says PAPER and no real order", () => {
  const t = simulateTrade(mk(), bars([[7800, 7801, 7799, 7800], [7800, 7800.5, 7795.5, 7796]]), LATE);
  assert.match(botEntryText({ ...t, tradeNo: 1 }), /PAPER bot · MES LONG 18 @ 7800\.25 · stop 7796\.00 \(risk \$383\) · trade 1 of 5 today · at \+2R sells 14, 4 ride · no real order/);
  assert.match(botExitText(t), /PAPER bot · MES long 18 closed \(stop\) · −\$4\d\d \(−1\.\d\dR after fees\)/);
  assert.match(botRecapText([{ usd: 100, status: "done" }], [{ usd: 100, status: "done" }, { usd: -50, status: "done" }], -200), /today: 1 trades \+\$100 \(you: −\$200\) · since start: 2 trades \+\$50 after fees · live only after 40\+ trades still positive \(2\/40\)/);
});

// ---- a runner at breakeven risks nothing: the next setup may be taken, but not in the same market ----
// MES wins at +2R on bar 2 (T+6) and its runner rides; flat bars after that keep it riding.
const riding = (n: number): Bar[] => bars([[7800, 7801, 7799, 7800], [7800.5, 7809, 7800.5, 7808.9], ...Array.from({ length: n }, () => [7808, 7809, 7806, 7808] as [number, number, number, number])]);

test("free runner: a setup in ANOTHER market is taken while the runner rides", () => {
  const s1 = mk(), s2 = mk({ atMs: T + 10 * MIN, symbol: "MNQ", price: 30700, stop: 30690 });
  const b = { MES: riding(40), MNQ: bars([[30700, 30701, 30699, 30700], [30700, 30700, 30680, 30681]], T + 15 * MIN) };
  const out = runPaperBot([s1, s2], b, new Map(), T + 60 * MIN);
  assert.equal(out[0].status, "open"); assert.ok(out[0].freeMs);
  assert.equal(out[1].status, "done"); assert.equal(out[1].tradeNo, 2);
});

test("free runner: a setup in the SAME market waits while the runner's exit is unknown, and is skipped once known to overlap", () => {
  const s1 = mk(), s2 = mk({ atMs: T + 10 * MIN });
  const waiting = runPaperBot([s1, s2], { MES: riding(40) }, new Map(), T + 60 * MIN);
  assert.equal(waiting[1].status, "open");
  const settled = new Map<string, Settled>([[s1.id, { id: s1.id, symbol: "MES", status: "done", entered: true, entryMs: T + 5 * MIN, freeMs: T + 6 * MIN, exitMs: T + 50 * MIN, grossUsd: 500, tradeNo: 1 }]]);
  const known = runPaperBot([s1, s2], { MES: riding(40) }, settled, LATE);
  assert.equal(known[1].status, "skipped"); assert.match(known[1].skip!, /MES runner still open/);
});

test("a trade still at risk blocks every market", () => {
  const s1 = mk(), s2 = mk({ atMs: T + 1 * MIN, symbol: "MNQ", price: 30700, stop: 30690 });
  const b = { MES: bars(Array.from({ length: 30 }, () => [7800, 7801, 7799, 7800] as [number, number, number, number])), MNQ: bars([[30700, 30701, 30699, 30700]], T + 6 * MIN) };
  const out = runPaperBot([s1, s2], b, new Map(), T + 30 * MIN);
  assert.equal(out[0].status, "open"); assert.equal(out[0].freeMs, undefined);
  assert.equal(out[1].status, "open");
});

// ---- review fixes ----
test("the +2R minute also trading back through entry stops the runner in that same minute", () => {
  const t = simulateTrade(mk(), bars([[7800, 7801, 7799, 7800], [7800, 7809, 7799, 7800], [7800, 7830, 7800, 7829]]), LATE);
  assert.equal(t.how, "runner stop");
  assert.equal(t.exitMs, T + 6 * MIN);
  assert.equal(Math.round(t.grossUsd!), Math.round(14 * 8.5 * 5 + 4 * -0.25 * 5));
});

test("a stalled feed never closes a trade at a stale price: open until bars come, no-data a day later", () => {
  const b = bars([[7800, 7801, 7799, 7800.5], [7800.5, 7802, 7800, 7801]]);   // bars stop at 10:07 ET
  assert.equal(simulateTrade(mk(), b, Date.parse("2026-09-23T21:00:00Z")).status, "open");        // 17:00 ET
  const later = simulateTrade(mk(), b, Date.parse("2026-09-25T00:00:00Z"));
  assert.equal(later.status, "no-data"); assert.equal(later.usd, undefined); assert.equal(later.entered, true); assert.equal(later.contracts, 18);
});

test("a setup that reached the server late is skipped, not decided out of order", () => {
  const d = dayOf(["win", "win"]);
  const out = runPaperBot(d.setups, d.bars, new Map(), LATE, new Set([d.setups[0].id]));
  assert.match(out[0].skip ?? "", /arrived late/);
  assert.equal(out[1].status, "done"); assert.equal(out[1].tradeNo, 1);
});
