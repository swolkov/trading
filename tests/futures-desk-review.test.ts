import assert from "node:assert/strict";
import { test } from "node:test";
import { sleeveMetrics } from "../src/lib/futures-desk-metrics";
import {
  PROMOTION_MIN_RESOLVED, PROMOTION_MIN_SPAN_DAYS, dailyReviewDue, futuresLeaderboard, futuresPromotionVerdict, isoWeekKey, journalToMetricRows, mergeRollChains,
  profitDistribution, renderDailyReview, renderWeeklyReview, rotateEntries, weeklyReviewDue, type JournalRow, type MetricRow,
} from "../src/lib/futures-desk-review";
import { DEFAULT_LIMITS, stageReadiness } from "../src/lib/futures-desk-rules";

const BASIS = 50_000;
const now = new Date("2026-09-15T21:10:00Z");

// ---- a synthetic ledger: n resolved trades spread evenly over `spanDays`, P&L from a pattern ----
interface Gen { n: number; spanDays: number; pnl: (i: number) => number; edge?: string; regimes?: (string | null)[]; start?: string; root?: (i: number) => string; errorClass?: (i: number) => string | null }
function ledger(g: Gen): MetricRow[] {
  const start = Date.parse(g.start ?? "2026-06-01T15:00:00Z");
  const step = g.n > 1 ? (g.spanDays * 86_400_000) / (g.n - 1) : 0;
  const regimes = g.regimes ?? ["trend_up_lowvol", "range_midvol", "trend_down_highvol"];
  return Array.from({ length: g.n }, (_, i) => {
    const closed = new Date(start + i * step);
    const pnl = g.pnl(i);
    return {
      id: i + 1, edge: g.edge ?? "donchian_60m_long", root: g.root ? g.root(i) : ["ES", "NQ", "GC"][i % 3], side: "long", openedAt: new Date(closed.getTime() - 2 * 3600_000).toISOString(), closedAt: closed.toISOString(),
      pnl, pnlDemo: pnl + 8.9, pnlSource: "after_slip" as const, fees: 1.7, slipUsd: 8.9, risk: 100, r: pnl / 100,
      session: ["morning", "midday", "power"][i % 3], regime: regimes[i % regimes.length], dow: closed.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" }),
      mfeR: 1.2, maeR: 0.4, errorClass: g.errorClass ? g.errorClass(i) : null, stage: "A", legs: 1,
    };
  });
}
const good = ledger({ n: 120, spanDays: 70, pnl: (i) => (i % 5 < 3 ? 150 : -100) });   // 60% × +150, 40% × −100
const verdictOf = (rows: MetricRow[], edge: "donchian_60m_long" | "index_daily_mr" = "donchian_60m_long", anomaly = false, opts: { executionErrors?: number; attempts?: number } = {}) =>
  futuresPromotionVerdict(edge, rows, anomaly, now, { basisUsd: BASIS, ...opts });

