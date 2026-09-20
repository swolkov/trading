import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FEED_KINDS, INSTRUMENTS, ORB_MINUTES, appendFeed, atr, buildLevels, etDayStartMs, etParts, exchangeDays, levelsFromChart, parseChartLevels, parseFeed, parseSettings, sizingFor, stopChoices, weeklyPrints,
  type Bar, type FeedEvent,
} from "../src/lib/trading-room-rules";

// A synthetic week of 5-minute bars in ET: Sunday 18:00 → Friday 17:00, price drifting up 0.25/bar.
function bars(from: string, to: string, start = 6500): Bar[] {
  const out: Bar[] = [];
  let px = start;
  for (let t = Date.parse(from); t < Date.parse(to); t += 5 * 60_000) {
    const p = etParts(t);
    if (p.hourFrac >= 17 && p.hourFrac < 18) continue;          // the CME break
    if (p.weekday === 6 || (p.weekday === 0 && p.hourFrac < 18) || (p.weekday === 5 && p.hourFrac >= 17)) continue;
    px += 0.25;
    out.push({ t, o: px - 0.25, h: px + 1, l: px - 1, c: px, v: 100 });
  }
  return out;
}
// Mon Sep 14 2026 18:00 ET = 22:00Z (EDT)
const WEEK_FROM = "2026-09-13T22:00:00Z", WEEK_TO = "2026-09-18T21:00:00Z";

test("ET clock: exchange-day grouping and day-start instants respect DST", () => {
  assert.equal(etParts(Date.parse("2026-09-15T13:30:00Z")).hhmm, "09:30");
  assert.equal(etDayStartMs("2026-09-15", 9.5), Date.parse("2026-09-15T13:30:00Z"));
  assert.equal(etDayStartMs("2026-12-15", 9.5), Date.parse("2026-12-15T14:30:00Z"));   // EST
  const days = exchangeDays(bars(WEEK_FROM, WEEK_TO));
  assert.deepEqual(days.map((d) => d.dayKey), ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]);
  // A bar at 18:05 ET Monday belongs to Tuesday's exchange day.
  assert.equal(days[1].bars[0] && etParts(days[1].bars[0].t).hhmm, "18:00");
});

test("levels: prior day, overnight, week, opening range and VWAP from a Tuesday 10:00 ET vantage", () => {
  const all = bars(WEEK_FROM, WEEK_TO);
  const now = Date.parse("2026-09-15T14:00:00Z");   // Tue 10:00 ET
  const lv = buildLevels(INSTRUMENTS.MES, all, [], now);
  assert.ok(lv.priorDay && lv.priorDay.dayKey === "2026-09-14");
  const monday = exchangeDays(all).find((d) => d.dayKey === "2026-09-14")!;
  assert.equal(lv.priorDay!.high, Math.max(...monday.bars.map((b) => b.h)));
  assert.equal(lv.priorDay!.close, monday.bars[monday.bars.length - 1].c);
  // Overnight = Monday 16:00 ET → Tuesday 09:30 ET, complete at 10:00.
  assert.ok(lv.overnight?.complete);
  const onBars = all.filter((b) => b.t >= Date.parse("2026-09-14T20:00:00Z") && b.t < Date.parse("2026-09-15T13:30:00Z"));
  assert.equal(lv.overnight!.high, Math.max(...onBars.map((b) => b.h)));
  // Opening range = 09:30–09:45, complete; three 5-minute bars.
  assert.ok(lv.openingRange?.complete);
  const orBars = all.filter((b) => b.t >= Date.parse("2026-09-15T13:30:00Z") && b.t < Date.parse("2026-09-15T13:30:00Z") + ORB_MINUTES * 60_000);
  assert.equal(orBars.length, 3);
  assert.equal(lv.openingRange!.high, Math.max(...orBars.map((b) => b.h)));
  // Week high = the running high since Sunday 18:00 — the last bar's high in a rising tape.
  const upTo = all.filter((b) => b.t <= now);
  assert.equal(lv.week!.high, upTo[upTo.length - 1].h);
  assert.ok(lv.vwap != null && lv.vwap > 0);
  assert.ok(lv.distances.some((d) => d.level === `OR${ORB_MINUTES} high`));
  assert.equal(lv.last, upTo[upTo.length - 1].c);
});

