// E10 — smoke tests for the pre-registered prompt families: every family fires on a synthetic
// session series, never emits NaN or a non-positive risk parameter, respects the roll guard, and
// the replay charges slippage AGAINST the trader on both sides.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PROMPT_FAMILY_CANDIDATES, liquiditySweepReversal, maContinuation, orbContinuation, overnightRangeBreak, pdhPdlBreak,
  rangeExpansionMomentum, vwapDeviationMr, vwapReclaim,
} from "../src/lib/edge-factory/candidates";
import { aggregateBars } from "../src/lib/edge-factory/data";
import { replayCandidateDetailed } from "../src/lib/edge-factory/replay";
import { RTH_OPEN, overnightRange, priorRthRange, rthOpenIndex, sessionVwap } from "../src/lib/edge-factory/session";
import { edgeStatistics } from "../src/lib/edge-factory/validation";
import type { EdgeCandidate, EdgeSignal, MarketSpec, ResearchBar } from "../src/lib/edge-factory/types";

// January 2025: New York is UTC−5 all month, so 09:30 ET = 14:30Z without a DST edge in the fixture.
const ET_OFFSET_MS = 5 * 3600_000;
function etMs(day: number, hour: number, minute: number): number { return Date.UTC(2025, 0, day, hour, minute) + ET_OFFSET_MS; }

/** A deterministic Globex week-day series on 5-minute bars: 18:00 ET (prior day) → 17:00 ET, `days`
 *  trading days, a seeded random walk with a per-day drift and an occasional wide, heavy bar. */
function syntheticFiveMinute(days: number, seed = 7, instrumentId = "1"): ResearchBar[] {
  let state = seed >>> 0;
  const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  const bars: ResearchBar[] = [];
  let price = 5000;
  let day = 6;   // Mon Jan 6 2025
  for (let d = 0; d < days; d++, day++) {
    if (new Date(Date.UTC(2025, 0, day)).getUTCDay() === 6) day += 2;   // skip the weekend
    const drift = (rand() - 0.45) * 0.6;
    // Globex session for this ET date: 18:00 the day before through 16:55 today.
    for (let minutes = -6 * 60; minutes < 17 * 60; minutes += 5) {
      const t = etMs(day, 0, 0) + minutes * 60_000;
      const wide = bars.length % 37 === 0;
      // Every seventh day carries one shock hour (10:00–10:55 ET), alternating in sign, on heavy volume.
      const shock = d % 7 === 3 && minutes >= 10 * 60 && minutes < 11 * 60 ? (d % 2 ? -6 : 6) : 0;
      const move = (rand() - 0.5) * (wide ? 12 : 4) + drift + shock;
      const o = price, c = price + move;
      const h = Math.max(o, c) + rand() * (wide ? 4 : 1.5), l = Math.min(o, c) - rand() * (wide ? 4 : 1.5);
      bars.push({ t, o, h, l, c, v: shock ? 5000 : wide ? 4000 : 800 + Math.floor(rand() * 400), instrumentId });
      price = c;
    }
  }
  return bars;
}

const market: MarketSpec = {
  symbol: "ES", tradedSymbol: "MES", pointValue: 5, tickSize: 0.25,
  commissionRoundTurn: 2.02, entrySlippagePoints: 0.25, exitSlippagePoints: 0.25, slippageSource: "assumed",
};

function signalsOf(candidate: EdgeCandidate, bars: readonly ResearchBar[]): EdgeSignal[] {
  const out: EdgeSignal[] = [];
  for (let i = candidate.minimumHistory; i < bars.length; i++) { const s = candidate.evaluate(bars, i); if (s) out.push(s); }
  return out;
}

const five = syntheticFiveMinute(40);
const series: Record<number, ResearchBar[]> = { 5: five, 15: aggregateBars(five, 15), 60: aggregateBars(five, 60) };

