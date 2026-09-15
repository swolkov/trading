// THE SCORE REPORT (D7) — the one I/O seam for "does the 0–100 score rank?": reads the archived ledger rows, settles them on the
// current research snapshot's broker bars, and returns buckets + the promotion verdict. Used by /api/options/score and the
// admin's typed PROMOTE action. Read-only; nothing here writes.
import { prisma } from "./db";
import { OPTIONS_RESEARCH_KEY, isOptionsResearch, type OptionsResearch } from "./options-desk-model";
import { readOptionsScoredHistory } from "./options-evidence-store";
import { OPTIONS_SCORE_LEDGER_RULES, bucketStats, promotionVerdict, resolveCandidates, type BucketStat, type PromotionVerdict, type ResolvedCandidate, type ScoredCandidate } from "./options-score-ledger";
import { OPTIONS_SCORE_RULES } from "./options-score";
import { readOptionsTradeCards, type StoredTradeCard } from "./options-trade-card-store";

export const OPTIONS_SCORE_PROMOTED_KEY = "options_score_promoted";
export interface OptionsScoreReport {
  at: string; registeredAt: string; version: string; liveLine: number; promoted: boolean;
  runs: number; scored: number; resolved: number; pending: number;
  buckets: Omit<BucketStat, "pnls">[]; verdict: PromotionVerdict;
  bySource: { breakouts: number; watch: number };
  recentResolved: ResolvedCandidate[]; latestScored: ScoredCandidate[]; latestScoredAt: string | null;
  cards: StoredTradeCard[];
}
export async function optionsScoreReport(): Promise<OptionsScoreReport> {
  const [history, rows, cards] = await Promise.all([
    readOptionsScoredHistory().catch(() => []),
    prisma.agentConfig.findMany({ where: { key: { in: [OPTIONS_RESEARCH_KEY, OPTIONS_SCORE_PROMOTED_KEY] } } }),
    readOptionsTradeCards(20).catch(() => []),
  ]);
  const c = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let research: OptionsResearch | null = null;
  try { const parsed = JSON.parse(c[OPTIONS_RESEARCH_KEY] ?? "null"); if (isOptionsResearch(parsed)) research = parsed; } catch { /* no bars → nothing settles */ }
  const { resolved, pending } = resolveCandidates(history, research?.bars ?? {});
  const buckets = bucketStats(resolved);
  const latest = history.at(-1) ?? null;
  return {
    at: new Date().toISOString(), registeredAt: OPTIONS_SCORE_LEDGER_RULES.registeredAt, version: OPTIONS_SCORE_RULES.version, liveLine: OPTIONS_SCORE_RULES.liveLine,
    promoted: c[OPTIONS_SCORE_PROMOTED_KEY] === "true",
    runs: history.length, scored: history.reduce((n, o) => n + (o.candidates?.length ?? 0), 0), resolved: resolved.length, pending: pending.length,
    buckets: buckets.map((b) => ({ name: b.name, n: b.n, mean: b.mean, sd: b.sd, t: b.t, net: b.net, hit: b.hit })), verdict: promotionVerdict(buckets),
    bySource: { breakouts: resolved.filter((r) => !r.refusedBy).length, watch: resolved.filter((r) => r.refusedBy === "no breakout").length },
    recentResolved: resolved.slice(-12).reverse(), latestScored: [...(latest?.candidates ?? [])].sort((a, b) => b.score - a.score).slice(0, 10), latestScoredAt: latest?.screenedAt ?? null,
    cards,
  };
}