// ---- journal → metric rows ------------------------------------------------------------------------------
test("journalToMetricRows merges a roll chain into ONE row: judged P&L summed across the legs, fees and slip summed, MFE the chain's max, origin session", () => {
  const rows: JournalRow[] = [
    { id: 1, opened_at: "2026-09-10T14:00:00Z", closed_at: "2026-09-16T15:00:00Z", edge: "index_daily_mr", root: "ES", side: "long", status: "closed", exit_reason: "roll", pnl_usd: -50, pnl_after_slip_usd: -58.9, fees_usd: 1.7, slip_model_usd: 8.9, risk_usd: 200, rolled_from: null, session: "morning", regime: null, mfe_r: 0.3, mae_r: 0.5, error_class: null, stage: "A" },
    { id: 2, opened_at: "2026-09-10T14:00:00Z", closed_at: "2026-09-20T15:00:00Z", edge: "index_daily_mr", root: "ES", side: "long", status: "closed", exit_reason: "rule", pnl_usd: 200, pnl_after_slip_usd: 191.1, fees_usd: 1.7, slip_model_usd: 8.9, risk_usd: 200, rolled_from: 1, session: "midday", regime: null, mfe_r: 1.4, mae_r: 0.2, error_class: null, stage: "A" },
    { id: 3, opened_at: "2026-09-21T14:00:00Z", closed_at: null, edge: "donchian_60m_long", root: "GC", side: "long", status: "open", exit_reason: null, pnl_usd: null, risk_usd: 250, rolled_from: null },
    { id: 4, opened_at: "2026-09-01T14:00:00Z", closed_at: "2026-09-02T15:00:00Z", edge: "donchian_60m_long", root: "NQ", side: "long", status: "closed", exit_reason: "stop", pnl_usd: -120, pnl_after_slip_usd: null, fees_usd: 1.7, slip_model_usd: null, risk_usd: 120, rolled_from: null, error_class: "partial_fill" },
  ];
  const out = journalToMetricRows(rows);
  assert.equal(out.length, 2);   // the chain once, the legacy row once, the open row not at all
  const chain = out.find((r) => r.id === 2)!;
  assert.equal(chain.legs, 2); assert.ok(Math.abs(chain.pnl - 132.2) < 1e-9); assert.ok(Math.abs(chain.pnlDemo - 150) < 1e-9); assert.equal(chain.pnlSource, "after_slip");
  assert.equal(chain.fees, 3.4); assert.equal(chain.slipUsd, 17.8); assert.equal(chain.mfeR, 1.4); assert.equal(chain.maeR, 0.5); assert.equal(chain.session, "morning"); assert.equal(chain.openedAt, "2026-09-10T14:00:00Z");
  assert.ok(Math.abs((chain.r as number) - 132.2 / 200) < 1e-9);
  const legacy = out.find((r) => r.id === 4)!;
  assert.equal(legacy.pnlSource, "demo"); assert.equal(legacy.pnl, -120); assert.equal(legacy.errorClass, "partial_fill"); assert.equal(legacy.dow, "Tue");
  assert.equal(out[0].id, 4);   // sorted by close
  // A chain with ONE leg lacking the after-slip figure is judged on the demo's pnl_usd for the WHOLE chain — never a mixed sum.
  const mixed = journalToMetricRows(rows.map((r) => (r.id === 1 ? { ...r, pnl_after_slip_usd: null } : r)));
  const mixedChain = mixed.find((r) => r.id === 2)!;
  assert.equal(mixedChain.pnlSource, "demo"); assert.ok(Math.abs(mixedChain.pnl - 150) < 1e-9); assert.ok(Math.abs(mixedChain.pnlDemo - 150) < 1e-9); assert.ok(Math.abs((mixedChain.r as number) - 0.75) < 1e-9);
  // mergeRollChains itself still folds the leg into its successor (the status module re-exports this one).
  assert.equal(mergeRollChains(rows).length, 3);
});

