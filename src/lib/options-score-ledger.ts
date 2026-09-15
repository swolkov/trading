// THE SCORE MEASUREMENT LEDGER (D7, Sep 15 2026) — pure, no I/O.
//
// Every research run archives its scored structures (`OptionsObservation.candidates`, breakouts AND
// Trend-watch names so thirty rows per bucket is reachable in weeks). Each is settled forward on later
// broker daily bars at min(expiry − 7 days, +10 sessions after the signal day) as intrinsic value minus
// the debit paid, per contract, minus the fee reserve — a SETTLEMENT PROXY: no fills, no slippage, no
// stop, no trail. It ranks the score, it does not estimate the desk's P&L. Buckets ≥80 / 70–79 / <70;
// the promotion verdict is green only with ≥30 resolved in every bucket, the top bucket's mean above
// the bottom's, and Welch t ≥ 2 between them. Pre-registered here before the first row was scored.
import { welchT } from "./margin-metrics";
import { liveEnterableKinds, screenResearchContracts, type OptionsResearch, type ResearchBar, type ResearchCandidate } from "./options-desk-model";
import { directionOfKind } from "./options-market-state";
import { optionsOpportunityScore, scoreInputsFor, ivRank, OPTIONS_SCORE_RULES, type OptionsScore } from "./options-score";
import { candidateKey } from "./options-trade-card";

export const OPTIONS_SCORE_LEDGER_RULES = {
  registeredAt: "2026-09-15",
  minPerBucket: 30, minT: 2,
  settleSessions: 10, settleBeforeExpiryDays: 7,
  buckets: [{ name: "≥80", lo: 80, hi: 101 }, { name: "70–79", lo: 70, hi: 80 }, { name: "<70", lo: -1, hi: 70 }] as const,
};
export type ScoreBucket = (typeof OPTIONS_SCORE_LEDGER_RULES.buckets)[number]["name"];
export const bucketOf = (score: number, rules = OPTIONS_SCORE_LEDGER_RULES): ScoreBucket => rules.buckets.find((b) => score >= b.lo && score < b.hi)?.name ?? "<70";

/** What one research run stamps per structure — enough to settle it later without the run's prices. */
export interface ScoredCandidate {
  key: string; symbol: string; kind: string; expiry: string; strikes: number[]; direction: "bullish" | "bearish";
  setup: string; signalDay: string; spot: number; debit: number; feeReserve: number; plannedLoss: number;
  score: number; missing: string[]; refusedBy: string | null; deltaBand: string; dteBucket: string;
  version: string;
}
export interface ResolvedCandidate extends ScoredCandidate {
  screenedAt: string; bucket: ScoreBucket; settledOn: string; settleClose: number; pnlUsd: number;
  note: "settlement proxy, no fills, no slippage";
}
export interface PendingCandidate extends ScoredCandidate { screenedAt: string; bucket: ScoreBucket; settlesBy: string }
const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const r2 = (x: number) => Math.round(x * 100) / 100;
/** Intrinsic value of the structure at close `S`, per share. */
export function intrinsicAt(kind: string, strikes: number[], S: number): number {
  const call = kind.startsWith("call") || kind === "long_call";
  const value = (k: number) => (call ? Math.max(0, S - k) : Math.max(0, k - S));
  return strikes.length === 2 ? value(strikes[0]) - value(strikes[1]) : value(strikes[0]);
}
/** Settlement P&L for one contract: intrinsic − debit, minus the fee reserve. */
export const settlementPnl = (c: ScoredCandidate, S: number) => r2((intrinsicAt(c.kind, c.strikes, S) - c.debit) * 100 - c.feeReserve);

/** One research run's ledger rows: every LIVE-ENTERABLE structure (debit only — `liveEnterableKinds`) the screen builds for breakouts AND
 *  Trend-watch names (`includeWatch`), scored. `ivRanks` come from the archive (options-score.ts `ivRank`); absent → the score lists IV-rank
 *  as missing. The live desk never sees these. Credit spreads never enter the ledger: the settlement math here is debit math. */
export function scoreResearchCandidates(data: OptionsResearch, cap: number, buyingPower: number, now: number, ivRanks: Record<string, number | null> = {}): { rows: ScoredCandidate[]; scores: Map<string, OptionsScore> } {
  const scores = new Map<string, OptionsScore>();
  const rows = liveEnterableKinds(screenResearchContracts(data, cap, buyingPower, now, { includeWatch: true })).map((c) => {
    const key = candidateKey(c), s = optionsOpportunityScore(scoreInputsFor(c, data.contracts, ivRanks[c.symbol] ?? null));
    scores.set(key, s);
    return scoredRow(c, key, s);
  });
  return { rows, scores };
}
export function scoredRow(c: ResearchCandidate, key: string, s: OptionsScore): ScoredCandidate {
  return { key, symbol: c.symbol, kind: c.kind, expiry: c.expiry, strikes: [...c.strikes], direction: directionOfKind(c.kind), setup: c.setup,
    signalDay: c.signalDay, spot: c.spot, debit: c.limit, feeReserve: c.feeReserve, plannedLoss: c.plannedLoss,
    score: s.score, missing: s.missing, refusedBy: c.refusedBy ?? null, deltaBand: c.deltaBand, dteBucket: c.dteBucket, version: s.version };
}
/** IV-ranks for every symbol in a snapshot from the archive's quotes (median IV per capture day; null under 30 days). */
export function ivRanksFor(data: OptionsResearch, observations: { capturedAt: string; quotes: { symbol: string; iv: number | null }[] }[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const symbol of new Set(data.contracts.map((c) => c.symbol))) {
    const ivs = data.contracts.filter((c) => c.symbol === symbol && c.iv != null && c.iv > 0).map((c) => c.iv as number).sort((a, b) => a - b);
    const cur = ivs.length ? (ivs.length % 2 ? ivs[(ivs.length - 1) / 2] : (ivs[ivs.length / 2 - 1] + ivs[ivs.length / 2]) / 2) : null;
    out[symbol] = ivRank(symbol, cur, observations, OPTIONS_SCORE_RULES).rank;
  }
  return out;
}
export interface LedgerObservation { screenedAt: string; candidates?: ScoredCandidate[] }
/** Settles every archived structure whose settlement session the bars have reached. ONE ROW PER STRUCTURE PER SETTLEMENT WINDOW: the first
 *  run that scored a structure (symbol/kind/expiry/strikes) owns it until that row settles; a Trend-watch name re-screened daily with
 *  overlapping windows would otherwise be counted many times over as one autocorrelated bet. A re-scoring after the settlement day starts a new row. */
