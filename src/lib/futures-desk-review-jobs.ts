// FUTURES DESK — the review jobs' I/O (E6): read the whole ledger and the day's inbox, hand them to
// the pure review module, write the result to the vault and Slack. Triggered by the guardian (no new
// cron): the daily review on the first run after 17:05 ET per ET day, the weekly on the first run of a
// Monday per ISO week. Fail-soft everywhere — a review that cannot be written is a guardian note,
// never an exception in the position path. Imports the store, never futures-desk.ts (no cycle).
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { vaultAppend, vaultRead, vaultWrite } from "@/lib/vault";
import { EDGES, etDayKey, stageReadiness, type DeskLimits, type EdgeKey, type Readiness } from "@/lib/futures-desk-rules";
import { parseAnomaly } from "@/lib/futures-desk-safety";
import { SCORE_PROMOTED_KEY, scoreBucketsOf, scorePromotionVerdict, type ScorePromotionVerdict } from "@/lib/futures-desk-score";
import { ANOMALY_KEY, LANE, cfg, ensureDeskTables, rawRows } from "@/lib/futures-desk-store";
import {
  futuresLeaderboard, futuresPromotionVerdict, isoWeekKey, journalToMetricRows, mergeRollChains, profitDistribution, renderDailyReview, renderWeeklyReview, rotateEntries,
  type DailySignal, type Distribution, type JournalRow, type Leaderboard, type MetricRow, type PromotionVerdict,
} from "@/lib/futures-desk-review";

export const DAILY_REVIEW_PATH = "Performance/futures-desk-daily.md";
export const DAILY_REVIEW_ARCHIVE_PATH = "Performance/futures-desk-daily-archive.md";
export const WEEKLY_REVIEW_PATH = "Performance/futures-desk-weekly.md";
export const DAILY_REVIEW_CAP = 120;
const WRITER = "futures-desk";

const JOURNAL_COLS = "id, opened_at, closed_at, edge, root, side, status, exit_reason, pnl_usd, pnl_after_slip_usd, fees_usd, slip_model_usd, risk_usd, rolled_from, session, regime, mfe_r, mae_r, error_class, stage";

/** The whole ledger in the review's column shape (the scoring pass reads it too). */
export async function journal(): Promise<JournalRow[]> {
  await ensureDeskTables();
  return rawRows<JournalRow>(`SELECT ${JOURNAL_COLS} FROM futures_desk_trades ORDER BY id`);
}

/** Inbox rows of one ET day (received there), for the refusal and watch counts. */
async function signalsOn(dayKey: string): Promise<DailySignal[]> {
  return rawRows<DailySignal>(
    `SELECT edge, root, action, status, reason, error_class, trade_id FROM futures_desk_signals WHERE (received_at AT TIME ZONE 'America/New_York')::date = $1::date ORDER BY id`, dayKey);
}

/** Execution errors per edge from the inbox (signal rows that ended in `error`) over the record, and
 *  the attempts they are measured against (executed + error). The ledger's own error classes are
 *  already on the metric rows; the inbox adds the entries that never became a row. */
async function errorRates(): Promise<Record<string, { errors: number; attempts: number }>> {
  const rows = await prisma.$queryRawUnsafe<{ edge: string; status: string; n: bigint | number }[]>(
    `SELECT edge, status, count(*) AS n FROM futures_desk_signals WHERE action = 'entry' AND status IN ('executed', 'error') GROUP BY edge, status`);
  const out: Record<string, { errors: number; attempts: number }> = {};
  for (const r of rows) {
    const o = out[r.edge] ?? { errors: 0, attempts: 0 };
    o.attempts += Number(r.n); if (r.status === "error") o.errors += Number(r.n);
    out[r.edge] = o;
  }
  return out;
}

/** Signal score per ledger row (every leg of a roll chain carries the origin's signal_id, so the chain's head maps too). */
async function scoreByTradeId(): Promise<Map<number, number>> {
  const rows = await rawRows<{ id: number; score: number | null }>(`SELECT t.id, s.score FROM futures_desk_trades t JOIN futures_desk_signals s ON s.id = t.signal_id WHERE s.score IS NOT NULL`);
  return new Map(rows.filter((r) => r.score != null).map((r) => [r.id, r.score as number]));
}
export type ScoreBucketReport = ScorePromotionVerdict & { unscored: number; promoted: boolean };
/** The score buckets over the resolved record (E7): each merged chain's R against its signal's score. */
export async function scoreBucketReport(rows: MetricRow[]): Promise<ScoreBucketReport> {
  const [scores, promotedRaw] = await Promise.all([scoreByTradeId(), cfg(SCORE_PROMOTED_KEY)]);
  const buckets = scoreBucketsOf(rows.map((r) => ({ score: scores.get(r.id) ?? null, r: r.r })));
  return { ...scorePromotionVerdict(buckets), unscored: buckets.unscored, promoted: promotedRaw === "true" };
}

