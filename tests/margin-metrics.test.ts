import assert from "node:assert/strict";
import test from "node:test";
import {
  R_BUCKETS,
  longestLossStreak,
  maxDrawdown,
  rMultiple,
  rollingVerdict,
  sleeveMetrics,
  welchT,
  type SleeveRow,
} from "../src/lib/margin-metrics";

// The leaderboard's arithmetic on synthetic rows. Every number here is one the promotion
// gate or the decay rule reads, so the conventions (PF ∞, fee-inclusive R, null below a
// week) are pinned, not implied.

const T0 = Date.parse("2026-09-01T00:00:00Z");
/** Rows in resolve order; `pnl` is fee-inclusive, riskUsd = 100 so R = pnl/100. */
function rows(pnls: number[], o: { spacingH?: number; riskUsd?: number; trough?: boolean; peak?: boolean } = {}): SleeveRow[] {
  const spacingH = o.spacingH ?? 6;
  return pnls.map((pnl, i) => {
    const entryMs = T0 + i * spacingH * 3600_000;
    const entry = 100;
    const oneR = 4;   // 4% stop
    return {
      id: i + 1, source: "swing-pyr", side: "buy",
      time: new Date(entryMs).toISOString(), resolvedAt: new Date(entryMs + 4 * 3600_000).toISOString(),
      entry, exit: entry + pnl / 25, pnl, livePnl: pnl, fees: 5,
      notional: 2500, riskUsd: o.riskUsd ?? 100,
      peak: o.peak === false ? null : entry + Math.max(0, pnl / 25) + 1,
      trough: o.trough ? entry - 2 : null,
      oneR, reason: pnl > 0 ? "trailing stop" : "stop", conviction: "high",
    };
  });
}

test("alternating +2R / −1R → PF 2, hit 0.5, avg R 0.5, expectancy after costs", () => {
  const m = sleeveMetrics(rows([200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100, 200, -100]), { refEquity: 5000 });
  assert.equal(m.n, 30);
  assert.equal(m.profitFactor, 2);
  assert.equal(m.hitRate, 0.5);
  assert.equal(m.avgR, 0.5);
  assert.equal(m.medianR, 0.5);
  assert.equal(m.expectancy, 50);
  assert.equal(m.grossExpectancy, 55, "fees ($5/row) added back");
  assert.equal(m.avgWin, 200);
  assert.equal(m.avgLoss, -100);
  assert.equal(m.net, 1500);
  assert.ok(m.tStat != null && m.tStat > 1.5);
  // By hand: mean 50, sample sd √(30·150²/29) = 152.56; span = 29 × 6h + 4h = 7.417 days →
  // 1477.5 trades/yr; Sharpe = 50/152.56 × √1477.5 = 12.60. Sortino on the same (n−1)
  // denominator: downside √(15·100²/29) = 71.92 → 26.72.
  assert.equal(m.sharpe?.toFixed(1), "12.6", "7.4-day span annualises");
  assert.equal(m.sortino?.toFixed(1), "26.7");
  assert.ok(m.sortino != null && m.sortino > (m.sharpe ?? 0), "downside deviation is smaller than total sd here");
  assert.equal(m.maxDD, 100);
  assert.equal(m.maxDDPct, 100 / 5000);
  assert.equal(m.longestLossStreak, 1);
});

test("[+100, −50, −50, −50, +200] → maxDD 150 over 3 trades, streak 3", () => {
  assert.deepEqual(maxDrawdown([100, -50, -50, -50, 200]), { dd: 150, trades: 3 });
  assert.equal(longestLossStreak([100, -50, -50, -50, 200]), 3);
  const m = sleeveMetrics(rows([100, -50, -50, -50, 200]));
  assert.equal(m.maxDD, 150); assert.equal(m.maxDDTrades, 3); assert.equal(m.longestLossStreak, 3);
  assert.equal(m.maxDDPct, null, "no reference equity → no percent");
  assert.deepEqual(maxDrawdown([10, 20, 30]), { dd: 0, trades: 0 });
  assert.deepEqual(maxDrawdown([]), { dd: 0, trades: 0 });
});

