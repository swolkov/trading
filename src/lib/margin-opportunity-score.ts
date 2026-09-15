// THE 0–100 OPPORTUNITY SCORE (Sep 15 2026) — a PAPER RANKER, never a gate.
//
// The prompts want every candidate scored 0–100 and only ≥80 taken live. This desk's own
// conviction score ranks BACKWARDS on the record (the "does conviction matter?" table), so a
// weighted score is not trusted until it is MEASURED: the scan stamps this on every fresh
// breakout/breakdown (opportunity_score / opportunity_json), the paper page slices outcomes by
// bucket (margin-opportunity-slices.ts), and only a PROMOTABLE verdict — both buckets ≥30
// resolved, t(≥80) ≥ 2, ≥80 out-earning <80 per trade — earns it a place in the executor, in a
// later PR, after a Fable review. Until then nothing reads it but the stamp and the page.
// Pinned by test: margin-executor, margin-auto-plans, margin-live-risk and margin-risk-tiers
// do not import this module.
//
// Components and caps (the prompt's weights). Every component is monotone in its input, bounded
// by its cap, and deterministic; a missing input scores its neutral value and is NAMED in
// `missing` so a stamped 62 with three unknowns is not read like a 62 with none.
//
//   structure  20  the 20-bar break itself (8) + 4 per timeframe (1d/4h/1h) trending its way
//   momentum   10  distance above/below the signal timeframe's 20-bar mean, in the trade's
//                  direction, 3% = full — halved when the RSI is stretched (≥75 long / ≤25 short:
//                  buying the RSI extreme was a coin flip on this record)
//   volume     10  last completed bar ÷ 20-bar average volume, 3× = full
//   OI         10  24h open-interest change, −5% = 0 … +10% = full (participation behind the
//                  break, either direction); unknown → 5 + missing
//   funding    10  relative funding per 8h AGAINST the trade: longs score higher when funding
//                  ≤ 0 (the crowd is short), symmetric for shorts; unknown → 5 + missing
//   catalyst   15  event policy — normal 15 / reduced 7 / paused 0. PENALTY ONLY: there is no
//                  news upside (news-reaction trading died out-of-sample on this account)
//   liquidity  10  static tier by coin (LIQUIDITY_TIER) — a proxy for spread and depth
//   R:R        10  room to the 90-bar 4h extreme ÷ the container stop, 3R = full; a break to a
//                  NEW 90-bar extreme has no overhead level and scores full
//   macro       5  the BTC daily regime agrees with the trade (up for longs, down for shorts);
//                  unknown → 2 + missing
import type { TfFeatures } from "@/lib/margin-scanner";
import type { MtfState } from "@/lib/margin-mtf";

/** The prompt's line — a ranker until promoted. Nothing gates on it in this PR. */
export const OPP_LIVE_LINE = 80;

export const OPP_CAPS = { structure: 20, momentum: 10, volume: 10, oi: 10, funding: 10, catalyst: 15, liquidity: 10, rr: 10, macro: 5 } as const;
export type OppComponent = keyof typeof OPP_CAPS;

/** Static liquidity tier per coin (points out of 10). Unlisted → 3. */
export const LIQUIDITY_TIER: Record<string, number> = {
  BTC: 10, ETH: 10,
  SOL: 8, XRP: 8, DOGE: 8, ADA: 8, AVAX: 8, LINK: 8, LTC: 8, SUI: 8,
  AAVE: 5, BCH: 5, CRV: 5, DOT: 5, HBAR: 5, HYPE: 5, PEPE: 5, SHIB: 5, TRX: 5, UNI: 5, ZEC: 5, ALGO: 5, NEAR: 5, RENDER: 5, XLM: 5,
  PENGU: 3,
};
export const LIQUIDITY_DEFAULT = 3;

export interface OpportunityInputs {
  coin: string;
  side: "buy" | "sell";
  signal: TfFeatures | null | undefined;      // the signal timeframe's features
  h4: TfFeatures | null | undefined;          // the 4h features (for the 90-bar extreme)
  mtf: MtfState | null | undefined;
  eventMode: "normal" | "reduced" | "paused" | null | undefined;
  funding8hRel: number | null | undefined;
  oiChg24h: number | null | undefined;
  btcRegime: "up" | "down" | "unknown" | null | undefined;
  stopFrac: number;                           // the container's 1R as a fraction of entry (0.04)
}
export interface OpportunityScore {
  score: number;                              // 0–100, integer
  components: Record<OppComponent, number>;
  missing: string[];
}

