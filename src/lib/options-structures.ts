// OPTIONS STRUCTURE ENGINE. PURE: no database, no network, no clock beyond what is passed in.
//
// WHAT THIS IS FOR. Until Sep 10 2026 this book had exactly one shape: an in-the-money call,
// 60-120 days out. Level 3 approval means it can now also build defined-risk spreads, and the
// question "which structure best expresses this signal?" became real rather than rhetorical.
// This module answers it the same way the rest of the book answers everything — by computing
// observable quantities from quoted prices and applying a rule fixed in advance.
//
// WHAT IT DELIBERATELY IS NOT. It does not score candidates 0-100 on a weighted blend of
// judgement. A weighted subjective score produces a number that feels objective and cannot be
// falsified — and this desk has already been burned by exactly that: the crypto book's
// conviction score turned out to rank BACKWARDS, and looked perfectly reasonable while doing
// it. Everything here is either a quoted price, arithmetic on quoted prices, or a threshold
// written down before the data was seen.
//
// THE REFERENCE MOVE. Candidates are ranked by what they are worth if the underlying moves by
// the amount THE OPTIONS MARKET ITSELF is pricing — the expected move, taken from the
// at-the-money straddle. That is a real quoted number, not a forecast, and it gives every
// structure a common yardstick: a far out-of-the-money lottery ticket scores badly because it
// is still worthless at the expected move, and a deep in-the-money call scores badly because
// it costs a fortune to capture the same move. This is the honest version of "compare
// strikes and expirations" — the comparison needs a benchmark, and the market supplies one.
import {
  MAX_DELTA, MIN_DELTA, type Contract,
  entryCostUsd, spreadCreditUsd, spreadDebitUsd, tradeable,
} from "@/lib/options-paper-model";

/** Every structure this book can express. Bearish shapes are BUILT but gated off at the
 *  caller (see `BULLISH_KINDS`): the only entry signal this desk has validated is a long
 *  trend break, and its own crypto record found the mirrored short signal lost on every
 *  slice. The shapes exist so that adding a bearish signal later is a config change and not
 *  a rewrite — not because anyone has evidence for one today. */
export type StructureKind =
  | "long_call" | "long_put"
  | "call_debit" | "put_debit"
  | "put_credit" | "call_credit";

export const BULLISH_KINDS: readonly StructureKind[] = ["long_call", "call_debit", "put_credit"];
export const BEARISH_KINDS: readonly StructureKind[] = ["long_put", "put_debit", "call_credit"];


export interface Leg { contract: Contract; side: "buy" | "sell" }

// ---------- Cross-leg sanity ----------
//
// The exit path checks every leg's quote age carefully. Entry did not, and `tradeable()`
// judges each leg in ISOLATION — so a vertical could be assembled from two quotes up to the
// store's full 36-hour window apart and pass every gate.
//
// That is not a theoretical worry on a 90-100% implied-vol universe, and it is worse than a
// stale price: the ranking divides by capital at risk, and on a credit spread the capital at
// risk IS width minus credit. A stale leg inflates the credit, which SHRINKS the denominator,
// which inflates the return — so the metric is structurally attracted to whichever pair of
// legs is most mispriced. A gapped-overnight name with one unrefreshed strike wins the
// ranking precisely because its price is wrong.
export const MAX_LEG_QUOTE_SKEW_MS = 60 * 60_000;

/** True when two legs were quoted close enough together to be one tradeable price.
 *  Permissive when a timestamp is missing — unit tests build contracts without one, and the
 *  quote store's own freshness gate still applies — but the scanner always supplies them. */
export function legsQuotedTogether(a: Contract, b: Contract): boolean {
  if (!a.quoteTs || !b.quoteTs) return true;
  const ta = Date.parse(a.quoteTs), tb = Date.parse(b.quoteTs);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return Math.abs(ta - tb) <= MAX_LEG_QUOTE_SKEW_MS;
}

/** A credit above this fraction of the width means the short leg is effectively at or in the
 *  money, or one of the legs is mispriced. Since a sold leg is already required to be out of
 *  the money, a credit this large is a data problem rather than an opportunity. A sanity
 *  bound, not a tuned parameter. */
export const MAX_CREDIT_FRAC_OF_WIDTH = 0.60;