test("all winners → PF Infinity (computeMarginScoreboard's convention), sortino null; no trades → PF null", () => {
  const m = sleeveMetrics(rows(Array.from({ length: 30 }, () => 80)));
  assert.equal(m.profitFactor, Infinity);
  assert.equal(m.sortino, null, "no downside deviation");
  assert.equal(m.sharpe, null, "zero sd — nothing to divide by");
  assert.equal(m.tStat, null);
  assert.equal(m.maxDD, 0);
  assert.equal(sleeveMetrics([]).profitFactor, null);
  assert.equal(sleeveMetrics([]).expectancy, null);
  assert.equal(sleeveMetrics([]).hitRate, null);
});

test("n<2 → t and sharpe null; span < 7 days → sharpe and sortino null even at n=30", () => {
  const one = sleeveMetrics(rows([120]));
  assert.equal(one.n, 1); assert.equal(one.tStat, null); assert.equal(one.sharpe, null); assert.equal(one.sortino, null);
  assert.equal(one.expectancy, 120);
  const fast = sleeveMetrics(rows(Array.from({ length: 30 }, (_, i) => (i % 2 ? -60 : 140)), { spacingH: 1 }));
  assert.ok(fast.spanDays < 7);
  assert.equal(fast.sharpe, null); assert.equal(fast.sortino, null); assert.equal(fast.tradesPerYear, null);
  assert.ok(fast.tStat != null, "t does not need calendar time");
});

test("MAE is null until troughs exist; MFE reads the peak; both count their rows", () => {
  const noTrough = sleeveMetrics(rows([50, -100, 30]));
  assert.equal(noTrough.maeR, null); assert.equal(noTrough.maeN, 0);
  assert.equal(noTrough.mfeN, 3); assert.ok(noTrough.mfeR != null && noTrough.mfeR > 0);
  const withTrough = sleeveMetrics(rows([50, -100, 30], { trough: true }));
  assert.equal(withTrough.maeN, 3);
  assert.equal(withTrough.maeR, -0.5, "trough 2 below entry on a 4-point R");
  const noPeak = sleeveMetrics(rows([50], { peak: false }));
  assert.equal(noPeak.mfeR, null); assert.equal(noPeak.mfeN, 0);
});

test("R distribution sums to n, and a clean stop lands in ≤ −1R because R is fee-inclusive", () => {
  const rs = rows([-105, -20, 30, 150, 250, 400, 10]);
  rs[6] = { ...rs[6], riskUsd: 0 };   // no usable risk → "no R"
  const m = sleeveMetrics(rs);
  assert.equal(m.rDist.reduce((s, b) => s + b.n, 0), m.n);
  assert.deepEqual(m.rDist.map((b) => b.bucket), [...R_BUCKETS]);
  const by = Object.fromEntries(m.rDist.map((b) => [b.bucket, b.n]));
  assert.equal(by["≤ −1R"], 1); assert.equal(by["−1R..0"], 1); assert.equal(by["0..+1R"], 1);
  assert.equal(by["+1R..+2R"], 1); assert.equal(by["+2R..+3R"], 1); assert.equal(by["> +3R"], 1); assert.equal(by["no R"], 1);
  assert.equal(m.rN, 6);
  assert.equal(rMultiple(rs[0]), -1.05);
  assert.equal(rMultiple(rs[6]), null);
});

test("paper vs live series: live re-prices P&L and fees by the same factor; R is size-independent", () => {
  const rs = rows([200, -100, 300]).map((r) => ({ ...r, livePnl: r.pnl / 2 }));
  const paper = sleeveMetrics(rs, { series: "paper" });
  const live = sleeveMetrics(rs, { series: "live" });
  assert.equal(paper.net, 400); assert.equal(live.net, 200);
  assert.equal(paper.grossExpectancy, (400 + 15) / 3);
  assert.equal(live.grossExpectancy, (200 + 7.5) / 3);
  assert.equal(paper.feeShare, live.feeShare);
  assert.equal(paper.avgR, live.avgR);
  assert.equal(sleeveMetrics(rs).series, "live", "live is the default — the gate judges what the executor would earn");
});

