import assert from "node:assert/strict";
import test from "node:test";
import { renderWeeklyMemo, weeklyAction } from "../src/lib/margin-weekly";
import { divergenceSummary } from "../src/lib/margin-synthesis";

// The Monday review is written by rule. These pin the ACTION ladder and the page's shape.

const strat = (key: string, o: Partial<{ resolved: number; liveNet: number; verdict: string; tStat: number | null; days: number; open: number; grossPnl: number; fees: number; totalPnl: number }> = {}) => ({
  key, label: key, resolved: 0, wins: 0, hitRate: 0.5, avgWin: 0, avgLoss: 0, expectancy: null, totalPnl: 0, open: 0,
  grossPnl: 0, fees: 0, peakedGreen: 0, liveNet: 0, tStat: null as number | null, paperTStat: null as number | null, verdict: "gathering (0/30)", forwardResolved: 0, days: 0, ...o,
});

test("the ACTION ladder", () => {
  assert.equal(weeklyAction(strat("a", { resolved: 12, liveNet: 400, verdict: "gathering (12/30)" })), "KEEP · gathering");
  assert.equal(weeklyAction(strat("a", { resolved: 45, liveNet: 2628, verdict: "promising (could be luck)" })), "KEEP · promising");
  assert.equal(weeklyAction(strat("a", { resolved: 45, liveNet: 2628, verdict: "REAL EDGE — significant" })), "PROMOTE-READY");
  assert.equal(weeklyAction(strat("a", { resolved: 30, liveNet: 0, verdict: "not paying" })), "KILL CANDIDATE");
  assert.equal(weeklyAction(strat("a", { resolved: 31, liveNet: -5, verdict: "not paying" })), "KILL CANDIDATE");
  assert.equal(weeklyAction(strat("fast-tight", { resolved: 60, liveNet: -900, verdict: "retired — not paying" })), "retired");
});

