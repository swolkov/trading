import test from "node:test";
import assert from "node:assert/strict";
import { compoundRMultiples, requiredExpectancyR } from "../src/lib/account-growth";
import { slowTrendBreakout } from "../src/lib/edge-factory/candidates";
import { replayCandidate, replayCandidateDetailed } from "../src/lib/edge-factory/replay";
import { oneSidedStudentTPValue, validateCandidate } from "../src/lib/edge-factory/validation";
import { cappedContractLimit, isFreshPositiveEquity, nonNegativeConfigNumber } from "../src/lib/risk-sizing";
import type { EdgeCandidate, MarketSpec, ReplayTrade, ResearchBar } from "../src/lib/edge-factory/types";

const market: MarketSpec = {
  symbol: "ES", tradedSymbol: "MES", pointValue: 5, tickSize: 0.25,
  commissionRoundTurn: 2, entrySlippagePoints: 1, exitSlippagePoints: 0.25,
};

const candidate: EdgeCandidate = {
  key: "test_edge", version: "1", family: "compression_breakout", minimumHistory: 1,
  evaluate: (_bars, index) => index === 1 || index === 2
    ? { edgeKey: "test_edge", version: "1", direction: "long", stopDistance: 2, targetDistance: 4, maxHoldBars: 3, rationale: "test" }
    : null,
};

function bar(t: number, o: number, h: number, l: number, c: number, instrumentId = "1"): ResearchBar {
  return { t, o, h, l, c, v: 100, instrumentId };
}

test("replay enters on the next bar and prevents overlapping trades", () => {
  const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 102, 104, 102, 103), bar(3, 103, 108, 103, 107), bar(4, 107, 108, 106, 107)];
  const trades = replayCandidate(bars, candidate, market);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryTime, 2);
  assert.equal(trades[0].entryPrice, 103);
  assert.equal(trades[0].exitReason, "target");
});

test("a one-tick target touch is not treated as a guaranteed limit fill", () => {
  const noSlip = { ...market, entrySlippagePoints: 0, exitSlippagePoints: 0 };
  const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 104, 100, 103), bar(4, 103, 103, 102, 102)];
  const [trade] = replayCandidate(bars, candidate, noSlip);
  assert.equal(trade.exitReason, "time");
});

test("maxHoldBars counts the entry bar instead of granting one extra bar", () => {
  const oneBar: EdgeCandidate = {
    ...candidate,
    evaluate: (_bars, index) => index === 1
      ? { edgeKey: "test_edge", version: "1", direction: "long", stopDistance: 20, targetDistance: 40, maxHoldBars: 1, rationale: "test" }
      : null,
  };
  const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100), bar(3, 110, 112, 109, 111)];
  const [trade] = replayCandidate(bars, oneBar, { ...market, entrySlippagePoints: 0, exitSlippagePoints: 0 });
  assert.equal(trade.exitTime, 2);
});

test("replay refuses a signal that crosses a contract roll", () => {
  const bars = [bar(0, 100, 101, 99, 100, "old"), bar(1, 100, 101, 99, 100, "old"), bar(2, 110, 112, 109, 111, "new")];
  assert.equal(replayCandidate(bars, candidate, market).length, 0);
});

test("replay refuses to invent a retroactive exit when an open trade reaches a roll", () => {
  const wideStop: EdgeCandidate = {
    ...candidate,
    evaluate: (_bars, index) => index === 1
      ? { edgeKey: "test_edge", version: "1", direction: "long", stopDistance: 20, targetDistance: 40, maxHoldBars: 3, rationale: "test" }
      : null,
  };
  const bars = [bar(0, 100, 101, 99, 100, "old"), bar(1, 100, 101, 99, 100, "old"), bar(2, 100, 101, 99, 100, "old"), bar(3, 110, 112, 109, 111, "new")];
  const replay = replayCandidateDetailed(bars, wideStop, { ...market, entrySlippagePoints: 0 });
  assert.equal(replay.trades.length, 0);
  assert.equal(replay.diagnostics.rollInterruptedTrades, 1);
});

test("candidate indicators reject a contract change anywhere inside their lookback", () => {
  const bars = Array.from({ length: 102 }, (_, index) => bar(index, 100, 101, 99, 100, "new"));
  bars[99] = bar(99, 100, 101, 99, 100, "old");
  bars[100] = bar(100, 109, 111, 108, 110, "new");
  assert.equal(slowTrendBreakout(3, 2.5).evaluate(bars, 100), null);
});