test("levels: before the open the range is forming and the overnight is still running", () => {
  const all = bars(WEEK_FROM, WEEK_TO);
  const now = Date.parse("2026-09-15T12:00:00Z");   // Tue 08:00 ET
  const lv = buildLevels(INSTRUMENTS.MES, all, [], now);
  assert.equal(lv.openingRange, null);
  assert.ok(lv.overnight && lv.overnight.complete === false);
  assert.ok(!lv.distances.some((d) => d.level.startsWith("OR")));
});

test("gold's opening range anchors at 08:20, not 09:30", () => {
  const all = bars(WEEK_FROM, WEEK_TO, 3700);
  const now = Date.parse("2026-09-15T13:00:00Z");   // Tue 09:00 ET
  const lv = buildLevels(INSTRUMENTS.MGC, all, [], now);
  assert.ok(lv.openingRange?.complete, "08:20–08:35 is complete by 09:00");
  const orBars = all.filter((b) => b.t >= Date.parse("2026-09-15T12:20:00Z") && b.t < Date.parse("2026-09-15T12:35:00Z"));
  assert.equal(lv.openingRange!.low, Math.min(...orBars.map((b) => b.l)));
});

test("ATR and the three stop widths, tick-rounded and priced at his size", () => {
  const daily: Bar[] = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 100, h: 110, l: 90, c: 100, v: 1 }));
  assert.equal(atr(daily), 20);
  const choices = stopChoices(INSTRUMENTS.MES, { atr5m: 2.1, atrDaily: 40 }, 20);
  assert.deepEqual(choices.map((c) => [c.name, c.stopPts, c.riskUsd]), [["tight", 2, 200], ["normal", 4.25, 425], ["wide", 10, 1000]]);
  const mgc = stopChoices(INSTRUMENTS.MGC, { atr5m: 1.94, atrDaily: 40 }, 20);
  assert.deepEqual(mgc.map((c) => [c.name, c.stopPts, c.riskUsd]), [["tight", 1.9, 380], ["normal", 3.9, 780], ["wide", 10, 2000]]);
  assert.deepEqual(stopChoices(INSTRUMENTS.MES, { atr5m: null, atrDaily: null }, 20), []);
});

test("sizing: his size, priced at three stop widths — never a percentage of the account", () => {
  const lv = { atr5m: 2, atrDaily: 40 } as Parameters<typeof sizingFor>[1];
  const s1 = sizingFor(INSTRUMENTS.MES, lv, parseSettings(JSON.stringify({ contracts: 20 })));
  assert.equal(s1.contracts, 20); assert.equal(s1.perPointUsd, 100);
  assert.deepEqual(s1.choices.map((c) => [c.name, c.stopPts, c.riskUsd]), [["tight", 2, 200], ["normal", 4, 400], ["wide", 10, 1000]]);
  const s2 = sizingFor(INSTRUMENTS.MGC, { atr5m: 3.6, atrDaily: 111.5 } as Parameters<typeof sizingFor>[1], parseSettings(null));
  assert.equal(s2.perPointUsd, 200); assert.equal(s2.choices[0].stopPts, 3.6); assert.equal(s2.choices[0].riskUsd, 720);
  assert.equal(stopChoices(INSTRUMENTS.MES, { atr5m: null, atrDaily: null }, 20).length, 0);
});

test("settings parse clamps and ignores garbage", () => {
  assert.deepEqual(parseSettings(null), { contracts: 20, dailyLossUsd: null, maxTradesPerDay: null });
  assert.deepEqual(parseSettings("{bad"), { contracts: 20, dailyLossUsd: null, maxTradesPerDay: null });
  assert.deepEqual(parseSettings(JSON.stringify({ contracts: -5, dailyLossUsd: "x" })), { contracts: 20, dailyLossUsd: null, maxTradesPerDay: null });
  assert.deepEqual(parseSettings(JSON.stringify({ contracts: 25.4, dailyLossUsd: 500, maxTradesPerDay: 6.2, accountUsd: 3000 })), { contracts: 25, dailyLossUsd: 500, maxTradesPerDay: 6 });
});