// ---- metrics -------------------------------------------------------------------------------------------
test("sleeveMetrics: PF, drawdown, streaks, R and t on a known series; an empty series is all zeros/nulls", () => {
  const m = sleeveMetrics([
    { pnl: 100, risk: 100, at: "2026-09-01T00:00:00Z" }, { pnl: -50, risk: 100, at: "2026-09-02T00:00:00Z" },
    { pnl: 200, risk: 100, at: "2026-09-03T00:00:00Z", mfeR: 3 }, { pnl: -100, risk: 100, at: "2026-09-04T00:00:00Z", mfeR: 1 },
  ], BASIS);
  assert.equal(m.n, 4); assert.equal(m.wins, 2); assert.equal(m.losses, 2); assert.equal(m.hitRate, 0.5);
  assert.equal(m.net, 150); assert.equal(m.grossProfit, 300); assert.equal(m.grossLoss, 150); assert.equal(m.profitFactor, 2);
  assert.equal(m.maxDrawdownUsd, 100); assert.equal(m.maxDrawdownPct, 0.2);
  assert.equal(m.avgR, 0.375); assert.equal(m.expectancyUsd, 37.5); assert.equal(m.expectancyR, 0.375);
  assert.equal(m.avgWin, 150); assert.equal(m.avgLoss, -75); assert.equal(m.largestWin, 200); assert.equal(m.largestLoss, -100);
  assert.deepEqual(m.streak, { maxWins: 1, maxLosses: 1, current: -1 }); assert.equal(m.avgMfeR, 2); assert.equal(m.avgMaeR, null);
  assert.equal(m.spanDays, 3); assert.ok(m.sharpe != null && m.sortino != null && m.tStat != null);
  assert.ok((m.sortino as number) > (m.sharpe as number));   // downside deviation is smaller than the full sd here
  const allWins = sleeveMetrics([{ pnl: 10, risk: 100, at: "2026-09-01T00:00:00Z" }], BASIS);
  assert.equal(allWins.profitFactor, null); assert.equal(allWins.sortino, null);   // nothing lost: undefined, not infinite
  const empty = sleeveMetrics([], BASIS);
  assert.equal(empty.n, 0); assert.equal(empty.profitFactor, null); assert.equal(empty.net, 0);
});

// ---- leaderboard and distribution ------------------------------------------------------------------------
test("futuresLeaderboard: every registered edge (empty ones too), edge × root, and the four slices", () => {
  const b = futuresLeaderboard(good, BASIS);
  assert.deepEqual(b.byEdge.map((r) => r.edge), ["index_daily_mr", "donchian_60m_long"]);
  assert.equal(b.byEdge[0].metrics.n, 0); assert.equal(b.byEdge[1].metrics.n, 120);
  assert.deepEqual(b.byEdgeRoot.map((r) => r.root), ["ES", "GC", "NQ"]); assert.equal(b.byEdgeRoot[0].label, "donchian_60m_long · ES");
  assert.deepEqual(b.bySession.map((r) => r.slice), ["midday", "morning", "power"]);
  assert.equal(b.byRegime.length, 3); assert.equal(b.bySide[0].slice, "long"); assert.ok(b.byDow.length >= 5);
  assert.equal(b.byEdgeRoot.reduce((s, r) => s + r.metrics.n, 0), 120);
});

test("profitDistribution: shares of GROSS profit; a losing book reads 0 everywhere", () => {
  const d = profitDistribution(good);
  assert.equal(d.grossProfit, 72 * 150); assert.ok(Math.abs(d.bestTrade.share - 150 / 10_800) < 1e-9); assert.equal(d.bestTrade.pnl, 150);
  assert.ok(d.bestDay.share > 0 && d.bestDay.share < 0.1); assert.match(d.bestWeek.key as string, /^2026-W\d\d$/); assert.ok(["ES", "NQ", "GC"].includes(d.bestRoot.key as string));
  const losing = profitDistribution(ledger({ n: 10, spanDays: 10, pnl: () => -50 }));
  assert.equal(losing.grossProfit, 0); assert.equal(losing.bestTrade.share, 0); assert.equal(losing.bestDay.share, 0);
  assert.equal(isoWeekKey("2026-09-15T21:10:00Z"), "2026-W38"); assert.equal(isoWeekKey("2026-01-01T12:00:00Z"), "2026-W01"); assert.equal(isoWeekKey("2027-01-03T12:00:00Z"), "2026-W53");
});

// ---- the promotion gate ------------------------------------------------------------------------------------
test("promotion: a clean 120-trade, 70-day Donchian record with three regimes is LIVE-CANDIDATE and strong", () => {
  const v = verdictOf(good);
  assert.equal(v.status, "LIVE-CANDIDATE"); assert.deepEqual(v.failedGates, []); assert.equal(v.strong, true); assert.equal(v.resolved, 120); assert.equal(v.exception, null);
  assert.equal(v.gates.length, 11); assert.equal(v.asOf, now.toISOString());
  assert.equal(PROMOTION_MIN_RESOLVED.donchian_60m_long, 100); assert.equal(PROMOTION_MIN_SPAN_DAYS.index_daily_mr, 84);
});