export interface Candidate {
  kind: StructureKind;
  legs: Leg[];
  expiry: string;
  /** Cash paid (debit, positive) or received (credit, positive) at entry, fees included. */
  debitUsd: number;
  creditUsd: number;
  /** The most this position can lose — and, for a credit structure, the collateral tied up. */
  capitalAtRiskUsd: number;
  /** null when genuinely unbounded (a naked long call). */
  maxProfitUsd: number | null;
  maxLossUsd: number;
  breakeven: number;
  /** Half the quoted spread on every leg — what crossing costs to get in. */
  crossingCostUsd: number;
  netDelta: number;
  netTheta: number;
}

// ---------- Expected move ----------
// From the at-the-money straddle: call mid + put mid, as a fraction of spot. A quoted number,
// not a forecast. Used only as a common yardstick for comparing structures against each other.
export function midOf(c: Pick<Contract, "bid" | "ask">): number { return (c.bid + c.ask) / 2; }

export function expectedMove(atmCall: Contract | null, atmPut: Contract | null, spot: number): number | null {
  if (!atmCall || !atmPut || !(spot > 0)) return null;
  const straddle = midOf(atmCall) + midOf(atmPut);
  return straddle > 0 ? straddle / spot : null;
}

/** The listed strike closest to spot on one expiry. Calls and puts arrive as separate
 *  arrays, so this needs no type argument — pass whichever side you want the at-the-money of. */
export function atmOf(candidates: Contract[], spot: number, expiry: string): Contract | null {
  let best: Contract | null = null;
  for (const c of candidates) {
    if (c.expiry !== expiry) continue;
    if (!best || Math.abs(c.strike - spot) < Math.abs(best.strike - spot)) best = c;
  }
  return best;
}

// ---------- Payoff ----------
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Profit or loss in dollars if the underlying settles at `S` on the expiry date.
 *
 * Written as one function per shape rather than a generic leg-summing loop on purpose: the
 * sign conventions are where this kind of code goes wrong, and a wrong sign on a credit
 * structure does not throw — it silently reports a loss as a profit. Each branch is pinned
 * by its own test.
 */
export function pnlAtExpiry(c: Candidate, S: number): number {
  const strikes = c.legs.map((l) => l.contract.strike).sort((a, b) => a - b);
  const lo = strikes[0];
  const hi = strikes[strikes.length - 1];
  switch (c.kind) {
    case "long_call":  return Math.max(0, S - lo) * 100 - c.debitUsd;
    case "long_put":   return Math.max(0, lo - S) * 100 - c.debitUsd;
    // Long the lower strike, short the higher: gains as S rises, capped at the width.
    case "call_debit": return clamp(S - lo, 0, hi - lo) * 100 - c.debitUsd;
    // Long the higher strike, short the lower: gains as S falls, capped at the width.
    case "put_debit":  return clamp(hi - S, 0, hi - lo) * 100 - c.debitUsd;
    // Short the higher put, long the lower: keep the credit unless S falls through.
    case "put_credit": return c.creditUsd - clamp(hi - S, 0, hi - lo) * 100;
    // Short the lower call, long the higher: keep the credit unless S rallies through.
    case "call_credit": return c.creditUsd - clamp(S - lo, 0, hi - lo) * 100;
  }
}

/** Return on capital at risk if the underlying moves to `S` by expiry. */
export function returnAt(c: Candidate, S: number): number | null {
  return c.capitalAtRiskUsd > 0 ? pnlAtExpiry(c, S) / c.capitalAtRiskUsd : null;
}

// ---------- Construction ----------
const halfSpread = (c: Contract) => ((c.ask - c.bid) / 2) * 100;

function singleLeg(kind: "long_call" | "long_put", c: Contract): Candidate {
  const debitUsd = entryCostUsd(c.ask);
  return {
    kind, legs: [{ contract: c, side: "buy" }], expiry: c.expiry,
    debitUsd, creditUsd: 0,
    capitalAtRiskUsd: debitUsd,
    // A long call's upside is genuinely unbounded; a long put's is bounded by the stock
    // reaching zero, and saying "unbounded" there would be wrong.
    maxProfitUsd: kind === "long_call" ? null : Math.max(0, c.strike * 100 - debitUsd),
    maxLossUsd: debitUsd,
    breakeven: kind === "long_call" ? c.strike + debitUsd / 100 : c.strike - debitUsd / 100,
    crossingCostUsd: halfSpread(c),
    netDelta: c.delta,
    netTheta: 0,
  };
}

