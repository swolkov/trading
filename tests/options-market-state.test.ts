import assert from "node:assert/strict";
import test from "node:test";
import { indexState, intradayShock, marketState, marketVeto, vixLevel } from "../src/lib/options-market-state";
import { screenResearchContracts, type OptionsResearch, type ResearchBar, type ResearchContract } from "../src/lib/options-desk-model";

const now = Date.parse("2026-09-12T16:00:00Z");
/** 60 daily bars at 100, the last one closing at `lastClose` (its own day is the signal day). */
const spy = (lastClose: number, n = 60): ResearchBar[] => Array.from({ length: n }, (_, i) => {
  const c = i === n - 1 ? lastClose : 100;
  return { day: new Date(now - (n - i) * 86_400_000).toISOString().slice(0, 10), open: 100, high: Math.max(100, c), low: Math.min(100, c), close: c, volume: 1e6 };
});

test("index state: close vs the 20/50-day averages and the day's move; too few or stale bars are unknown", () => {
  const s = indexState(spy(98), now);
  assert.equal(s.regime, "below"); assert.equal(s.dayPct, -2); assert.equal(s.sma20, 99.9); assert.equal(s.sma50, 99.96); assert.equal(s.close, 98);
  assert.equal(indexState(spy(101.5), now).regime, "above");
  assert.equal(indexState(spy(98, 15), now).regime, "unknown");
  assert.equal(indexState(spy(98), now + 6 * 86_400_000).regime, "unknown");   // newest bar older than four days
  assert.equal(indexState(undefined, now).regime, "unknown");
  assert.equal(indexState(spy(98, 30), now).sma50, null);
});

test("the pre-registered veto: SPY below its 20-day AND −1.5% or worse refuses bullish single names, not bearish; −1.4% passes; ETFs and unknown never veto", () => {
  const down2 = marketState({ SPY: spy(98), QQQ: spy(99) }, 17.4, now);
  assert.equal(marketVeto(down2, "bullish", "SOFI").vetoed, true);
  assert.match(marketVeto(down2, "bullish", "SOFI").reason, /SPY below its 20-day \(98 vs 99.9\) and -2% on 2026-09-11 — bullish single-name entries refused/);
  assert.equal(marketVeto(down2, "bearish", "SOFI").vetoed, false); assert.equal(marketVeto(down2, "bearish", "SOFI").aligned, true);
  assert.equal(marketVeto(down2, "bullish", "SOFI").aligned, false);
  assert.equal(marketVeto(down2, "bullish", "SPY").vetoed, false); assert.match(marketVeto(down2, "bullish", "SPY").reason, /index ETF/);
  const down14 = marketState({ SPY: spy(98.6) }, null, now);
  assert.equal(down14.spy.regime, "below"); assert.equal(down14.spy.dayPct, -1.4); assert.equal(marketVeto(down14, "bullish", "SOFI").vetoed, false);
  const up2 = marketState({ SPY: spy(102) }, null, now);
  assert.equal(marketVeto(up2, "bearish", "SOFI").vetoed, true); assert.equal(marketVeto(up2, "bullish", "SOFI").vetoed, false);
  const unknown = marketState({}, null, now);
  assert.equal(unknown.alignedFor("bullish").vetoed, false); assert.equal(unknown.alignedFor("bullish").aligned, null); assert.match(unknown.alignedFor("bullish").reason, /unknown, no veto/);
  assert.equal(down2.vix, 17.4); assert.equal(marketState({}, Number.NaN, now).vix, null); assert.equal(down2.qqq.regime, "below");
});

test("intraday shock: a 1.5% SPY move against the trade refuses; smaller passes; no quote or a stale one stamps unknown/stale and never vetoes", () => {
  const q = (last: number, ageMin = 1) => ({ last, previousClose: 100, atMs: now - ageMin * 60_000 });
  assert.equal(intradayShock(q(98.4), "bullish", now).vetoed, true);
  assert.match(intradayShock(q(98.4), "bullish", now).reason, /SPY -1.6% intraday against a bullish entry/);
  assert.equal(intradayShock(q(98.4), "bearish", now).vetoed, false);
  assert.equal(intradayShock(q(98.6), "bullish", now).vetoed, false);
  assert.equal(intradayShock(q(101.5), "bearish", now).vetoed, true);
  const none = intradayShock(null, "bullish", now);
  assert.deepEqual([none.vetoed, none.movePct, none.stale], [false, null, false]); assert.match(none.reason, /quote unavailable/);
  const stale = intradayShock(q(98.4, 16), "bullish", now);                        // a 1.6% shock on a 16-minute-old quote is no shock
  assert.deepEqual([stale.vetoed, stale.movePct, stale.stale], [false, null, true]); assert.match(stale.reason, /quote is 16 min old — shock check skipped \(stamped stale\)/);
  assert.equal(intradayShock(q(98.4, 15), "bullish", now).vetoed, true);
  assert.equal(intradayShock(q(0), "bullish", now).vetoed, false);
});

test("VIX: the last Yahoo close, or null on an empty read, a throw or a hung read — never a made-up 20, never a stalled guard loop", async () => {
  assert.equal(await vixLevel(async () => [{ c: 15.1 }, { c: 18.27 }]), 18.27);
  assert.equal(await vixLevel(async () => []), null);
  assert.equal(await vixLevel(async () => { throw new Error("offline"); }), null);
  assert.equal(await vixLevel(async () => [{ c: 0 }]), null);
  const started = Date.now();
  assert.equal(await vixLevel(() => new Promise(() => {}), 25), null);   // never resolves → the timeout answers null
  assert.ok(Date.now() - started < 1000);
});

test("the screen stamps every candidate with the market state and its alignment, and stamps unknown when SPY bars are absent", () => {
  const bars = Array.from({ length: 201 }, (_, i) => ({ day: new Date(now - (201 - i) * 86400000).toISOString().slice(0, 10), open: 100, high: i === 200 ? 106 : 101, low: 99, close: i === 200 ? 105 : 100, volume: 1000000 }));
  const c: ResearchContract = { id: "a", symbol: "TEST", type: "call", strike: 105, expiry: "2026-10-16", multiplier: 100, bid: 0.85, ask: 0.9, bidSize: 10, askSize: 10, at: new Date(now).toISOString(), delta: 0.5, iv: 0.25, theta: -0.01, volume: 500, openInterest: 1000, selloutAt: null };
  const r: OptionsResearch = { source: "Robinhood MCP", capturedAt: new Date(now).toISOString(), bars: { TEST: bars, SPY: spy(98), QQQ: spy(101) }, contracts: [c], scans: [], errors: [],
    events: { TEST: { earningsAt: null, earningsTiming: null, calendarThrough: "2026-11-11", exDivAt: null, dividendAmount: null, at: new Date(now).toISOString() } } };
  const [cand] = screenResearchContracts(r, 100, 500, now, { vix: 19 });
  assert.equal(cand.market.spy.regime, "below"); assert.equal(cand.market.spy.dayPct, -2); assert.equal(cand.market.qqq.regime, "above"); assert.equal(cand.market.vix, 19); assert.equal(cand.market.aligned, false);
  delete r.bars.SPY;
  assert.equal(screenResearchContracts(r, 100, 500, now).map((x) => x.market.spy.regime)[0], "unknown"); assert.equal(screenResearchContracts(r, 100, 500, now)[0].market.aligned, null);
});
