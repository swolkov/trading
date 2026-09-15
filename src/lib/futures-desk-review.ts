// FUTURES DESK — leaderboard, profit distribution, promotion gate and the daily / weekly review
// TEXT (E6). Pure: the jobs module feeds it ledger and inbox rows and writes what comes back to the
// vault and Slack. Nothing here touches the money path — a verdict is a page and a document, never
// a switch; going live is a separate, typed decision on a separate account.
import { EDGES, etDayKey, usd, type EdgeKey, type Readiness } from "@/lib/futures-desk-rules";
import { EMPTY_METRICS, sleeveMetrics, type SeriesMetrics } from "@/lib/futures-desk-metrics";
import type { ScorePromotionVerdict } from "@/lib/futures-desk-score";

// ---- roll chains ---------------------------------------------------------------------------------
/** A rolled position is ONE trade: fold each leg that ended in a roll into its successor, so the
 *  scoreboard counts the round trip once with the summed P&L, and an open successor keeps the
 *  whole chain open. */
export function mergeRollChains<T extends { id: number; status: string; exit_reason: string | null; pnl_usd: number | null; rolled_from: number | null }>(rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  const successorOf = new Map<number, number>();
  for (const r of rows) if (r.rolled_from != null) successorOf.set(r.rolled_from, r.id);
  const out: T[] = [];
  for (const r of rows) {
    if (r.exit_reason === "roll" && successorOf.has(r.id)) continue;      // folded into its successor
    let pnl = r.pnl_usd ?? 0, from = r.rolled_from, complete = r.status === "closed" && r.pnl_usd != null;
    while (from != null) { const leg = byId.get(from); if (!leg) break; if (leg.pnl_usd == null) complete = false; pnl += leg.pnl_usd ?? 0; from = leg.rolled_from; }
    out.push({ ...r, pnl_usd: r.status === "closed" ? (complete ? pnl : null) : r.pnl_usd });
  }
  return out;
}

// ---- journal → metric rows -------------------------------------------------------------------------
/** The ledger columns the review reads (a subset of TradeRow, so fixtures stay small). */
export interface JournalRow {
  id: number; opened_at: string; closed_at: string | null; edge: string; root: string; side: string; status: string; exit_reason: string | null;
  pnl_usd: number | null; pnl_after_slip_usd?: number | null; fees_usd?: number | null; slip_model_usd?: number | null; risk_usd: number; rolled_from: number | null;
  session?: string | null; regime?: string | null; mfe_r?: number | null; mae_r?: number | null; error_class?: string | null; stage?: string | null;
}
export interface MetricRow {
  id: number; edge: string; root: string; side: string; openedAt: string; closedAt: string;
  /** The judged P&L: after modeled slippage where every leg had it, else the demo's own — `pnlSource` says which. */
  pnl: number; pnlDemo: number; pnlSource: "after_slip" | "demo";
  fees: number; slipUsd: number; risk: number; r: number | null;
  session: string | null; regime: string | null; dow: string;
  mfeR: number | null; maeR: number | null; errorClass: string | null; stage: string | null; legs: number;
}

const dowOf = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });

/** Resolved trades only, roll chains merged into one row each: judged P&L summed across the legs,
 *  fees and modeled slip summed, MFE/MAE the chain's maxima, the origin leg's session / regime / side.
 *  A chain is judged after slip only when EVERY leg carries `pnl_after_slip_usd`; otherwise the whole
 *  chain is the demo's own `pnl_usd` (`pnlSource: "demo"`) — never a mixed sum. */