test("promotion: each gate flips on its own synthetic ledger", () => {
  const gate = (v: ReturnType<typeof verdictOf>, name: string) => v.gates.find((g) => g.gate === name)!;
  // resolved: 50 of 100 → GATHERING
  const few = verdictOf(ledger({ n: 50, spanDays: 70, pnl: (i) => (i % 5 < 3 ? 150 : -100) }));
  assert.equal(few.status, "GATHERING"); assert.ok(few.failedGates.includes("resolved")); assert.equal(gate(few, "resolved").value, "50"); assert.equal(gate(few, "resolved").target, "≥ 100");
  // span: 120 trades inside 30 days → GATHERING
  const short = verdictOf(ledger({ n: 120, spanDays: 30, pnl: (i) => (i % 5 < 3 ? 150 : -100) }));
  assert.equal(short.status, "GATHERING"); assert.deepEqual(short.failedGates, ["span"]); assert.equal(gate(short, "span").target, "≥ 56 days");
  // net after slip: a losing book → FAILING with net, PF and t
  const losing = verdictOf(ledger({ n: 120, spanDays: 70, pnl: (i) => (i % 5 < 2 ? 100 : -100) }));
  assert.equal(losing.status, "FAILING"); for (const g of ["net after slip", "profit factor", "t-stat"]) assert.ok(losing.failedGates.includes(g), g);
  assert.equal(gate(losing, "net after slip").value, "−$2,400");   // 48 × +100 − 72 × 100
  // profit factor: 50/50 at +100/−80 → PF 1.25, positive net
  const thin = verdictOf(ledger({ n: 120, spanDays: 70, pnl: (i) => (i % 2 ? 100 : -80) }));
  assert.equal(thin.status, "FAILING"); assert.ok(thin.failedGates.includes("profit factor")); assert.equal(gate(thin, "profit factor").value, "1.25"); assert.ok(!thin.failedGates.includes("net after slip"));
  // max drawdown: 45 straight losses of −100 = $4,500 = 9% of basis
  const dd = verdictOf(ledger({ n: 120, spanDays: 70, pnl: (i) => (i >= 10 && i < 55 ? -100 : 300) }));
  assert.ok(dd.failedGates.includes("max drawdown")); assert.equal(gate(dd, "max drawdown").value, "9.0% of basis");
  // t-stat: alternating ±, net barely positive
  const noisy = verdictOf(ledger({ n: 120, spanDays: 70, pnl: (i) => (i % 2 ? 101 : -100) }));
  assert.ok(noisy.failedGates.includes("t-stat")); assert.equal(noisy.status, "FAILING");
  // concentration: one trade = 40% of gross profit → FAILING with that gate (best day follows it)
  const conc = verdictOf(ledger({ n: 120, spanDays: 70, pnl: (i) => (i === 60 ? 660 : i % 6 === 5 ? -5 : 9.9) }));
  assert.equal(conc.status, "FAILING"); assert.ok(conc.failedGates.includes("best trade share")); assert.equal(gate(conc, "best trade share").value, "40%"); assert.ok(conc.failedGates.includes("best day share"));
  // regimes: none stamped yet → "not yet measurable", counted as failed (so FAILING, not GATHERING)
  const noRegime = verdictOf(ledger({ n: 120, spanDays: 70, pnl: (i) => (i % 5 < 3 ? 150 : -100), regimes: [null] }));
  assert.equal(noRegime.status, "FAILING"); assert.deepEqual(noRegime.failedGates, ["regimes seen"]);
  assert.equal(gate(noRegime, "regimes seen").value, "not yet measurable (E7 stamps regimes)"); assert.match(gate(noRegime, "regimes seen").note ?? "", /counts as failed/);
  const twoRegimes = verdictOf(ledger({ n: 120, spanDays: 70, pnl: (i) => (i % 5 < 3 ? 150 : -100), regimes: ["a", "b"] }));
  assert.deepEqual(twoRegimes.failedGates, ["regimes seen"]); assert.equal(gate(twoRegimes, "regimes seen").value, "2");
  // execution errors: from the ledger's own classes (3 of 120 = 2.5%), or from the inbox counts when given
  const errs = verdictOf(ledger({ n: 120, spanDays: 70, pnl: (i) => (i % 5 < 3 ? 150 : -100), errorClass: (i) => (i < 3 ? "close_refused" : null) }));
  assert.deepEqual(errs.failedGates, ["execution errors"]); assert.equal(gate(errs, "execution errors").value, "3 of 120 (3%)");
  assert.deepEqual(verdictOf(good, "donchian_60m_long", false, { executionErrors: 2, attempts: 120 }).failedGates, []);
  assert.deepEqual(verdictOf(good, "donchian_60m_long", false, { executionErrors: 5, attempts: 120 }).failedGates, ["execution errors"]);
  // anomaly open
  const anom = verdictOf(good, "donchian_60m_long", true);
  assert.deepEqual(anom.failedGates, ["no open anomaly"]); assert.equal(anom.status, "FAILING");
  // strong needs PF ≥ 1.6 and DD ≤ 6%: PF 1.5 passes the gate but is not strong
  const okNotStrong = verdictOf(ledger({ n: 120, spanDays: 70, pnl: (i) => (i % 2 ? 150 : -100) }));
  assert.equal(okNotStrong.status, "LIVE-CANDIDATE"); assert.equal(okNotStrong.strong, false); assert.equal(gate(okNotStrong, "profit factor").value, "1.50");
});