function verticalDebit(kind: "call_debit" | "put_debit", long: Contract, short: Contract): Candidate {
  const debitUsd = spreadDebitUsd(long.ask, short.bid);
  const width = Math.abs(short.strike - long.strike) * 100;
  return {
    kind, legs: [{ contract: long, side: "buy" }, { contract: short, side: "sell" }], expiry: long.expiry,
    debitUsd, creditUsd: 0,
    capitalAtRiskUsd: debitUsd,
    maxProfitUsd: width - debitUsd,
    maxLossUsd: debitUsd,
    breakeven: kind === "call_debit" ? long.strike + debitUsd / 100 : long.strike - debitUsd / 100,
    crossingCostUsd: halfSpread(long) + halfSpread(short),
    netDelta: long.delta - short.delta,
    netTheta: 0,
  };
}

function verticalCredit(kind: "put_credit" | "call_credit", short: Contract, long: Contract): Candidate {
  const creditUsd = spreadCreditUsd(short.bid, long.ask);
  const width = Math.abs(short.strike - long.strike) * 100;
  return {
    kind, legs: [{ contract: short, side: "sell" }, { contract: long, side: "buy" }], expiry: short.expiry,
    debitUsd: 0, creditUsd,
    // A credit spread ties up the width minus the credit — that collateral IS the risk, and
    // reporting the credit as "the cost" is how credit spreads get mis-sold as free money.
    capitalAtRiskUsd: width - creditUsd,
    maxProfitUsd: creditUsd,
    maxLossUsd: width - creditUsd,
    breakeven: kind === "put_credit" ? short.strike - creditUsd / 100 : short.strike + creditUsd / 100,
    crossingCostUsd: halfSpread(short) + halfSpread(long),
    // Long minus short for BOTH kinds. A put credit spread is bullish (positive net delta);
    // a call credit spread is bearish (negative). The earlier expression flipped the call
    // case's sign, reporting a bearish structure as bullish.
    netDelta: long.delta - short.delta,
    netTheta: 0,
  };
}

export interface BuildInput {
  calls: Contract[];
  puts: Contract[];
  spot: number;
  expiry: string;
  /** Most capital this position may put at risk. */
  budgetUsd: number;
  kinds?: readonly StructureKind[];
}

/**
 * Every structurally valid, liquid, affordable candidate on one expiry.
 *
 * Liquidity is applied to EVERY leg, not just the one being bought. A tight long against a
 * short nobody quotes is not a tradeable spread, and the short leg is the one that has to be
 * bought back to get out.
 */