export function journalToMetricRows(rows: JournalRow[]): MetricRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const judged = new Map(mergeRollChains(rows.map((r) => ({ ...r, pnl_usd: r.pnl_after_slip_usd ?? r.pnl_usd }))).map((r) => [r.id, r.pnl_usd]));
  const demo = mergeRollChains(rows);
  const out: MetricRow[] = [];
  for (const head of demo) {
    if (head.status !== "closed" || head.pnl_usd == null || !head.closed_at) continue;
    const legs: JournalRow[] = [];
    for (let cur: JournalRow | undefined = byId.get(head.id); cur; cur = cur.rolled_from != null ? byId.get(cur.rolled_from) : undefined) legs.push(cur);
    const origin = legs[legs.length - 1];
    const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const maxOf = (vals: (number | null)[]) => { const xs = vals.filter((v): v is number => v != null); return xs.length ? Math.max(...xs) : null; };
    const risk = Number.isFinite(head.risk_usd) ? head.risk_usd : 0;
    const allAfterSlip = legs.every((l) => l.pnl_after_slip_usd != null);
    const pnl = allAfterSlip ? (judged.get(head.id) ?? head.pnl_usd) : head.pnl_usd;
    out.push({
      id: head.id, edge: head.edge, root: head.root, side: origin.side, openedAt: origin.opened_at, closedAt: head.closed_at,
      pnl, pnlDemo: head.pnl_usd, pnlSource: allAfterSlip ? "after_slip" : "demo",
      fees: legs.reduce((s, l) => s + (num(l.fees_usd) ?? 0), 0), slipUsd: legs.reduce((s, l) => s + (num(l.slip_model_usd) ?? 0), 0),
      risk, r: risk > 0 ? pnl / risk : null,
      session: origin.session ?? null, regime: origin.regime ?? null, dow: dowOf(origin.opened_at),
      mfeR: maxOf(legs.map((l) => num(l.mfe_r))), maeR: maxOf(legs.map((l) => num(l.mae_r))),
      errorClass: legs.map((l) => l.error_class ?? null).find((c) => c != null) ?? null, stage: origin.stage ?? null, legs: legs.length,
    });
  }
  return out.sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
}

// ---- leaderboard -------------------------------------------------------------------------------------
export interface LeaderRow { edge: string; root: string | null; slice: string | null; label: string; metrics: SeriesMetrics }
export interface Leaderboard { byEdge: LeaderRow[]; byEdgeRoot: LeaderRow[]; bySession: LeaderRow[]; byRegime: LeaderRow[]; byDow: LeaderRow[]; bySide: LeaderRow[] }

const toInput = (rows: MetricRow[]) => rows.map((r) => ({ pnl: r.pnl, risk: r.risk, at: r.closedAt, mfeR: r.mfeR, maeR: r.maeR }));
function grouped(rows: MetricRow[], basis: number, keyOf: (r: MetricRow) => string | null, label: (edge: string, slice: string) => string, sliceIs: "root" | "slice"): LeaderRow[] {
  const groups = new Map<string, { edge: string; slice: string; rows: MetricRow[] }>();
  for (const r of rows) {
    const k = keyOf(r); if (k == null) continue;
    const key = `${r.edge}|${k}`;
    const g = groups.get(key) ?? { edge: r.edge, slice: k, rows: [] }; g.rows.push(r); groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.edge.localeCompare(b.edge) || a.slice.localeCompare(b.slice))
    .map((g) => ({ edge: g.edge, root: sliceIs === "root" ? g.slice : null, slice: sliceIs === "slice" ? g.slice : null, label: label(g.edge, g.slice), metrics: sleeveMetrics(toInput(g.rows), basis) }));
}

