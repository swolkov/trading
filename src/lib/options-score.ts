// THE 0–100 OPTIONS OPPORTUNITY SCORE (D7, Sep 15 2026) — a PAPER RANKER, pure, no I/O.
//
// The prompt asks for a score with an 80+ live line. On this account weighted scores have ranked
// backwards before (the crypto conviction score), so this one is stamped on every researched structure
// and MEASURED against a settlement proxy (options-score-ledger.ts) before it is allowed near a
// decision. It is promoted to a live input only when the ≥80 bucket beats the <70 bucket at t ≥ 2 with
// thirty resolved rows in each. Until then nothing in the entry path imports this file — a test asserts it.
//
// Components (max points): direction 20 · catalyst 15 · pricing 15 · liquidity 10 · R:R 15 · momentum 10 ·
// market 5 · EV 10. A missing input scores its neutral floor and is named in `missing`; IV-rank in
// particular needs ≥30 archive days and is listed as missing until the archive has them.
import type { EarningsClass } from "./options-events";
import type { ResearchCandidate, ResearchContract } from "./options-desk-model";

export const OPTIONS_SCORE_RULES = {
  liveLine: 80,               // the prompt's line — a ranker until promoted
  ivRankMinDays: 30,          // archive days before an IV-rank is a number rather than a `missing`
  eventWindowDays: 3,         // an event within this many days of expiry costs 5 catalyst points
  version: "options-score-v1",
};
export type ComponentName = "direction" | "catalyst" | "pricing" | "liquidity" | "riskReward" | "momentum" | "market" | "ev";
export const SCORE_CAPS: Record<ComponentName, number> = { direction: 20, catalyst: 15, pricing: 15, liquidity: 10, riskReward: 15, momentum: 10, market: 5, ev: 10 };
export interface ScoreComponent { points: number; max: number; note: string }
export interface OptionsScore { score: number; components: Record<ComponentName, ScoreComponent>; missing: string[]; liveLine: number; label: "paper ranker"; version: string }
export interface ScoreInputs {
  setup: string; relativeVolume: number | null; chase: number | null;
  earningsClass: EarningsClass; earningsAt: string | null; exDivAt: string | null; expiry: string;
  ivToRealized: number | null; ivRank: number | null; spreadPct: number | null;
  /** Net theta per day as a percentage of the debit paid (positive number = decay). */
  thetaPerDayPct: number | null;
  openInterest: number | null; volume: number | null;
  payoffAtMoveUsd: number | null; plannedLoss: number; maxProfit: number | null;
  marketAligned: boolean | null;
  /** |delta| of the long leg — the proxy for the probability the move reaches the payoff. */
  targetDelta: number | null;
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const days = (a: string, b: string) => (Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
const validDay = (s: string | null | undefined): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(Date.parse(s.slice(0, 10)));

export function optionsOpportunityScore(i: ScoreInputs, rules = OPTIONS_SCORE_RULES): OptionsScore {
  const missing: string[] = [];
  const c = {} as Record<ComponentName, ScoreComponent>;
  const put = (name: ComponentName, points: number, note: string) => { c[name] = { points: clamp(Math.round(points * 10) / 10, 0, SCORE_CAPS[name]), max: SCORE_CAPS[name], note }; };
  // Direction: a breakout/breakdown with the 50/200 trend aligned is the whole signal; a trend without the trigger is half a reason.
  const breakout = i.setup === "20-session breakout" || i.setup === "20-session breakdown";
  put("direction", breakout ? 20 : i.setup === "Trend watch" ? 8 : 0, breakout ? `${i.setup} with the trend aligned` : i.setup === "Trend watch" ? "trend aligned, no range break" : "no directional setup");
  // Catalyst: earnings inside the expiry is an earnings trade → 0; an event within 3 days of expiry → −5; unknown → half, named.
  {
    let pts = 15, note = "no earnings before expiry";
    if (i.earningsClass === "EARNINGS TRADE" || (validDay(i.earningsAt) && days(i.earningsAt, i.expiry) >= 0)) { pts = 0; note = `earnings ${i.earningsAt ?? ""} inside the expiry`; }
    else if (i.earningsClass === "unknown") { pts = 7; note = "earnings unknown"; missing.push("earnings calendar"); }
    else {
      const near = [i.earningsAt, i.exDivAt].filter(validDay).map((d) => Math.abs(days(d, i.expiry))).filter((n) => n <= rules.eventWindowDays);
      if (near.length) { pts -= 5; note = `an event within ${rules.eventWindowDays} days of expiry (−5)`; }
    }
    put("catalyst", pts, note);
  }
  // Pricing: IV/RV (5), IV-rank (4, only with ≥30 archive days), spread (3), theta per day as % of premium (3).
  {
    const notes: string[] = [];
    let pts = 0;
    if (i.ivToRealized == null) { pts += 2; missing.push("IV/RV"); notes.push("IV/RV unknown"); }
    else { pts += i.ivToRealized <= 1 ? 5 : i.ivToRealized <= 1.15 ? 4 : i.ivToRealized <= 1.5 ? 2 : 1; notes.push(`IV/RV ${i.ivToRealized}×`); }
    if (i.ivRank == null) { missing.push(`IV-rank (needs ≥${rules.ivRankMinDays} archive days)`); notes.push("IV-rank missing"); }
    else { pts += i.ivRank < 30 ? 4 : i.ivRank < 50 ? 3 : i.ivRank < 70 ? 2 : 1; notes.push(`IV-rank ${Math.round(i.ivRank)}`); }
    if (i.spreadPct == null) { pts += 1; missing.push("spread %"); notes.push("spread unknown"); }
    else { pts += i.spreadPct <= 3 ? 3 : i.spreadPct <= 5 ? 2 : i.spreadPct <= 10 ? 1 : 0; notes.push(`spread ${i.spreadPct}%`); }
    if (i.thetaPerDayPct == null) { pts += 1; missing.push("theta/day"); notes.push("theta unknown"); }
    else { pts += i.thetaPerDayPct <= 1 ? 3 : i.thetaPerDayPct <= 2 ? 2 : i.thetaPerDayPct <= 3 ? 1 : 0; notes.push(`theta ${i.thetaPerDayPct.toFixed(1)}%/day of premium`); }
    put("pricing", pts, notes.join(" · "));
  }
  // Liquidity: the thinner leg's open interest and volume (the screen already requires 500 / 100).
  {
    if (i.openInterest == null || i.volume == null) { put("liquidity", 4, "liquidity unknown"); missing.push("open interest / volume"); }
    else { const oi = i.openInterest, v = i.volume; put("liquidity", oi >= 5000 && v >= 1000 ? 10 : oi >= 2000 && v >= 500 ? 8 : oi >= 1000 && v >= 200 ? 6 : oi >= 500 && v >= 100 ? 4 : 2, `OI ${oi} · volume ${v}`); }
  }
  // R:R: payoff at the market's expected move over the planned loss — the measured ratio, not a hoped-for target.
  {
    const rr = i.payoffAtMoveUsd == null || !(i.plannedLoss > 0) ? null : i.payoffAtMoveUsd / i.plannedLoss;
    if (rr == null) { put("riskReward", 0, "payoff at the expected move unknown"); missing.push("expected move"); }
    else put("riskReward", rr >= 3 ? 15 : rr >= 2 ? 12 : rr >= 1.5 ? 9 : rr >= 1 ? 6 : rr > 0 ? 3 : 0, `${rr.toFixed(2)}× the risk at the expected move${i.maxProfit == null ? " (uncapped)" : ""}`);
  }
  // Momentum: relative volume on the signal day; a chase ≥2× (already at the implied daily move twice over) halves it.
  {
    if (i.relativeVolume == null) { put("momentum", 4, "relative volume unknown"); missing.push("relative volume"); }
    else {
      const base = i.relativeVolume >= 2 ? 10 : i.relativeVolume >= 1.5 ? 8 : i.relativeVolume >= 1 ? 5 : 2;
      const chased = i.chase != null && i.chase >= 2;
      put("momentum", chased ? base / 2 : base, `relative volume ${i.relativeVolume.toFixed(2)}×${chased ? ` · chase ${i.chase}× (halved)` : i.chase != null ? ` · chase ${i.chase}×` : ""}`);
    }
  }
  // Market: SPY on the right side of its 20-day for the direction.
  if (i.marketAligned == null) { put("market", 2, "market state unknown"); missing.push("market alignment"); }
  else put("market", i.marketAligned ? 5 : 0, i.marketAligned ? "SPY aligned with the direction" : "SPY against the direction");
  // EV: payoff × p − loss × (1 − p) with p = the long leg's |delta| — a PROXY for the probability of reaching the payoff, said so.
  {
    const p = i.targetDelta == null ? null : clamp(Math.abs(i.targetDelta), 0, 1);
    if (p == null || i.payoffAtMoveUsd == null || !(i.plannedLoss > 0)) { put("ev", 0, "EV unknown (delta or payoff missing)"); missing.push("EV inputs"); }
    else {
      const ev = i.payoffAtMoveUsd * p - i.plannedLoss * (1 - p), evPerDollar = ev / i.plannedLoss;
      put("ev", evPerDollar >= 0.5 ? 10 : evPerDollar >= 0.25 ? 7 : evPerDollar >= 0 ? 4 : 0, `EV $${ev.toFixed(0)} per contract at p = ${p.toFixed(2)} (delta as the probability proxy)`);
    }
  }
  const score = clamp(Math.round(Object.values(c).reduce((s, x) => s + x.points, 0)), 0, 100);
  return { score, components: c, missing, liveLine: rules.liveLine, label: "paper ranker", version: rules.version };
}

/** The score's inputs from a screened research row plus the snapshot's contracts (for the legs' delta/theta/liquidity). */
export function scoreInputsFor(c: ResearchCandidate, contracts: ResearchContract[], ivRank: number | null): ScoreInputs {
  const by = new Map(contracts.map((k) => [k.id, k]));
  const legs = c.legs.map((id) => by.get(id)).filter((k): k is ResearchContract => !!k);
  const long = legs[0], short = legs[1];
  const netTheta = long?.theta != null && (!short || short.theta != null) ? long.theta - (short?.theta ?? 0) : null;
  return {
    setup: c.setup, relativeVolume: c.relativeVolume, chase: c.chase,
    earningsClass: c.earningsClass, earningsAt: c.earningsAt, exDivAt: c.exDivAt, expiry: c.expiry,
    ivToRealized: c.ivToRealized, ivRank, spreadPct: c.spreadPct,
    thetaPerDayPct: netTheta == null || !(c.limit > 0) ? null : Math.round(Math.abs(netTheta) / c.limit * 10000) / 100,
    openInterest: legs.length === c.legs.length && legs.length ? Math.min(...legs.map((k) => k.openInterest)) : null,
    volume: legs.length === c.legs.length && legs.length ? Math.min(...legs.map((k) => k.volume)) : null,
    payoffAtMoveUsd: c.payoffAtMoveUsd, plannedLoss: c.plannedLoss, maxProfit: c.maxProfit,
    marketAligned: c.market.aligned, targetDelta: long?.delta ?? null,
  };
}

/** IV-rank of `currentIv` against the archive's per-day IV for the symbol (the median IV of its researched contracts on each capture day).
 *  null (with the day count) until the archive holds ≥30 distinct days — a rank on a week of data is noise dressed as a percentile. */
export function ivRank(symbol: string, currentIv: number | null, observations: { capturedAt: string; quotes: { symbol: string; iv: number | null }[] }[], rules = OPTIONS_SCORE_RULES): { rank: number | null; days: number } {
  const byDay = new Map<string, number[]>();
  for (const o of observations) {
    const ivs = o.quotes.filter((q) => q.symbol === symbol && q.iv != null && q.iv > 0).map((q) => q.iv as number);
    if (!ivs.length) continue;
    const day = o.capturedAt.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), ...ivs]);
  }
  const daily = [...byDay.values()].map((ivs) => { const s = [...ivs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; });
  const n = daily.length;
  if (n < rules.ivRankMinDays || currentIv == null || !(currentIv > 0)) return { rank: null, days: n };
  const lo = Math.min(...daily), hi = Math.max(...daily);
  return { rank: hi > lo ? Math.round(clamp((currentIv - lo) / (hi - lo), 0, 1) * 100) : 50, days: n };
}