test("promotion: index_daily_mr needs 30 resolved over ≥ 84 days — the daily-bar exception is stated on the gate", () => {
  const mr = (n: number, span: number) => ledger({ n, spanDays: span, pnl: (i) => (i % 5 < 3 ? 150 : -100), edge: "index_daily_mr" });
  const short = verdictOf(mr(30, 60), "index_daily_mr");
  assert.equal(short.status, "GATHERING"); assert.deepEqual(short.failedGates, ["span"]); assert.match(short.exception ?? "", /daily-bar exception/);
  assert.equal(short.gates[0].target, "≥ 30"); assert.match(short.gates[0].note ?? "", /backtest concordance/);
  const ok = verdictOf(mr(30, 90), "index_daily_mr");
  assert.equal(ok.status, "LIVE-CANDIDATE");
  assert.equal(verdictOf(mr(29, 90), "index_daily_mr").status, "GATHERING");
  // The other edge's rows are not this edge's evidence.
  assert.equal(verdictOf(good, "index_daily_mr").resolved, 0);
});

// ---- the daily review --------------------------------------------------------------------------------------
test("renderDailyReview: the fixed headers, the stat list, refusals by reason, watch rows; intraday DD is n/a without a series", () => {
  const rows = ledger({ n: 3, spanDays: 0.2, pnl: (i) => [150, -100, 80][i], start: "2026-09-15T14:00:00Z", errorClass: (i) => (i === 1 ? "partial_fill" : null) });
  const signals = [
    { edge: "donchian_60m_long", root: "ES", action: "entry", status: "refused", reason: "one MES risks $301.70 against a $250 budget (normal · stage A) — refused, never stretched" },
    { edge: "donchian_60m_long", root: "NQ", action: "entry", status: "refused", reason: "one MES risks $301.70 against a $250 budget (normal · stage A) — refused, never stretched" },
    { edge: "index_daily_mr", root: "YM", action: "entry", status: "refused", reason: "event window: FOMC rate decision 14:00 ET — paused until 14:30" },
    { edge: "donchian_60m_long", root: "GC", action: "watch", status: "watch", reason: "dry run: 1× MGC · stop 12 pts · risk $121.70 of $250 (normal · stage A)" },
    { edge: "donchian_60m_long", root: "SI", action: "entry", status: "error", reason: "entry threw", error_class: "auth_backoff" },
  ];
  // An unprotected ENTRY is both its signal's error and its row's class: counted once.
  const unprotectedRows = [...rows, { ...rows[0], id: 9, errorClass: "unprotected", pnl: -20, pnlDemo: -11.1 }];
  const unprotectedSignals = [...signals, { edge: "donchian_60m_long", root: "ES", action: "entry", status: "error", reason: "filled 1× MESZ6 but could not be protected — closed", error_class: "unprotected", trade_id: 9 }];
  assert.ok(renderDailyReview({ dayKey: "2026-09-15", rows: unprotectedRows, signals: unprotectedSignals, basisUsd: BASIS }).markdown.includes("- Rule violations (error classes): 3"));   // 2 + the one unprotected, not 4
  const { markdown, slack } = renderDailyReview({ dayKey: "2026-09-15", rows, signals, equitySamples: null, stage: "A", basisUsd: BASIS });
  for (const h of ["## Futures desk — daily review 2026-09-15 (Tue) · stage A", "### P&L", "### Trades", "### Refusals", "### Watch"]) assert.ok(markdown.includes(h), h);
  assert.ok(markdown.includes("- Gross (demo, after modeled fees): +$157 · fees $5.10 · modeled slip $26.70"));   // 130 + 3 × 8.9
  assert.ok(markdown.includes("- Net after slip (the judged series): +$130"));
  assert.ok(markdown.includes("- Max intraday drawdown: n/a (no intraday equity series)"));
  assert.ok(markdown.includes("- Trades 3 · wins 2 · losses 1 · win rate 67%"));
  assert.ok(markdown.includes("- Avg winner +$115 · avg loser −$100 · PF 2.30 · expectancy +$43 (0.43R)"));
  assert.ok(markdown.includes("- Largest win +$150 · largest loss −$100"));
  assert.ok(markdown.includes("- Best setup: donchian_60m_long · ES +$150 · worst setup: donchian_60m_long · NQ −$100"));
  assert.ok(markdown.includes("- Rule violations (error classes): 2"));   // one ledger class + one inbox error
  assert.ok(markdown.includes("- 2× one MES risks $301.70 against a $250 budget (normal · stage A) — refused, never stretched"));
  assert.ok(markdown.includes("- 1× event window: FOMC rate decision 14:00 ET — paused until 14:30"));
  assert.ok(markdown.includes("- donchian_60m_long GC: dry run: 1× MGC"));
  assert.equal(slack, "📒 FUTURES DESK daily 2026-09-15: 3 trade(s) · net after slip +$130 · 2W/1L · PF 2.30 · refusals 3 · violations 2 · watch 1");
  const quiet = renderDailyReview({ dayKey: "2026-09-16", rows: [], signals: [], basisUsd: BASIS });
  assert.ok(quiet.markdown.includes("### Refusals\n- none")); assert.ok(quiet.markdown.includes("### Watch\n- none")); assert.ok(quiet.markdown.includes("- Trades 0 · wins 0 · losses 0 · win rate —"));
  assert.ok(renderDailyReview({ dayKey: "2026-09-16", rows: [], signals: [], equitySamples: [50_000, 50_400, 49_900, 50_100], basisUsd: BASIS }).markdown.includes("- Max intraday drawdown: $500"));
});