/** Per edge (every registered edge, even with no rows) and per edge × root, plus the four slices per edge. */
export function futuresLeaderboard(rows: MetricRow[], basisUsd: number): Leaderboard {
  const byEdge = EDGES.map((e) => ({ edge: e.key, root: null, slice: null, label: e.key, metrics: rows.some((r) => r.edge === e.key) ? sleeveMetrics(toInput(rows.filter((r) => r.edge === e.key)), basisUsd) : { ...EMPTY_METRICS } }));
  return {
    byEdge,
    byEdgeRoot: grouped(rows, basisUsd, (r) => r.root, (e, s) => `${e} · ${s}`, "root"),
    bySession: grouped(rows, basisUsd, (r) => r.session, (e, s) => `${e} · ${s}`, "slice"),
    byRegime: grouped(rows, basisUsd, (r) => r.regime, (e, s) => `${e} · ${s}`, "slice"),
    byDow: grouped(rows, basisUsd, (r) => r.dow, (e, s) => `${e} · ${s}`, "slice"),
    bySide: grouped(rows, basisUsd, (r) => r.side, (e, s) => `${e} · ${s}`, "slice"),
  };
}

// ---- profit distribution -----------------------------------------------------------------------------
export interface Concentration { key: string | null; pnl: number; share: number }
export interface Distribution { grossProfit: number; bestTrade: Concentration; bestDay: Concentration; bestWeek: Concentration; bestRoot: Concentration }