export interface ReviewSnapshot { rows: MetricRow[]; leaderboard: Leaderboard; distribution: Distribution; promotion: PromotionVerdict[]; readiness: { stage: string; readiness: Readiness } }

/** Everything the page, the API and the weekly review show: the leaderboard, the distribution, one
 *  promotion verdict per edge, and readiness for the next stage on the current stage's own rows. */
export async function reviewSnapshot(limits: DeskLimits, now = new Date()): Promise<ReviewSnapshot> {
  const [raw, anomalyRaw, rates] = await Promise.all([journal(), cfg(ANOMALY_KEY), errorRates().catch(() => ({}) as Record<string, { errors: number; attempts: number }>)]);
  const rows = journalToMetricRows(raw);
  const anomalyOpen = parseAnomaly(anomalyRaw) != null;
  const promotion = EDGES.map((e) => {
    // An unprotected ENTRY is already its signal's error row (E5 counts it once the same way); the other ledger classes never reach the inbox.
    const ledgerErrors = rows.filter((r) => r.edge === e.key && r.errorClass != null && r.errorClass !== "unprotected").length;
    const inbox = rates[e.key];
    // Attempts = inbox entries that executed or errored (never fewer than the resolved rows); errors = inbox errors + ledger classes.
    const attempts = inbox ? Math.max(inbox.attempts, rows.filter((r) => r.edge === e.key).length) : undefined;
    return futuresPromotionVerdict(e.key as EdgeKey, rows, anomalyOpen, now, { basisUsd: limits.sizingBasisUsd, ...(inbox ? { executionErrors: inbox.errors + ledgerErrors, attempts } : {}) });
  });
  const stageRows = mergeRollChains(raw.filter((r) => r.stage === limits.stage));
  return {
    rows, leaderboard: futuresLeaderboard(rows, limits.sizingBasisUsd), distribution: profitDistribution(rows), promotion,
    readiness: { stage: limits.stage, readiness: stageReadiness(stageRows, limits.stage, limits) },
  };
}

/** The daily review: the day's resolved trades and inbox → vault (capped, oldest rolled to the archive) + one Slack line. */
export async function runDailyReview(dayKey: string, limits: DeskLimits): Promise<string[]> {
  const notes: string[] = [];
  const [raw, signals] = await Promise.all([journal(), signalsOn(dayKey)]);
  const rows = journalToMetricRows(raw).filter((r) => etDayKey(new Date(r.closedAt)) === dayKey);
  const { markdown, slack } = renderDailyReview({ dayKey, rows, signals, equitySamples: null, stage: limits.stage, basisUsd: limits.sizingBasisUsd });
  try {
    const { kept, archived } = rotateEntries(await vaultRead(DAILY_REVIEW_PATH), markdown, DAILY_REVIEW_CAP);
    if (archived) await vaultAppend(DAILY_REVIEW_ARCHIVE_PATH, archived, WRITER);
    await vaultWrite(DAILY_REVIEW_PATH, kept, WRITER);
    notes.push(`daily review ${dayKey}: ${rows.length} trade(s) written to ${DAILY_REVIEW_PATH}${archived ? " (oldest archived)" : ""}`);
  } catch (e) { notes.push(`daily review ${dayKey}: vault write failed — ${String(e).slice(0, 120)}`); }
  await sendNotification(slack, LANE).catch(() => notes.push("daily review: Slack failed"));
  return notes;
}

/** The weekly review: leaderboard tables, distribution, promotion verdicts, stage readiness → one vault document (overwritten). */
export async function runWeeklyReview(limits: DeskLimits, now = new Date()): Promise<string[]> {
  const notes: string[] = [];
  const snap = await reviewSnapshot(limits, now);
  const weekKey = isoWeekKey(now);
  const scoreBuckets = await scoreBucketReport(snap.rows).catch(() => null);
  const md = renderWeeklyReview({ weekKey, board: snap.leaderboard, distribution: snap.distribution, verdicts: snap.promotion, readiness: snap.readiness, generatedAt: now.toISOString(), scoreBuckets });
  try { await vaultWrite(WEEKLY_REVIEW_PATH, md, WRITER); notes.push(`weekly review ${weekKey}: written to ${WEEKLY_REVIEW_PATH}`); }
  catch (e) { notes.push(`weekly review ${weekKey}: vault write failed — ${String(e).slice(0, 120)}`); }
  const verdicts = snap.promotion.map((v) => `${v.edge} ${v.status}${v.failedGates.length ? ` (${v.failedGates.slice(0, 3).join(", ")}${v.failedGates.length > 3 ? ", …" : ""})` : ""}`).join(" · ");
  await sendNotification(`📊 FUTURES DESK weekly ${weekKey}: ${snap.rows.length} resolved · ${verdicts} · stage ${snap.readiness.stage} ${snap.readiness.readiness.ok ? "EARNED" : "not earned"}. Tables in ${WEEKLY_REVIEW_PATH}.`, LANE).catch(() => notes.push("weekly review: Slack failed"));
  return notes;
}