test("every pre-registered family fires on the synthetic series with finite, positive risk parameters", () => {
  const families = new Set<string>();
  for (const candidate of PROMPT_FAMILY_CANDIDATES) {
    const signals = signalsOf(candidate, series[candidate.barMinutes]);
    assert.ok(signals.length > 0, `${candidate.key} produced no signals`);
    for (const s of signals) {
      assert.equal(s.edgeKey, candidate.key);
      assert.ok(Number.isFinite(s.stopDistance) && s.stopDistance > 0, `${candidate.key} stop ${s.stopDistance}`);
      assert.ok(Number.isFinite(s.targetDistance) && s.targetDistance > 0, `${candidate.key} target ${s.targetDistance}`);
      assert.ok(Number.isInteger(s.maxHoldBars) && s.maxHoldBars >= 1, `${candidate.key} hold ${s.maxHoldBars}`);
      assert.ok(s.direction === "long" || s.direction === "short");
    }
    families.add(candidate.family);
  }
  assert.deepEqual([...families].sort(), ["liquidity_sweep_reversal", "ma_continuation", "orb_continuation", "overnight_range_break", "pdh_pdl_break", "range_expansion_momentum", "vwap_deviation_mr", "vwap_reclaim"]);
});

test("session families fire only inside their stated ET windows and once per day where the rule says first break", () => {
  const tod = (t: number) => { const d = new Date(t - ET_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const dayOf = (t: number) => new Date(t - ET_OFFSET_MS).toISOString().slice(0, 10);
  const orb = orbContinuation(15, 2);
  const days = new Set<string>();
  for (let i = orb.minimumHistory; i < five.length; i++) {
    const s = orb.evaluate(five, i);
    if (!s) continue;
    const at = tod(five[i].t);
    assert.ok(at >= RTH_OPEN + 15 && at < 11 * 60 + 30, `ORB fired at ${at}`);
    const key = dayOf(five[i].t);
    assert.ok(!days.has(key), `ORB fired twice on ${key}`);
    days.add(key);
  }
  for (const c of [vwapReclaim(3, 2.5), vwapDeviationMr(2)]) {
    for (let i = c.minimumHistory; i < five.length; i++) if (c.evaluate(five, i)) assert.ok(tod(five[i].t) >= 10 * 60 && tod(five[i].t) < 15 * 60 + 30, `${c.key} fired at ${tod(five[i].t)}`);
  }
  for (const c of [pdhPdlBreak(2), overnightRangeBreak(2)]) {
    const seen = new Set<string>();
    for (let i = c.minimumHistory; i < series[15].length; i++) {
      if (!c.evaluate(series[15], i)) continue;
      const at = tod(series[15][i].t);
      assert.ok(at >= RTH_OPEN && at < 15 * 60 + 45, `${c.key} fired at ${at}`);
      const key = dayOf(series[15][i].t);
      assert.ok(!seen.has(key), `${c.key} fired twice on ${key}`);
      seen.add(key);
    }
  }
});

test("a time stop for a session trade never reaches past 16:00 ET", () => {
  const orb = orbContinuation(5, 2);
  for (let i = orb.minimumHistory; i < five.length; i++) {
    const s = orb.evaluate(five, i);
    if (!s) continue;
    const tod = new Date(five[i].t - ET_OFFSET_MS).getUTCHours() * 60 + new Date(five[i].t - ET_OFFSET_MS).getUTCMinutes();
    assert.ok(tod + s.maxHoldBars * 5 <= 16 * 60, `hold ${s.maxHoldBars} from ${tod}`);
  }
});

test("the replay charges slippage against the trader on entry for both directions", () => {
  for (const candidate of [liquiditySweepReversal(20), rangeExpansionMomentum(2, 2.5), maContinuation(2.5)]) {
    const bars = series[candidate.barMinutes];
    const replay = replayCandidateDetailed(bars, candidate, market);
    assert.ok(replay.trades.length > 0, `${candidate.key} produced no trades`);
    assert.equal(replay.diagnostics.invalidSignals, 0);
    let longs = 0, shorts = 0;
    for (const trade of replay.trades) {
      const entryBar = bars.find((b) => b.t === trade.entryTime)!;
      if (trade.direction === "long") { assert.ok(trade.entryPrice >= entryBar.o, "a long filled below the open"); longs++; }
      else { assert.ok(trade.entryPrice <= entryBar.o, "a short filled above the open"); shorts++; }
      assert.ok(Number.isFinite(trade.pnl) && Number.isFinite(trade.rMultiple));
    }
    assert.ok(longs > 0 && shorts > 0, `${candidate.key} is not two-sided on the fixture (${longs}/${shorts})`);
  }
});

test("families refuse to read across a contract roll inside their lookback", () => {
  const rolled = five.map((b, i) => (i < 2000 ? { ...b, instrumentId: "old" } : b));
  for (const candidate of PROMPT_FAMILY_CANDIDATES) {
    const bars = aggregateBars(rolled, candidate.barMinutes);
    const rollAt = bars.findIndex((b) => b.instrumentId !== "old");
    for (let i = rollAt; i < Math.min(bars.length, rollAt + 20); i++) assert.equal(candidate.evaluate(bars, i), null, `${candidate.key} fired at ${i - rollAt} bars after a roll`);
  }
});

test("session helpers: the 09:30 bar, the prior RTH range, the overnight range and the session VWAP", () => {
  const openBars = five.map((b, i) => ({ b, i })).filter(({ b }) => (b.t - ET_OFFSET_MS) % 86_400_000 === RTH_OPEN * 60_000);
  const { i: open } = openBars[1];
  assert.equal(rthOpenIndex(five, open + 10, 120), open);
  assert.equal(rthOpenIndex(five, open - 1, 120), -1, "a bar before the open has no open bar");
  const prior = priorRthRange(five, open, 400)!;
  assert.ok(prior && prior.startIndex === openBars[0].i, "the prior RTH range starts at the prior day's 09:30 bar");
  assert.equal(prior.endIndex - prior.startIndex + 1, 78, "6.5 hours of 5-minute bars");
  assert.ok(prior.high >= prior.low && prior.high === Math.max(...five.slice(prior.startIndex, prior.endIndex + 1).map((b) => b.h)));
  const overnight = overnightRange(five, open, 400, 20)!;
  assert.equal(overnight.endIndex, open - 1);
  assert.equal(overnight.startIndex, prior.endIndex + 1 + 12, "overnight starts at 18:00 — after the 16:00–16:55 post-close bars");
  const v = sessionVwap(five, open, open + 5)!;
  const slice = five.slice(open, open + 6);
  const expected = slice.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * b.v, 0) / slice.reduce((s, b) => s + b.v, 0);
  assert.ok(Math.abs(v.vwap - expected) < 1e-9 && v.sigma >= 0);
  assert.equal(sessionVwap(five.map((b) => ({ ...b, v: 0 })), open, open + 5), null, "no volume, no VWAP");
});

test("edge statistics carry a 95% confidence interval around the mean R", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    edgeKey: "x", version: "1", symbol: "MES", direction: "long" as const, signalTime: i, entryTime: i, exitTime: i + 1,
    entryPrice: 1, exitPrice: 1, stopDistance: 1, pnl: i % 2 ? 1 : -1, rMultiple: i % 2 ? 1 : -1, exitReason: "stop" as const,
  }));
  const s = edgeStatistics(rows);
  assert.equal(s.expectancyR, 0);
  assert.ok(Math.abs(s.expectancyCi95[0] + 0.197) < 0.001 && Math.abs(s.expectancyCi95[1] - 0.197) < 0.001);
  assert.deepEqual(edgeStatistics([]).expectancyCi95, [0, 0]);
});

test("every prompt candidate is pre-registered in the trials ledger before it can run", () => {
  const ledger = JSON.parse(fs.readFileSync(path.resolve("research/edge-factory-trials.json"), "utf8")) as { formatVersion: number; preRegistered: { family: string; candidates: string[]; barMinutes: number; registeredAt: string; expectation: string; hypothesis: string; markets: string[] }[] };
  assert.equal(ledger.formatVersion, 2);
  for (const c of PROMPT_FAMILY_CANDIDATES) {
    const reg = ledger.preRegistered.find((r) => r.family === c.family);
    assert.ok(reg, `${c.family} is not pre-registered`);
    assert.ok(reg.candidates.includes(c.key), `${c.key} is not in the ${c.family} registration`);
    assert.equal(reg.barMinutes, c.barMinutes);
    assert.ok(!Number.isNaN(Date.parse(reg.registeredAt)) && reg.expectation.length > 20 && reg.hypothesis.length > 20);
    assert.deepEqual(reg.markets, ["ES", "NQ", "GC", "YM", "SI", "HG"]);
  }
});