test("replay reports an entry estimate outside the observed bar instead of fabricating a fill", () => {
  const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 100.5, 99.5, 100)];
  const replay = replayCandidateDetailed(bars, candidate, market);
  assert.equal(replay.trades.length, 0);
  assert.equal(replay.diagnostics.unpriceableEntries, 1);
});

test("validation rejects research with unpriceable historical entries", () => {
  const rows = Array.from({ length: 160 }, (_, index) => trade(index, 0.5));
  const verdict = validateCandidate(rows, 1, {
    diagnostics: { signals: 161, invalidSignals: 0, unpriceableEntries: 1, rollCrossingEntries: 0, rollInterruptedTrades: 0 },
  });
  assert.equal(verdict.status, "reject");
  assert.ok(verdict.reasons.some((reason) => reason.includes("slippage exceeded")));
});

function trade(index: number, rMultiple: number): ReplayTrade {
  return {
    edgeKey: "x", version: "1", symbol: "MES", direction: "long",
    signalTime: index * 2_000_000, entryTime: index * 2_000_000 + 1,
    exitTime: index * 2_000_000 + 2, entryPrice: 100, exitPrice: 101,
    stopDistance: 1, pnl: rMultiple * 100, rMultiple,
    exitReason: rMultiple > 0 ? "target" : "stop",
  };
}

test("validation cannot promote a small or holdout-negative sample", () => {
  const small = Array.from({ length: 40 }, (_, index) => trade(index, 0.5));
  assert.equal(validateCandidate(small, 1).status, "reject");
  const decays = Array.from({ length: 160 }, (_, index) => trade(index, index < 130 ? 0.2 : -1));
  const verdict = validateCandidate(decays, 1);
  assert.notEqual(verdict.status, "demo_candidate");
  assert.ok(verdict.reasons.some((reason) => reason.includes("development and evaluation")));
});

test("historical validation can never label its own result demo-ready", () => {
  const rows = Array.from({ length: 200 }, (_, index) => trade(index, index % 4 === 0 ? -0.5 : 0.5));
  assert.ok(["reject", "research"].includes(validateCandidate(rows, 1).status));
});

test("research status requires every stated statistical gate", () => {
  const rows = Array.from({ length: 200 }, (_, index) => trade(index, index % 2 === 0 ? 1 : -0.9));
  const verdict = validateCandidate(rows, 42);
  assert.equal(verdict.status, "reject");
  assert.ok(verdict.reasons.some((reason) => reason.includes("adjusted significance")));
});

test("operator and aggregate contract limits remain hard ceilings", () => {
  assert.equal(cappedContractLimit(1, 3, 8, 0), 1);
  assert.equal(cappedContractLimit(4, 4, 4, 3), 1);
  assert.equal(cappedContractLimit(4, 4, 4, 4), 0);
});

test("operator zero risk settings remain zero instead of falling back to live defaults", () => {
  assert.equal(nonNegativeConfigNumber("0", 5), 0);
  assert.equal(nonNegativeConfigNumber(undefined, 5), 5);
  assert.equal(nonNegativeConfigNumber("invalid", 5), 5);
  assert.equal(nonNegativeConfigNumber("-1", 5), 5);
});

test("stale or future-dated equity is never usable", () => {
  const now = 1_000_000;
  assert.equal(isFreshPositiveEquity(4_000, now - 60_000, now, 180_000), true);
  assert.equal(isFreshPositiveEquity(4_000, now - 181_000, now, 180_000), false);
  assert.equal(isFreshPositiveEquity(4_000, now + 1, now, 180_000), false);
});

test("finite-sample significance uses the Student t tail", () => {
  const p = oneSidedStudentTPValue(3.1, 99);
  assert.ok(p > 0.001 && p < 0.002);
});

test("account growth compounds each real-fill R against current equity", () => {
  const result = compoundRMultiples(1_000, 0.1, [1, -1]);
  assert.equal(result.endingEquity, 990);
  assert.equal(result.killed, false);
});

test("weekly income target is translated into required expectancy", () => {
  assert.equal(requiredExpectancyR(2_000, 4_000, 0.05, 5), 2);
});