const fin = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export function opportunityScore(i: OpportunityInputs): OpportunityScore {
  const dir = i.side === "buy" ? 1 : -1;
  const missing: string[] = [];
  const c: Record<OppComponent, number> = { structure: 0, momentum: 0, volume: 0, oi: 0, funding: 0, catalyst: 0, liquidity: 0, rr: 0, macro: 0 };

  // structure: the break is given; alignment adds 4 per timeframe.
  const want = i.side === "buy" ? "up" : "down";
  let aligned = 0;
  if (i.mtf) { for (const k of ["d1", "h4", "h1"] as const) if (i.mtf[k] === want) aligned++; }
  else missing.push("mtf");
  c.structure = 8 + 4 * aligned;

  // momentum: directional distance from the signal TF's 20-bar mean; stretched halves it.
  if (i.signal && fin(i.signal.close) && fin(i.signal.sma20) && i.signal.sma20 > 0) {
    const move = dir * (i.signal.close / i.signal.sma20 - 1);
    let m = OPP_CAPS.momentum * clamp01(move / 0.03);
    const rsi = i.signal.rsi14;
    if (fin(rsi) && ((i.side === "buy" && rsi >= 75) || (i.side === "sell" && rsi <= 25))) m *= 0.5;
    c.momentum = m;
  } else missing.push("momentum");

  // volume: last completed bar vs its 20-bar average.
  if (i.signal && fin(i.signal.volRatio20)) c.volume = OPP_CAPS.volume * clamp01((i.signal.volRatio20 - 1) / 2);
  else missing.push("volume");

  // OI: −5% → 0, +10% → full; unknown → half.
  if (fin(i.oiChg24h)) c.oi = OPP_CAPS.oi * clamp01((i.oiChg24h + 0.05) / 0.15);
  else { c.oi = OPP_CAPS.oi / 2; missing.push("oi"); }

  // funding: against the trade. Long: f = −0.03%/8h → full, +0.03% → 0. Short mirrored.
  if (fin(i.funding8hRel)) c.funding = OPP_CAPS.funding * clamp01((0.0003 - dir * i.funding8hRel) / 0.0006);
  else { c.funding = OPP_CAPS.funding / 2; missing.push("funding"); }

  // catalyst: penalty only.
  if (i.eventMode === "normal") c.catalyst = 15;
  else if (i.eventMode === "paused") c.catalyst = 0;
  else { c.catalyst = 7; if (i.eventMode !== "reduced") missing.push("event"); }

  // liquidity: static tier.
  c.liquidity = Object.hasOwn(LIQUIDITY_TIER, i.coin) ? LIQUIDITY_TIER[i.coin] : LIQUIDITY_DEFAULT;

  // R:R: room to the 90-bar 4h extreme ÷ stop; at/through the extreme = open sky = full.
  const px = i.h4?.close;
  const extreme = i.side === "buy" ? i.h4?.hh90 : i.h4?.ll90;
  if (i.h4 && fin(px) && px > 0 && fin(extreme) && fin(i.stopFrac) && i.stopFrac > 0) {
    const room = dir * (extreme - px) / px;
    c.rr = room <= 0 ? OPP_CAPS.rr : OPP_CAPS.rr * clamp01(room / i.stopFrac / 3);
  } else missing.push("rr");

  // macro: BTC daily regime agreement.
  if (i.btcRegime === "up" || i.btcRegime === "down") c.macro = i.btcRegime === want ? OPP_CAPS.macro : 0;
  else { c.macro = 2; missing.push("btcRegime"); }

  for (const k of Object.keys(c) as OppComponent[]) c[k] = Math.max(0, Math.min(OPP_CAPS[k], Math.round(c[k] * 100) / 100));
  const total = Object.values(c).reduce((s, x) => s + x, 0);
  return { score: Math.max(0, Math.min(100, Math.round(total))), components: c, missing };
}

/** The bucket a score falls in — the same three the slices read. */
export function opportunityBucket(score: number | null | undefined): "≥80" | "60–79" | "<60" | "unscored" {
  if (score == null || !Number.isFinite(score)) return "unscored";
  return score >= OPP_LIVE_LINE ? "≥80" : score >= 60 ? "60–79" : "<60";
}