/** ISO week key ("2026-W38") of an instant's ET date. */
export function isoWeekKey(iso: string | Date): string {
  const day = etDayKey(typeof iso === "string" ? new Date(iso) : iso);
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function best(rows: MetricRow[], keyOf: (r: MetricRow) => string, gross: number): Concentration {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(keyOf(r), (sums.get(keyOf(r)) ?? 0) + r.pnl);
  let top: Concentration = { key: null, pnl: 0, share: 0 };
  for (const [key, pnl] of sums) if (top.key == null || pnl > top.pnl) top = { key, pnl, share: gross > 0 && pnl > 0 ? pnl / gross : 0 };
  return top;
}

/** How much of the gross profit one trade, one day, one week and one market account for. Shares are
 *  of the GROSS profit (the sum of winning trades), so a book that lost money reads 0 everywhere. */
export function profitDistribution(rows: MetricRow[]): Distribution {
  const gross = rows.filter((r) => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
  return {
    grossProfit: gross,
    bestTrade: best(rows, (r) => String(r.id), gross),
    bestDay: best(rows, (r) => etDayKey(new Date(r.closedAt)), gross),
    bestWeek: best(rows, (r) => isoWeekKey(r.closedAt), gross),
    bestRoot: best(rows, (r) => r.root, gross),
  };
}

// ---- the promotion gate ------------------------------------------------------------------------------
export type PromotionStatus = "LIVE-CANDIDATE" | "GATHERING" | "FAILING";
export interface Gate { gate: string; ok: boolean; value: string; target: string; note?: string }
export interface PromotionVerdict { edge: string; status: PromotionStatus; strong: boolean; gates: Gate[]; failedGates: string[]; resolved: number; spanDays: number; exception: string | null; asOf: string }

/** Donchian fires often enough for 100; daily MR is a daily-bar swing rule (~3–5 signals a year per
 *  root), so 30 over ≥ 84 days is the stated exception — and even that is unlikely inside the window,
 *  so its live case will rest on backtest concordance as much as on this record. */
export const PROMOTION_MIN_RESOLVED: Record<EdgeKey, number> = { donchian_60m_long: 100, index_daily_mr: 30 };
export const PROMOTION_MIN_SPAN_DAYS: Record<EdgeKey, number> = { donchian_60m_long: 56, index_daily_mr: 84 };
export const PROMOTION_PF = 1.4, PROMOTION_PF_STRONG = 1.6, PROMOTION_DD_PCT = 8, PROMOTION_DD_PCT_STRONG = 6, PROMOTION_T = 2;
export const PROMOTION_BEST_TRADE_SHARE = 0.25, PROMOTION_BEST_DAY_SHARE = 0.30, PROMOTION_MIN_REGIMES = 3, PROMOTION_ERROR_RATE = 0.02;

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const f2 = (x: number | null) => (x == null ? "—" : x.toFixed(2));

export function futuresPromotionVerdict(edgeKey: EdgeKey, rows: MetricRow[], anomalyOpen: boolean, now: Date, opts: { basisUsd: number; executionErrors?: number; attempts?: number }): PromotionVerdict {
  const mine = rows.filter((r) => r.edge === edgeKey);
  const m = sleeveMetrics(toInput(mine), opts.basisUsd);
  const dist = profitDistribution(mine);
  const spanDays = mine.length ? (Math.max(...mine.map((r) => Date.parse(r.closedAt))) - Math.min(...mine.map((r) => Date.parse(r.openedAt)))) / 86_400_000 : 0;
  const regimes = new Set(mine.map((r) => r.regime).filter((x): x is string => !!x));
  const errors = opts.executionErrors ?? mine.filter((r) => r.errorClass != null).length;
  const attempts = opts.attempts ?? mine.length;
  const errorRate = attempts > 0 ? errors / attempts : 0;
  const minN = PROMOTION_MIN_RESOLVED[edgeKey], minSpan = PROMOTION_MIN_SPAN_DAYS[edgeKey];
  const exception = edgeKey === "index_daily_mr" ? "daily-bar exception: 30 resolved over ≥ 84 days (at ~3–5 signals a year per root even 30 is unlikely in the window; the live case rests on backtest concordance too)" : null;
  const pfOk = m.profitFactor == null ? m.grossProfit > 0 : m.profitFactor >= PROMOTION_PF;
  const gates: Gate[] = [
    { gate: "resolved", ok: m.n >= minN, value: String(m.n), target: `≥ ${minN}`, ...(exception ? { note: exception } : {}) },
    { gate: "span", ok: spanDays >= minSpan, value: `${spanDays.toFixed(0)} days`, target: `≥ ${minSpan} days` },
    { gate: "net after slip", ok: m.net > 0, value: `${m.net < 0 ? "−" : ""}${usd(m.net)}`, target: "> $0" },
    { gate: "profit factor", ok: pfOk, value: m.profitFactor == null ? (m.n ? "∞" : "—") : f2(m.profitFactor), target: `≥ ${PROMOTION_PF} (strong ≥ ${PROMOTION_PF_STRONG})` },
    { gate: "max drawdown", ok: m.maxDrawdownPct <= PROMOTION_DD_PCT, value: `${m.maxDrawdownPct.toFixed(1)}% of basis`, target: `≤ ${PROMOTION_DD_PCT}% (strong ≤ ${PROMOTION_DD_PCT_STRONG}%)` },
    { gate: "t-stat", ok: m.tStat != null && m.tStat >= PROMOTION_T, value: f2(m.tStat), target: `≥ ${PROMOTION_T}` },
    { gate: "best trade share", ok: dist.bestTrade.share <= PROMOTION_BEST_TRADE_SHARE, value: pct(dist.bestTrade.share), target: `≤ ${pct(PROMOTION_BEST_TRADE_SHARE)} of gross profit` },
    { gate: "best day share", ok: dist.bestDay.share <= PROMOTION_BEST_DAY_SHARE, value: pct(dist.bestDay.share), target: `≤ ${pct(PROMOTION_BEST_DAY_SHARE)} of gross profit` },
    { gate: "regimes seen", ok: regimes.size >= PROMOTION_MIN_REGIMES, value: regimes.size ? String(regimes.size) : "not yet measurable (E7 stamps regimes)", target: `≥ ${PROMOTION_MIN_REGIMES} labels`, note: regimes.size ? undefined : "counts as failed until regimes are stamped" },
    { gate: "execution errors", ok: errorRate <= PROMOTION_ERROR_RATE, value: `${errors} of ${attempts} (${pct(errorRate)})`, target: `≤ ${pct(PROMOTION_ERROR_RATE)}` },
    { gate: "no open anomaly", ok: !anomalyOpen, value: anomalyOpen ? "anomaly open" : "clear", target: "clear" },
  ];
  const failedGates = gates.filter((g) => !g.ok).map((g) => g.gate);
  const sampleShort = !gates[0].ok || !gates[1].ok;
  const status: PromotionStatus = failedGates.length === 0 ? "LIVE-CANDIDATE" : sampleShort ? "GATHERING" : "FAILING";
  const strong = status === "LIVE-CANDIDATE" && (m.profitFactor == null || m.profitFactor >= PROMOTION_PF_STRONG) && m.maxDrawdownPct <= PROMOTION_DD_PCT_STRONG;
  return { edge: edgeKey, status, strong, gates, failedGates, resolved: m.n, spanDays, exception, asOf: now.toISOString() };
}

// ---- when the reviews run ------------------------------------------------------------------------------
/** The daily review runs once per ET trading day, on the first guardian run after 17:05 ET (the session
 *  closed at 17:00). Saturday and Sunday (ET) have no session to review — skipped. */
export function dailyReviewDue(lastDayKey: string | undefined, now: Date): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  if (et.getDay() === 0 || et.getDay() === 6) return false;
  return et.getHours() * 60 + et.getMinutes() >= 17 * 60 + 5 && lastDayKey !== etDayKey(now);
}
/** The weekly review runs on the first guardian run of a Monday (ET), once per ISO week. */
export function weeklyReviewDue(lastWeekKey: string | undefined, now: Date): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getDay() === 1 && lastWeekKey !== isoWeekKey(now);
}