export function buildCandidates(input: BuildInput): Candidate[] {
  const kinds = input.kinds ?? BULLISH_KINDS;
  const calls = input.calls.filter((c) => c.expiry === input.expiry && tradeable(c));
  const puts = input.puts.filter((c) => c.expiry === input.expiry && tradeable(c));
  const out: Candidate[] = [];

  // THE STOCK-REPLACEMENT RULE, PRESERVED. The long leg of any bought structure must sit in
  // the book's pre-registered delta band — deep enough in the money that most of the premium
  // is intrinsic, so decay is a small fraction of the position and the premium itself is the
  // floor. Ranking on return at the expected move does NOT reproduce this on its own: a cheap
  // call struck just below the reference price shows a spectacular percentage return there
  // and would win every time, which is precisely the out-of-the-money lottery ticket this
  // book was built to avoid. The band is what keeps the thesis intact.
  const longLegs = (cs: Contract[]) => cs.filter((c) => Math.abs(c.delta) >= MIN_DELTA && Math.abs(c.delta) <= MAX_DELTA);
  const longCalls = longLegs(calls);
  const longPuts = longLegs(puts);

  if (kinds.includes("long_call")) for (const c of longCalls) out.push(singleLeg("long_call", c));
  if (kinds.includes("long_put")) for (const p of longPuts) out.push(singleLeg("long_put", p));

  if (kinds.includes("call_debit")) {
    for (const long of longCalls) for (const short of calls) {
      if (short.strike > long.strike && legsQuotedTogether(long, short)) out.push(verticalDebit("call_debit", long, short));
    }
  }
  if (kinds.includes("put_debit")) {
    for (const long of longPuts) for (const short of puts) {
      if (short.strike < long.strike && legsQuotedTogether(long, short)) out.push(verticalDebit("put_debit", long, short));
    }
  }
  // A SOLD leg must be OUT OF THE MONEY at entry. Structural, not a tuned threshold: selling
  // something that already has intrinsic value is selling the move that has happened rather
  // than the one that has not, and it hands the buyer an immediate reason to exercise early.
  if (kinds.includes("put_credit")) {
    for (const short of puts) for (const long of puts) {
      if (long.strike < short.strike && short.strike < input.spot && legsQuotedTogether(short, long)) {
        out.push(verticalCredit("put_credit", short, long));
      }
    }
  }
  if (kinds.includes("call_credit")) {
    for (const short of calls) for (const long of calls) {
      if (long.strike > short.strike && short.strike > input.spot && legsQuotedTogether(short, long)) {
        out.push(verticalCredit("call_credit", short, long));
      }
    }
  }

  return out.filter((c) =>
    c.capitalAtRiskUsd > 0 &&
    c.capitalAtRiskUsd <= input.budgetUsd &&
    // A structure that CANNOT profit is not a trade. This is not theoretical: a vertical
    // whose debit exceeds its width pays more than the position can ever be worth, and it
    // appears whenever the two legs are close together and the spread between them is wide.
    // Without this filter it survives as a candidate and reports a breakeven price the
    // payoff can never reach — caught by the breakeven invariant test, not by a crash.
    (c.maxProfitUsd === null || c.maxProfitUsd > 0) &&
    // A credit structure that pays less than it costs to cross is not a trade either.
    (c.creditUsd === 0 || c.creditUsd > c.crossingCostUsd) &&
    // And an implausibly large credit on an out-of-the-money short is a mispriced leg, not
    // an opportunity — see MAX_CREDIT_FRAC_OF_WIDTH.
    (c.creditUsd === 0 || c.creditUsd <= (c.capitalAtRiskUsd + c.creditUsd) * MAX_CREDIT_FRAC_OF_WIDTH)
  );
}

// ---------- Selection ----------
// PRE-REGISTERED, in this order. Written down before any of it was run.
//
//  1. The position must not need a move it is not already positioned for: it must be
//     profitable at expiry if the underlying simply reaches the market's own expected move.
//     This is what rejects the cheap far-OTM ticket without ever mentioning "cheap" — the
//     ticket is still worthless there.
//  2. Among survivors, take the highest return on capital at risk AT THAT SAME reference
//     price. One yardstick, applied identically to every shape.
//  3. Ties break toward the lower crossing cost, because that part is certain and the rest
//     is not.
export interface Selection {
  best: Candidate;
  referencePrice: number;
  returnAtRef: number;
  considered: number;
  rejectedForBreakeven: number;
}

export type Direction = "bullish" | "bearish";

/**
 * `direction` decides which WAY the reference move points. A bearish position is judged at
 * spot × (1 − expected move), because judging it at a higher price would reject every
 * candidate and the sleeve would silently never trade — a failure that looks exactly like a
 * quiet market.
 */
export function selectStructure(
  candidates: Candidate[], spot: number, expectedMoveFrac: number, direction: Direction = "bullish",
): Selection | null {
  if (!(spot > 0) || !(expectedMoveFrac > 0) || !candidates.length) return null;
  const ref = spot * (1 + (direction === "bearish" ? -expectedMoveFrac : expectedMoveFrac));
  if (!(ref > 0)) return null;
  let best: Candidate | null = null;
  let bestRet = -Infinity;
  let rejected = 0;
  for (const c of candidates) {
    const ret = returnAt(c, ref);
    if (ret == null) continue;
    if (!(pnlAtExpiry(c, ref) > 0)) { rejected++; continue; }
    if (ret > bestRet || (ret === bestRet && best && c.crossingCostUsd < best.crossingCostUsd)) {
      best = c; bestRet = ret;
    }
  }
  if (!best) return null;
  return {
    best, referencePrice: ref, returnAtRef: bestRet,
    considered: candidates.length, rejectedForBreakeven: rejected,
  };
}

// The payoff grid moved to options-paper-model.ts alongside settleAtExpiry: it is built from
// STORED positions, not from selection candidates, so it belongs with the settlement math.
export { SCENARIO_MOVES } from "@/lib/options-paper-model";