test("rotateEntries caps the daily document at 120 entries and hands the oldest to the archive", () => {
  const entry = (i: number) => `## Futures desk — daily review day-${i}\n### P&L\n- line`;
  let doc: string | null = null;
  for (let i = 0; i < 120; i++) { const r = rotateEntries(doc, entry(i), 120); assert.equal(r.archived, null); doc = r.kept; }
  assert.equal((doc as string).split(/\n(?=## )/).length, 120);
  const r = rotateEntries(doc, entry(120), 120);
  assert.equal(r.archived, entry(0)); assert.equal(r.kept.split(/\n(?=## )/).length, 120);
  assert.ok(r.kept.startsWith("## Futures desk — daily review day-1\n")); assert.ok(r.kept.endsWith(entry(120)));
  assert.equal(rotateEntries("", "## x", 120).kept, "## x"); assert.equal(rotateEntries(null, "## x", 120).archived, null);
});

test("when the reviews run: daily after 17:05 ET once per day key; weekly on Monday once per ISO week", () => {
  assert.equal(dailyReviewDue(undefined, new Date("2026-09-15T21:04:00Z")), false);   // 17:04 ET
  assert.equal(dailyReviewDue(undefined, new Date("2026-09-15T21:05:00Z")), true);
  assert.equal(dailyReviewDue("2026-09-15", new Date("2026-09-15T21:05:00Z")), false);
  assert.equal(dailyReviewDue("2026-09-14", new Date("2026-09-15T21:05:00Z")), true);
  assert.equal(dailyReviewDue(undefined, new Date("2026-09-19T21:10:00Z")), false);   // Saturday 17:10 ET — no session to review
  assert.equal(dailyReviewDue(undefined, new Date("2026-09-20T21:10:00Z")), false);   // Sunday
  assert.equal(dailyReviewDue(undefined, new Date("2026-09-18T21:10:00Z")), true);    // Friday
  assert.equal(weeklyReviewDue(undefined, new Date("2026-09-14T04:01:00Z")), true);    // Mon 00:01 ET
  assert.equal(weeklyReviewDue("2026-W38", new Date("2026-09-14T04:01:00Z")), false);
  assert.equal(weeklyReviewDue("2026-W37", new Date("2026-09-14T04:01:00Z")), true);
  assert.equal(weeklyReviewDue(undefined, new Date("2026-09-15T14:00:00Z")), false);   // Tuesday
  assert.equal(weeklyReviewDue(undefined, new Date("2026-09-14T03:30:00Z")), false);   // Sunday 23:30 ET
});

// ---- the weekly review --------------------------------------------------------------------------------------
test("renderWeeklyReview renders the six leaderboard tables, the distribution, the verdicts and the stage line", () => {
  const board = futuresLeaderboard(good, BASIS);
  const md = renderWeeklyReview({
    weekKey: "2026-W38", board, distribution: profitDistribution(good), verdicts: [verdictOf(good), verdictOf(good, "index_daily_mr")],
    readiness: { stage: "A", readiness: stageReadiness([], "A", DEFAULT_LIMITS) }, generatedAt: now.toISOString(),
  });
  for (const h of ["# Futures desk — weekly review 2026-W38", "## By strategy", "## By instrument", "## By session", "## By day of week", "## By regime", "## By direction", "## Profit distribution", "## Promotion verdicts", "## Stage readiness"]) assert.ok(md.includes(h), h);
  assert.ok(md.includes("| Slice | n | net | PF | maxDD % | Sharpe | Sortino | avg R | exp $ | hit | MFE R | MAE R |"));
  assert.ok(md.includes("| donchian_60m_long · ES | 40 |")); assert.ok(md.includes("| index_daily_mr | 0 |"));
  assert.ok(md.includes("### donchian_60m_long — LIVE-CANDIDATE (strong)")); assert.ok(md.includes("### index_daily_mr — GATHERING"));
  assert.ok(md.includes("| resolved | ✓ | 120 | ≥ 100 |")); assert.ok(md.includes("| resolved | ✗ | 0 | ≥ 30 |"));
  assert.ok(md.includes("- Best trade: 1 +$150 (1% of gross profit)"));
  assert.ok(md.includes("- Stage A: only 0 of 30 resolved at stage A"));
  const empty = renderWeeklyReview({ weekKey: "2026-W38", board: futuresLeaderboard([], BASIS), distribution: profitDistribution([]), verdicts: [], readiness: null, generatedAt: now.toISOString() });
  assert.ok(empty.includes("## By instrument\n_no resolved trades_")); assert.ok(empty.includes("## Stage readiness\n- n/a"));
});
