import assert from "node:assert/strict";
import test from "node:test";
import { renderStatistics, divergenceSummary } from "../src/lib/margin-synthesis";

// The ×5-size twin is the SAME trades as the live candidate at a different size. It has its
// own scoreboard row, but every POOLED statistic (headline totals, conviction table, edges,
// milestones) must read through POOLED_SQL, which excludes it — otherwise every candidate
// trade is counted twice at 3.5× the weight.
test("POOLED_SQL = the record minus the experiment twins", async () => {
  const { POOLED_SQL, RECORD_SQL, EXPERIMENT_SOURCES, SIZE_MULTIPLIER } = await import("../src/lib/margin-shadow");
  assert.deepEqual(EXPERIMENT_SOURCES, Object.keys(SIZE_MULTIPLIER));
  assert.ok(EXPERIMENT_SOURCES.includes("selective-x5"));
  assert.ok(POOLED_SQL.startsWith(RECORD_SQL), "pooled stats keep the cohort + US-universe predicate");
  assert.match(POOLED_SQL, /NOT IN \('selective-x5'\)/);
});

test("the statistics file carries the live candidate's forward-only, timeframe, by-day and per-trade detail", () => {
  const text = renderStatistics({
    at: "2026-09-07T00:20:00.000Z",
    strategies: [],
    shadow: { resolved: 40, wins: 24, hitRate: 0.6, totalPnl: 4796, avgWin: 400, avgLoss: -300, open: 7, openUnrealized: 351, byConviction: [], legacyOpen: 0, nonUsOpen: 0, nonUsResolved: 0 },
    edges: { byDirection: [], byCoin: [] },
    fills: [],
    div: divergenceSummary([]),
    live: { armed: true, sources: ["selective"], equity: 5271 },
    candidate: {
      source: "selective",
      forward: { key: "forward", resolved: 10, wins: 7, hitRate: 0.7, net: 1889, tStat: 1.3, days: 2, open: 8 },
      byTimeframe: [
        { key: "5m", resolved: 27, wins: 17, hitRate: 0.63, net: 4377, tStat: 1.9, days: 4, open: 6 },
        { key: "1h", resolved: 4, wins: 3, hitRate: 0.75, net: 642, tStat: 0.78, days: 2, open: 0 },
      ],
      byDay: [{ day: "2026-09-03", resolved: 8, net: 3798 }, { day: "2026-09-05", resolved: 6, net: -795 }],
      recent: [{ id: 788, symbol: "LINK/USD", timeframe: "5m", conviction: "high", opened: "2026-09-06T12:13:00.000Z", resolvedAt: "2026-09-06T19:00:00.000Z", peakPct: 8.22, reason: "trailing stop", pnl: 504.5 }],
    },
  });
  assert.match(text, /experiment twins excluded/);
  assert.match(text, /## Live candidate — detail \(selective\)/);
  assert.match(text, /Forward-only[^\n]*10 resolved · 70% hit · net \$1889 · t=1\.30 · 2 distinct days · 8 open/);
  assert.match(text, /\| 5m \| 27 \| 63% \| \$4377 \| 1\.90 \| 4 \| 6 \|/);
  assert.match(text, /2026-09-03 8 trades \$3798 · 2026-09-05 6 trades −\$795/);
  assert.match(text, /\| 2026-09-06 12:13 \| LINK \| 5m \| \+8\.2% \| trailing stop \| \$505 \|/);
  assert.match(text, /selective-x5\) is the same trades again at 5× size/);
});

test("without candidate detail the file renders as before", () => {
  const text = renderStatistics({ at: "2026-09-07T00:20:00.000Z", strategies: [], shadow: null, edges: { byDirection: [], byCoin: [] }, fills: [], div: divergenceSummary([]), live: { armed: false, sources: [], equity: null } });
  assert.doesNotMatch(text, /Live candidate — detail/);
  assert.match(text, /## Paper scoreboard/);
});