test("the memo carries the live book, the forward read, fees, capacity, the sleeve table and the change list", () => {
  const text = renderWeeklyMemo({
    at: "2026-09-14T13:00:00.000Z",
    live: { armed: true, sources: ["selective"], equity: 5200, equityPeak: 5393 },
    stage3: { status: "running", startedAt: "2026-09-06T00:55:47.309Z", target: 20, fromBase: 1.5, toBase: 3, done: 7 },
    demoted: null,
    fills: [],
    div: divergenceSummary([]),
    strategies: [
      strat("selective", { resolved: 45, open: 9, liveNet: 2628, tStat: 1.9, days: 5, verdict: "promising (could be luck)", grossPnl: 8081, fees: 2825, totalPnl: 5256 }),
      strat("selective-tight", { resolved: 4, open: 3, liveNet: 120, verdict: "gathering (4/30)" }),
      strat("swing-lev", { resolved: 31, open: 0, liveNet: -40, verdict: "not paying" }),
    ],
    candidate: {
      source: "selective",
      forward: { key: "forward", resolved: 32, wins: 20, hitRate: 0.625, net: 3100, tStat: 2.1, days: 8, open: 4 },
      byTimeframe: [{ key: "5m", resolved: 31, wins: 20, hitRate: 0.65, net: 5200, tStat: 2.4, days: 6, open: 3 }],
      byEntryWindow: [{ key: "12–18 UTC", resolved: 14, wins: 4, hitRate: 0.29, net: -1500, tStat: -1.4, days: 4, open: 2 }],
      byDay: [], recent: [],
    },
    capacity: {
      source: "selective", since: "2026-09-06T00:55:47.309Z", liveFactor: 0.5, rules: { slots: 2, perDay: 3, cooldownMin: 30 },
      setups: 17, taken: 3, refused: { total: 14, slots: 13, cooldown: 1, dailyCap: 0, margin: 0, leverage: 0, event: 0, revenge: 0, drawdown: 0, other: 0 },
      refusedOutcome: { resolved: 8, wins: 5, net: 1120, open: 6, floating: -840 },
      replay: [{ slots: 2, taken: 4, resolved: 2, open: 2, net: -742, floating: 169, refusedByMargin: 0, baseRiskPct: 3.0, netAtOwnRisk: -742.0 }, { slots: 3, taken: 6, resolved: 4, open: 2, net: -632, floating: -345, refusedByMargin: 0, baseRiskPct: 2.5, netAtOwnRisk: -632.0 }],
      ledger: [],
    },
  });
  assert.match(text, /# Margin desk — Monday review \(2026-09-14\)/);
  assert.match(text, /Executor: \*\*ARMED\*\* · sleeve: selective · equity \$5200 \(peak \$5393, -3\.6% from peak\)/);
  assert.match(text, /Stage 3: \*\*running\*\* · 7\/20/);
  assert.match(text, /Forward-only: \*\*32 resolved\*\*[^\n]*t=2\.10[^\n]*\*\*holding, significant\*\*/);
  assert.match(text, /cuts readable this week: tf 5m 31 res, net \$5200, t=2\.40/);
  assert.match(text, /fees are \*\*35% of gross\*\*/);
  assert.match(text, /One more slot would have: taken 6 vs 4, net −\$316 vs −\$371\. More, on this sample — still not a reason/);
  assert.match(text, /\| selective \| 45 \(0 fwd\) \| 9 \| 50% \| \$2628 \| 1\.90 \| 5 \| \*\*KEEP · promising\*\* \|/);
  assert.match(text, /\| selective-tight · twin, not pooled \|[^\n]*\*\*KEEP · gathering\*\*/);
  assert.match(text, /\| swing-lev \|[^\n]*\*\*KILL CANDIDATE\*\*/);
  assert.match(text, /KILL CANDIDATE: swing-lev — retire by adding to RETIRED_AUTO_SOURCES/);
  assert.doesNotMatch(text, /\*\*Nothing\.\*\*/);
});

test("a quiet week says so, and a demotion is shown", () => {
  const quiet = renderWeeklyMemo({ at: "2026-09-21T13:00:00.000Z", live: { armed: true, sources: ["selective"], equity: 5300, equityPeak: 5393 }, stage3: null, demoted: null, fills: [], div: divergenceSummary([]), strategies: [strat("selective", { resolved: 20, liveNet: 300, verdict: "gathering (20/30)" })], candidate: null, capacity: null });
  assert.match(quiet, /\*\*Nothing\.\*\* No rule fired/);
  assert.match(quiet, /Not armed yet — nothing to measure/);
  const dem = renderWeeklyMemo({ at: "2026-09-21T13:00:00.000Z", live: { armed: false, sources: ["selective"], equity: 4900, equityPeak: 5393 }, stage3: null, demoted: { at: "2026-09-20T10:00:00.000Z", source: "selective", reason: "the forward-only paper record is not paying: 30 resolved, net −$120 (rule: ≤ $0 at 30+ resolved)" }, fills: [], div: divergenceSummary([]), strategies: [], candidate: null, capacity: null });
  assert.match(dem, /Executor: \*\*DEMOTED to paper\*\*/);
  assert.match(dem, /⛔ Demoted 2026-09-20 10:00 UTC: the forward-only paper record is not paying/);
  assert.match(dem, /DEMOTED: selective — read the record before acknowledging/);
});

// ---- C2: the ACTION ladder reads the full promotion gate when it is given ----

const promo = (o: Partial<{ ready: boolean; stage: string }> = {}) => ({ ready: false, stage: "promising", gates: [], failed: [], note: "", ...o }) as { ready: boolean; stage: "gathering" | "not paying" | "promising" | "PAPER-ONLY" | "PROMOTE-READY" | "REDUCE" | "retired"; gates: []; failed: []; note: string };

test("with a promotion verdict the ladder gains PROMOTE-READY / REDUCE · decaying / KEEP · paper-only; without one it reads as before", () => {
  const edge = strat("swing-pyr", { resolved: 45, liveNet: 2628, verdict: "REAL EDGE — significant" });
  assert.equal(weeklyAction(edge), "PROMOTE-READY", "no promotion arg → the scoreboard verdict decides, unchanged");
  assert.equal(weeklyAction(edge, null), "PROMOTE-READY");
  assert.equal(weeklyAction(edge, promo({ ready: true, stage: "PROMOTE-READY" })), "PROMOTE-READY");
  assert.equal(weeklyAction(edge, promo({ stage: "REDUCE" })), "REDUCE · decaying");
  assert.equal(weeklyAction(edge, promo({ stage: "PAPER-ONLY" })), "KEEP · paper-only (no container)");
  // REAL EDGE on the scoreboard but short of the full gate (PF / drawdown) → not PROMOTE-READY any more
  assert.equal(weeklyAction(edge, promo({ stage: "promising" })), "KEEP · promising");
  assert.equal(weeklyAction(strat("a", { resolved: 31, liveNet: -5, verdict: "not paying" }), promo({ stage: "not paying" })), "KILL CANDIDATE");
  assert.equal(weeklyAction(strat("a", { resolved: 12, liveNet: 40, verdict: "gathering (12/30)" }), promo({ stage: "gathering" })), "KEEP · gathering");
  assert.equal(weeklyAction(strat("fast-tight", { resolved: 60, liveNet: -900, verdict: "retired — not paying" }), promo({ ready: true, stage: "PROMOTE-READY" })), "retired", "retired wins over everything");
});

test("the memo's sleeve table carries the leaderboard columns and the REDUCE line", () => {
  const metrics = { series: "live" as const, n: 45, net: 2628, expectancy: 58.4, grossExpectancy: 70, feeShare: 0.17, hitRate: 0.5, avgWin: 300, avgLoss: -180, profitFactor: 1.67, tStat: 1.9, sharpe: 2.35, sortino: 3.9, tradesPerYear: 600, spanDays: 27, maxDD: 610, maxDDPct: 0.122, maxDDTrades: 4, longestLossStreak: 3, avgR: 0.41, medianR: -0.2, rN: 45, rDist: [], mfeR: 1.3, mfeN: 45, maeR: null, maeN: 0 };
  const text = renderWeeklyMemo({
    at: "2026-09-21T13:00:00.000Z", live: { armed: true, sources: ["swing-pyr"], equity: 4700, equityPeak: 5140 }, stage3: null, demoted: null, fills: [], div: divergenceSummary([]),
    strategies: [strat("swing-pyr", { resolved: 45, open: 1, liveNet: 2628, tStat: 1.9, days: 9, verdict: "promising (could be luck)" })],
    candidate: null, capacity: null,
    leaderboard: [{
      ...strat("swing-pyr", { resolved: 45, open: 1, liveNet: 2628, tStat: 1.9, days: 9, verdict: "promising (could be luck)" }),
      metrics, paperMetrics: metrics,
      rolling: { state: "DECAYING", window: 30, welchT: -2.4, note: "last 30: −$40/trade vs $95/trade before (Welch t=-2.40 ≤ -2)", lastN: 30, lastExpectancy: -40, priorExpectancy: 95, lastNet: -1200 },
      promotion: { ready: false, stage: "REDUCE", gates: [], failed: ["Confidence (t)", "Rolling record"], note: "REDUCE — the rolling-30 record is decaying" },
    }],
  });
  assert.match(text, /\| sleeve \| resolved \| open \| hit \| net \(live-sized\) \| t \| days \| ACTION \| Sharpe \| Sortino \| PF \| max DD \| avg R \| MAE \(R\) \| rolling 30 \|/);
  assert.match(text, /\| swing-pyr · twin, not pooled \| 45 \(0 fwd\) \| 1 \| 50% \| \$2628 \| 1\.90 \| 9 \| \*\*REDUCE · decaying\*\* \| 2\.35 \| 3\.90 \| 1\.67 \| 12\.2% \(4 tr\) \| 0\.41R \| — \| DECAYING \|/);
  assert.match(text, /REDUCE · decaying: swing-pyr — the rolling-30 record is significantly worse/);
  assert.doesNotMatch(text, /\*\*Nothing\.\*\*/);
  assert.match(text, /Sharpe\/Sortino rank and gate nothing/);
});