/** Append one entry to a capped vault document: entries begin with a `## ` line; the oldest beyond
 *  `cap` are returned for the archive. */
export function rotateEntries(existing: string | null, entry: string, cap = 120): { kept: string; archived: string | null } {
  const entries = (existing ?? "").split(/\n(?=## )/).map((e) => e.trim()).filter(Boolean);
  const all = [...entries, entry.trim()];
  const overflow = Math.max(0, all.length - cap);
  return { kept: all.slice(overflow).join("\n\n"), archived: overflow ? all.slice(0, overflow).join("\n\n") : null };
}

// ---- daily review -------------------------------------------------------------------------------------
export interface DailySignal { edge: string; root: string; action: string; status: string; reason: string | null; error_class?: string | null; trade_id?: number | null }
export interface DailyInput {
  dayKey: string; rows: MetricRow[]; signals: DailySignal[];
  /** Intraday equity samples (levels) if a series exists — the guardian keeps one equity per run, not a series, so usually null → "n/a". */
  equitySamples?: number[] | null;
  stage?: string | null; basisUsd: number;
}

function signedUsd(n: number, d = 0): string { return `${n < 0 ? "−" : "+"}${usd(n, d)}`; }
function intradayDd(samples: number[] | null | undefined): string {
  if (!samples || samples.length < 2) return "n/a (no intraday equity series)";
  let peak = -Infinity, dd = 0;
  for (const v of samples) { peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
  return usd(dd);
}
function countBy<T>(xs: T[], keyOf: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(keyOf(x), (m.get(keyOf(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** The day's review as vault markdown and a condensed Slack line. Headers are fixed (tests pin them). */
export function renderDailyReview(i: DailyInput): { markdown: string; slack: string } {
  const m = sleeveMetrics(toInput(i.rows), i.basisUsd);
  const gross = i.rows.reduce((s, r) => s + r.pnlDemo, 0);
  const fees = i.rows.reduce((s, r) => s + r.fees, 0), slip = i.rows.reduce((s, r) => s + r.slipUsd, 0);
  const netAfterSlip = i.rows.reduce((s, r) => s + (r.pnlSource === "after_slip" ? r.pnl : r.pnlDemo - r.slipUsd), 0);
  // Rule violations: ledger error classes + inbox errors, an unprotected ENTRY counted once (it is both its
  // signal's error and its row's class — the signal's trade_id names the row).
  const classedRows = new Set(i.rows.filter((r) => r.errorClass).map((r) => r.id));
  const violations = classedRows.size + i.signals.filter((s) => (s.error_class || s.status === "error") && !(s.error_class === "unprotected" && s.trade_id != null && classedRows.has(s.trade_id))).length;
  const refusals = countBy(i.signals.filter((s) => s.status === "refused"), (s) => (s.reason ?? "(no reason)").slice(0, 90));
  const setups = countBy(i.rows, (r) => `${r.edge} · ${r.root}`).map(([k]) => ({ key: k, pnl: i.rows.filter((r) => `${r.edge} · ${r.root}` === k).reduce((s, r) => s + r.pnl, 0) })).sort((a, b) => b.pnl - a.pnl);
  const watch = i.signals.filter((s) => s.action === "watch");
  const dow = new Date(`${i.dayKey}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const lines = [
    `## Futures desk — daily review ${i.dayKey} (${dow})${i.stage ? ` · stage ${i.stage}` : ""}`,
    `### P&L`,
    `- Gross (demo, after modeled fees): ${signedUsd(gross)} · fees ${usd(fees, 2)} · modeled slip ${usd(slip, 2)}`,
    `- Net after slip (the judged series): ${signedUsd(netAfterSlip)}`,
    `- Max intraday drawdown: ${intradayDd(i.equitySamples)}`,
    `### Trades`,
    `- Trades ${m.n} · wins ${m.wins} · losses ${m.losses} · win rate ${m.hitRate == null ? "—" : pct(m.hitRate)}`,
    `- Avg winner ${m.avgWin == null ? "—" : signedUsd(m.avgWin)} · avg loser ${m.avgLoss == null ? "—" : signedUsd(m.avgLoss)} · PF ${m.profitFactor == null ? (m.n ? "∞" : "—") : f2(m.profitFactor)} · expectancy ${m.expectancyUsd == null ? "—" : signedUsd(m.expectancyUsd)} (${f2(m.expectancyR)}R)`,
    `- Largest win ${signedUsd(m.largestWin)} · largest loss ${signedUsd(m.largestLoss)}`,
    `- Best setup: ${setups[0] ? `${setups[0].key} ${signedUsd(setups[0].pnl)}` : "—"} · worst setup: ${setups.length > 1 ? `${setups[setups.length - 1].key} ${signedUsd(setups[setups.length - 1].pnl)}` : "—"}`,
    `- Rule violations (error classes): ${violations}`,
    `### Refusals`,
    ...(refusals.length ? refusals.map(([why, n]) => `- ${n}× ${why}`) : ["- none"]),
    `### Watch`,
    ...(watch.length ? watch.slice(0, 8).map((w) => `- ${w.edge} ${w.root}: ${(w.reason ?? "").slice(0, 120)}`) : ["- none"]),
  ];
  const slack = `📒 FUTURES DESK daily ${i.dayKey}: ${m.n} trade(s) · net after slip ${signedUsd(netAfterSlip)} · ${m.wins}W/${m.losses}L · PF ${m.profitFactor == null ? (m.n ? "∞" : "—") : f2(m.profitFactor)} · refusals ${refusals.reduce((s, [, n]) => s + n, 0)} · violations ${violations} · watch ${watch.length}`;
  return { markdown: lines.join("\n"), slack };
}

// ---- weekly review ------------------------------------------------------------------------------------
export interface WeeklyInput {
  weekKey: string; board: Leaderboard; distribution: Distribution; verdicts: PromotionVerdict[]; readiness: { stage: string; readiness: Readiness } | null; generatedAt: string;
  /** E7: the score buckets (≥ 80 / 70–79 / < 70) by mean R and PF, and whether the score may be promoted. Absent = not measured. */
  scoreBuckets?: (ScorePromotionVerdict & { unscored: number; promoted: boolean }) | null;
}

function table(rows: LeaderRow[]): string[] {
  if (!rows.length) return ["_no resolved trades_"];
  const h = "| Slice | n | net | PF | maxDD % | Sharpe | Sortino | avg R | exp $ | hit | MFE R | MAE R |";
  const sep = "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  return [h, sep, ...rows.map((r) => { const m = r.metrics; return `| ${r.label} | ${m.n} | ${m.net < 0 ? "−" : ""}${usd(m.net)} | ${m.profitFactor == null ? (m.n ? "∞" : "—") : f2(m.profitFactor)} | ${m.maxDrawdownPct.toFixed(1)} | ${f2(m.sharpe)} | ${f2(m.sortino)} | ${f2(m.avgR)} | ${m.expectancyUsd == null ? "—" : signedUsd(m.expectancyUsd)} | ${m.hitRate == null ? "—" : pct(m.hitRate)} | ${f2(m.avgMfeR)} | ${f2(m.avgMaeR)} |`; })];
}

export function renderWeeklyReview(i: WeeklyInput): string {
  const d = i.distribution;
  const conc = (name: string, c: Concentration) => `- ${name}: ${c.key ?? "—"} ${signedUsd(c.pnl)} (${pct(c.share)} of gross profit)`;
  const lines = [
    `# Futures desk — weekly review ${i.weekKey}`,
    `_Generated ${i.generatedAt}. Judged series = P&L after modeled fees and slippage; roll chains count once. Sharpe/Sortino are per trade, unannualised._`,
    ``, `## By strategy`, ...table(i.board.byEdge),
    ``, `## By instrument`, ...table(i.board.byEdgeRoot),
    ``, `## By session`, ...table(i.board.bySession),
    ``, `## By day of week`, ...table(i.board.byDow),
    ``, `## By regime`, ...table(i.board.byRegime),
    ``, `## By direction`, ...table(i.board.bySide),
    ``, `## Profit distribution`, `- Gross profit: ${usd(d.grossProfit)}`, conc("Best trade", d.bestTrade), conc("Best day", d.bestDay), conc("Best week", d.bestWeek), conc("Best market", d.bestRoot),
    ``, `## Promotion verdicts`,
  ];
  for (const v of i.verdicts) {
    lines.push(`### ${v.edge} — ${v.status}${v.strong ? " (strong)" : ""}`, `| Gate | ok | value | target |`, `|---|---|---|---|`);
    for (const g of v.gates) lines.push(`| ${g.gate} | ${g.ok ? "✓" : "✗"} | ${g.value} | ${g.target} |`);
    if (v.exception) lines.push(`_${v.exception}_`);
  }
  lines.push(``, `## Score buckets`);
  if (i.scoreBuckets) {
    const sb = i.scoreBuckets;
    lines.push(`| Bucket | n | mean R | PF |`, `|---|---:|---:|---:|`);
    for (const b of sb.buckets) lines.push(`| ${b.label} | ${b.n} | ${f2(b.meanR)} | ${b.pf == null ? (b.n ? "∞" : "—") : b.pf === Infinity ? "∞" : f2(b.pf)} |`);
    lines.push(`- Welch t (≥ 80 vs < 70): ${f2(sb.tStat)} · unscored resolved: ${sb.unscored} · score ${sb.promoted ? "PROMOTED — Strong/A+ unlocked, the minimum applies" : "not promoted — a stamp, never a size"}`);
    lines.push(`- Promotion verdict: ${sb.ok ? "GREEN — promote from /futures (type PROMOTE)" : sb.reasons.join(" · ")}`);
  } else lines.push(`- n/a`);
  lines.push(``, `## Stage readiness`);
  if (i.readiness) {
    const r = i.readiness.readiness;
    lines.push(`- Stage ${i.readiness.stage}: ${r.ok ? "EARNED — advance from /futures (type STAGE)" : r.reasons.join(" · ")}`);
  } else lines.push(`- n/a`);
  return lines.join("\n");
}
