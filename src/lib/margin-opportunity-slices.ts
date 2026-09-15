// DOES THE 0–100 SCORE RANK? (Sep 15 2026) — the pre-registered read of the opportunity score
// against outcomes, in the same slice shape as candidateDetail()'s cuts (margin-shadow.ts).
// Registered before any stamped row resolved, so no bucket edge is chosen after seeing it.
//
// Buckets: ≥80 (the prompt's live line) / 60–79 / <60, plus three companion cuts of the same
// sleeve — by event mode, by MTF alignment, by funding sign — through margin-shadow's own
// candidateSlice() (the same aggregate as the live candidate's cuts), each read only at
// SLICE_MIN_RESOLVED. promotionVerdict() is the ONE rule that can ever earn the score a live
// gate: both ≥80 and <80 have ≥30 resolved, t(≥80) ≥ 2, and ≥80 out-earns <80 per trade.
// Six cuts of one sleeve is six chances for luck — the page says so beside the table.
import { SLICE_MIN_RESOLVED, candidateSlice, ensureShadowColumns, type CandidateSlice } from "@/lib/margin-shadow";
import { OPP_LIVE_LINE } from "@/lib/margin-opportunity-score";

export const OPP_PREREGISTERED_AT = "2026-09-15";
export const OPP_MIN_T = 2;

export interface OpportunityBuckets {
  source: string;
  byScore: CandidateSlice[];          // ≥80 / 60–79 / <60 / unscored
  byLine: CandidateSlice[];           // ≥80 / <80 (the promotion comparison)
  byEventMode: CandidateSlice[];
  byMtfAligned: CandidateSlice[];
  byFundingSign: CandidateSlice[];
}

const SCORE_SQL = `CASE WHEN opportunity_score IS NULL THEN 'unscored' WHEN opportunity_score >= ${OPP_LIVE_LINE} THEN '≥${OPP_LIVE_LINE}' WHEN opportunity_score >= 60 THEN '60–79' ELSE '<60' END`;
const LINE_SQL = `CASE WHEN opportunity_score IS NULL THEN 'unscored' WHEN opportunity_score >= ${OPP_LIVE_LINE} THEN '≥${OPP_LIVE_LINE}' ELSE '<${OPP_LIVE_LINE}' END`;
const EVENT_SQL = `COALESCE(event_mode, 'unstamped')`;
const MTF_SQL = `CASE WHEN mtf_state IS NULL THEN 'unstamped' WHEN mtf_state='U/U/U' THEN 'aligned long' WHEN mtf_state='D/D/D' THEN 'aligned short' ELSE 'not aligned' END`;
const FUNDING_SQL = `CASE WHEN deriv_funding IS NULL THEN 'unstamped' WHEN deriv_funding <= 0 THEN 'funding ≤ 0' ELSE 'funding > 0' END`;

const ORDER: Record<string, number> = { [`≥${OPP_LIVE_LINE}`]: 0, "60–79": 1, "<60": 2, [`<${OPP_LIVE_LINE}`]: 3, unscored: 9, normal: 0, reduced: 1, paused: 2, "aligned long": 0, "aligned short": 1, "not aligned": 2, "funding ≤ 0": 0, "funding > 0": 1, unstamped: 9 };
const sorted = (xs: CandidateSlice[]) => [...xs].sort((a, b) => (ORDER[a.key] ?? 5) - (ORDER[b.key] ?? 5));

export async function opportunityBuckets(source: string): Promise<OpportunityBuckets> {
  await ensureShadowColumns();
  const [byScore, byLine, byEventMode, byMtfAligned, byFundingSign] = await Promise.all([
    candidateSlice(source, SCORE_SQL), candidateSlice(source, LINE_SQL), candidateSlice(source, EVENT_SQL), candidateSlice(source, MTF_SQL), candidateSlice(source, FUNDING_SQL),
  ]);
  return { source, byScore: sorted(byScore), byLine: sorted(byLine), byEventMode: sorted(byEventMode), byMtfAligned: sorted(byMtfAligned), byFundingSign: sorted(byFundingSign) };
}

export type PromotionStatus = "PROMOTABLE" | "gathering" | "not ranking";
export interface OpportunityPromotion { status: PromotionStatus; reasons: string[]; hi: CandidateSlice | null; lo: CandidateSlice | null }

/**
 * Pure. THE rule: both buckets ≥ SLICE_MIN_RESOLVED, t(≥80) ≥ OPP_MIN_T, and net/trade(≥80) >
 * net/trade(<80). Anything thinner is "gathering"; a full sample that fails is "not ranking".
 */
export function promotionVerdict(byLine: Pick<CandidateSlice, "key" | "resolved" | "net" | "tStat">[]): OpportunityPromotion {
  const hi = (byLine.find((s) => s.key === `≥${OPP_LIVE_LINE}`) ?? null) as CandidateSlice | null;
  const lo = (byLine.find((s) => s.key === `<${OPP_LIVE_LINE}`) ?? null) as CandidateSlice | null;
  const reasons: string[] = [];
  const hiN = hi?.resolved ?? 0, loN = lo?.resolved ?? 0;
  if (hiN < SLICE_MIN_RESOLVED || loN < SLICE_MIN_RESOLVED) {
    reasons.push(`≥${OPP_LIVE_LINE}: ${hiN}/${SLICE_MIN_RESOLVED} resolved · <${OPP_LIVE_LINE}: ${loN}/${SLICE_MIN_RESOLVED} resolved`);
    return { status: "gathering", reasons, hi, lo };
  }
  const t = hi!.tStat;
  const hiPer = hi!.net / hiN, loPer = lo!.net / loN;
  if (t == null || !Number.isFinite(t) || t < OPP_MIN_T) reasons.push(`t(≥${OPP_LIVE_LINE}) = ${t == null ? "—" : t.toFixed(2)} < ${OPP_MIN_T}`);
  if (!(hiPer > loPer)) reasons.push(`net/trade ≥${OPP_LIVE_LINE} $${hiPer.toFixed(0)} does not beat <${OPP_LIVE_LINE} $${loPer.toFixed(0)}`);
  if (reasons.length) return { status: "not ranking", reasons, hi, lo };
  reasons.push(`t(≥${OPP_LIVE_LINE}) = ${t!.toFixed(2)} ≥ ${OPP_MIN_T}; net/trade $${hiPer.toFixed(0)} vs $${loPer.toFixed(0)} on ${hiN}/${loN} resolved`);
  return { status: "PROMOTABLE", reasons, hi, lo };
}