test("welchT: negative when the first sample is worse; null below two rows or with no variance", () => {
  const t = welchT([-40, -45, -35, -40, -42], [50, 55, 45, 52, 48]);
  assert.ok(t != null && t < -10, `t=${t}`);
  assert.ok((welchT([50, 55, 45], [-40, -45, -35]) ?? 0) > 0);
  assert.equal(welchT([1], [1, 2, 3]), null);
  assert.equal(welchT([5, 5, 5], [5, 5, 5]), null);
});

// ---- rolling verdict ----

/** 60 rows around +50 (deterministic ± jitter so the mean is exact) then 30 rows around −40. */
function decayRows(jitter: number): SleeveRow[] {
  const prior = Array.from({ length: 60 }, (_, i) => 50 + (i % 2 ? jitter : -jitter));
  const last = Array.from({ length: 30 }, (_, i) => -40 + (i % 2 ? jitter : -jitter));
  return rows([...prior, ...last]);
}

test("rollingVerdict: a clean fall from +50 to −40 over the last 30 is DECAYING (Welch t ≤ −2)", () => {
  const v = rollingVerdict(decayRows(10));
  assert.equal(v.state, "DECAYING");
  assert.equal(v.window, 30);
  assert.ok(v.welchT != null && v.welchT <= -2, `t=${v.welchT}`);
  assert.equal(v.last.n, 30); assert.equal(v.prior?.n, 60); assert.equal(v.full.n, 90);
  assert.equal(v.last.expectancy, -40); assert.equal(v.prior?.expectancy, 50);
  assert.match(v.note, /Welch t=-\d+\.\d+ ≤ -2/);
});

test("rollingVerdict: the same means under huge noise is only cooling — not significant, but the window is negative while the record is positive", () => {
  const v = rollingVerdict(decayRows(2000));
  assert.equal(v.state, "cooling");
  assert.ok(v.welchT != null && v.welchT > -2, `t=${v.welchT}`);
  assert.equal(v.last.expectancy, -40);
  assert.ok((v.full.expectancy ?? 0) > 0);
  assert.match(v.note, /not significant/);
});

test("rollingVerdict: 29 rows → insufficient; 30 rows with <15 before the window → stable (no baseline)", () => {
  const few = rollingVerdict(rows(Array.from({ length: 29 }, (_, i) => (i % 2 ? -100 : 50))));
  assert.equal(few.state, "insufficient"); assert.equal(few.prior, null);
  assert.match(few.note, /29\/30 resolved/);
  const thin = rollingVerdict(decayRows(10).slice(-44));   // 14 prior + 30 window
  assert.equal(thin.state, "stable"); assert.equal(thin.prior, null);
  assert.match(thin.note, /no baseline yet \(14\/15/);
  const justEnough = rollingVerdict(decayRows(10).slice(-45));   // 15 prior + 30 window
  assert.equal(justEnough.state, "DECAYING");
});

test("rollingVerdict: a steady record is stable; PF < 1 in the window against a ≥1.2 record is cooling", () => {
  const steady = rollingVerdict(rows(Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -100 : 90))));
  assert.equal(steady.state, "stable");
  // Full record PF ≥ 1.2 and positive; the last 30 have PF just under 1. The prior sample's
  // wide spread keeps Welch inside noise, so this is cooling, not DECAYING. (PF < 1 forces a
  // negative window expectancy, so the PF clause never fires alone — it is kept because the
  // spec names it, and pinned here so the two clauses agree.)
  const prior = Array.from({ length: 40 }, (_, i) => (i % 4 === 3 ? -400 : 200));   // PF 1.5, mean 50, wide sd
  const last = Array.from({ length: 30 }, (_, i) => (i % 2 ? -100 : 95));           // PF 0.95, expectancy −2.5
  const v = rollingVerdict(rows([...prior, ...last]));
  assert.ok(v.last.profitFactor != null && v.last.profitFactor < 1);
  assert.ok(v.full.profitFactor != null && v.full.profitFactor >= 1.2);
  assert.ok(v.welchT != null && v.welchT > -2, `the fall is inside noise on this sd (t=${v.welchT})`);
  assert.equal(v.state, "cooling");
});