test("the tape: the chart's JSON is parsed strictly, micro and full-size roots map to the room's symbol, retries dedupe", () => {
  const now = Date.parse("2026-09-15T14:05:00Z");
  const ok = parseFeed({ secret: "x", room: "trading", symbol: "NQ", kind: "or_up", price: "24810.25", level: 24800, atr: 31.2, volRatio: 1.8, bar: 1758290700000, tf: "5" }, now);
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.event.symbol, "MNQ");
  assert.equal(ok.ok && ok.event.at, new Date(1758290700000).toISOString());
  assert.equal(ok.ok && ok.event.price, 24810.25);
  assert.equal(parseFeed({ room: "trading", symbol: "CL", kind: "or_up", price: 1 }, now).ok, false);
  assert.equal(parseFeed({ room: "trading", symbol: "MES", kind: "moon", price: 1 }, now).ok, false);
  assert.equal(parseFeed({ room: "futures", symbol: "MES", kind: "or_up", price: 1 }, now).ok, false);
  assert.equal(parseFeed({ room: "trading", symbol: "MES", kind: "or_up" }, now).ok, false);
  const e = (ok as { ok: true; event: FeedEvent }).event;
  const a = appendFeed([], e);
  assert.equal(a.feed.length, 1);
  const b = appendFeed(a.feed, { ...e, receivedAt: "later" });
  assert.equal(b.duplicate, true);
  assert.equal(b.feed.length, 1);
  assert.equal(FEED_KINDS.length, 10);
});

test("the chart's level set becomes the card: parsed strictly, distances in daily ATR, OR hidden until formed", () => {
  const now = Date.parse("2026-09-15T14:05:00Z");
  const body = { secret: "x", room: "trading", kind: "levels", symbol: "MES", price: 6540.25, pdh: 6550, pdl: 6490, pdc: 6520, onh: 6545, onl: 6510, wh: 6560, wl: 6480, orh: 6538, orl: 6528, orDone: "true", vwap: 6531.5, atr: 3.1, atrD: 60, bar: 1758290700000, tf: "5" };
  const p = parseChartLevels(body, now);
  assert.ok(p.ok);
  const lv = levelsFromChart(INSTRUMENTS.MES, (p as { ok: true; levels: Parameters<typeof levelsFromChart>[1] }).levels, now);
  assert.equal(lv.source, "chart");
  assert.equal(lv.last, 6540.25);
  assert.equal(lv.priorDay?.high, 6550);
  assert.ok(lv.openingRange?.complete);
  const pdh = lv.distances.find((d) => d.level === "Prior-day high")!;
  assert.equal(pdh.pts, 6540.25 - 6550);
  assert.equal(pdh.atrs, (6540.25 - 6550) / 60);
  assert.ok(lv.distances.some((d) => d.level === `OR${ORB_MINUTES} high`));
  const forming = parseChartLevels({ ...body, orDone: false }, now);
  assert.ok(forming.ok && !levelsFromChart(INSTRUMENTS.MES, forming.levels, now).distances.some((d) => d.level.startsWith("OR")));
  assert.equal(parseChartLevels({ ...body, kind: "or_up" }, now).ok, false);
  assert.equal(parseChartLevels({ ...body, price: 0 }, now).ok, false);
  assert.equal(parseChartLevels({ ...body, symbol: "CL" }, now).ok, false);
});

test("the news clock: initial claims land every Thursday 08:30 ET", () => {
  const w = weeklyPrints(Date.parse("2026-09-14T12:00:00Z"), 7);
  assert.equal(w.length, 1);
  assert.equal(etParts(w[0].atMs).hhmm, "08:30");
  assert.equal(etParts(w[0].atMs).weekday, 4);
});

test("the Pine study posts exactly the kinds the room accepts, with the room's own JSON shape", () => {
  const pine = readFileSync(new URL("../pine/trading-room-levels.pine", import.meta.url), "utf8");
  for (const k of FEED_KINDS) assert.ok(pine.includes(`"${k}"`), `pine posts ${k}`);
  assert.ok(pine.includes('"room":"trading"'));
  assert.ok(pine.includes('"kind":"levels"'), "pine posts the level set");
  for (const field of ['"pdh":', '"onh":', '"wh":', '"orh":', '"orDone":', '"vwap":', '"atrD":']) assert.ok(pine.includes(field), field);
  for (const field of ['"symbol":"', '"kind":"', '"price":', '"level":', '"atr":', '"volRatio":', '"bar":', '"tf":"']) assert.ok(pine.includes(field), field);
  assert.ok(pine.includes("/api/webhook/trading-room"));
});