export function resolveCandidates(observations: LedgerObservation[], bars: Record<string, ResearchBar[] | undefined>, rules = OPTIONS_SCORE_LEDGER_RULES): { resolved: ResolvedCandidate[]; pending: PendingCandidate[] } {
  const owned = new Map<string, string | null>(), resolved: ResolvedCandidate[] = [], pending: PendingCandidate[] = [];   // key → settledOn (null while pending)
  const sorted = [...observations].sort((a, b) => a.screenedAt.localeCompare(b.screenedAt));
  for (const o of sorted) for (const c of o.candidates ?? []) {
    const prior = owned.get(c.key);
    if (prior === null || (prior != null && o.screenedAt.slice(0, 10) <= prior)) continue;
    const rows = (bars[c.symbol] ?? []).filter((b) => b.day > c.signalDay).sort((a, b) => a.day.localeCompare(b.day));
    const lastDay = shiftDay(c.expiry, -rules.settleBeforeExpiryDays);
    // The settlement bar: the Nth session after the signal, or the last session on/before expiry − 7 days, whichever comes first.
    const byCount = rows[rules.settleSessions - 1] ?? null;
    const byExpiry = rows.filter((b) => b.day <= lastDay).at(-1) ?? null;
    const expiryReached = rows.some((b) => b.day > lastDay);   // a bar past the cutoff proves the cutoff session has closed
    const bar = byCount && (!byExpiry || byCount.day <= byExpiry.day) ? byCount : expiryReached ? byExpiry : null;
    const base = { ...c, screenedAt: o.screenedAt, bucket: bucketOf(c.score, rules) };
    if (!bar) { owned.set(c.key, null); pending.push({ ...base, settlesBy: lastDay }); continue; }
    owned.set(c.key, bar.day);
    resolved.push({ ...base, settledOn: bar.day, settleClose: bar.close, pnlUsd: settlementPnl(c, bar.close), note: "settlement proxy, no fills, no slippage" });
  }
  return { resolved, pending };
}
export interface BucketStat { name: ScoreBucket; n: number; mean: number | null; sd: number | null; t: number | null; net: number; hit: number | null; pnls: number[] }
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => (xs.length < 2 ? null : Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1)));
export function bucketStats(resolved: ResolvedCandidate[], rules = OPTIONS_SCORE_LEDGER_RULES): BucketStat[] {
  return rules.buckets.map((b) => {
    const pnls = resolved.filter((r) => r.bucket === b.name).map((r) => r.pnlUsd);
    const n = pnls.length, m = n ? mean(pnls) : null, s = sd(pnls);
    return { name: b.name, n, mean: m == null ? null : r2(m), sd: s == null ? null : r2(s), t: m == null || s == null || !(s > 0) ? null : r2(m / (s / Math.sqrt(n))), net: r2(pnls.reduce((a, x) => a + x, 0)), hit: n ? r2(pnls.filter((x) => x > 0).length / n) : null, pnls };
  });
}
export interface PromotionVerdict { green: boolean; reasons: string[]; welchT: number | null; registeredAt: string; rule: string }
/** Green only when every bucket has ≥30 resolved rows, the ≥80 bucket's mean beats the <70 bucket's, and Welch t between them is ≥ 2. */
export function promotionVerdict(buckets: BucketStat[], rules = OPTIONS_SCORE_LEDGER_RULES): PromotionVerdict {
  const reasons: string[] = [];
  const top = buckets.find((b) => b.name === "≥80")!, bottom = buckets.find((b) => b.name === "<70")!;
  for (const b of buckets) if (b.n < rules.minPerBucket) reasons.push(`${b.name}: ${b.n} of ${rules.minPerBucket} resolved`);
  const t = welchT(top.pnls, bottom.pnls);
  if (top.mean != null && bottom.mean != null && !(top.mean > bottom.mean)) reasons.push(`≥80 mean $${top.mean} does not beat <70 mean $${bottom.mean}`);
  if (t == null) { if (top.n >= 2 && bottom.n >= 2) reasons.push("no variance to test"); }
  else if (t < rules.minT) reasons.push(`Welch t ${t.toFixed(2)} < ${rules.minT}`);
  return { green: reasons.length === 0, reasons, welchT: t == null ? null : r2(t), registeredAt: rules.registeredAt, rule: `≥${rules.minPerBucket} resolved per bucket · ≥80 mean > <70 mean · Welch t ≥ ${rules.minT} · settlement proxy at min(expiry − ${rules.settleBeforeExpiryDays}d, +${rules.settleSessions} sessions) · one row per structure per settlement window (first scoring wins) · debit structures only, credit spreads not measured yet` };
}
