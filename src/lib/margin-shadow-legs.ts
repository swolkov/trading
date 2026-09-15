// PARTIAL-EXIT LEGS (C5a, Sep 15 2026) — the arithmetic behind the `swing-partial` twin, pure so
// the paper evaluator (margin-shadow.ts) and the research replay (scripts/lib/replay-engine.ts)
// score a banked partial with the SAME fee split.
//
// A partial turns one position into two legs that share an entry: the banked leg (partialFrac of
// the notional, out at the partial level at its own time) and the remainder (the rest, out at the
// trade's final exit). Each leg pays ITS share of the entry fee (the fee was charged on the whole
// notional at entry — a pro-rata split, nothing is double-charged), a taker exit on its own
// notional, and rollover on its own notional to ITS OWN exit time — the banked leg stops paying
// carry the moment it is closed, exactly as Kraken bills a reduced position. The trail keeps
// running on the first unit's entry and R; only the notional it protects shrinks.
export interface LegFees { entry: number; taker: number; roll4h: number }   // fractions of notional
export interface PartialLeg { px: number; t: number; notional: number }       // t = epoch secs of the fill bar
export interface LegResult { pnl: number; fees: number }

/** Rollover periods for a leg held `ageH` hours: the evaluator's ceil(age ÷ 4), never negative. */
export function rollPeriods(ageH: number): number {
  return Number.isFinite(ageH) && ageH > 0 ? Math.ceil(ageH / 4) : 0;
}

/** One leg: gross % of its own notional minus entry share, taker exit and (if carried) rollover to its own time. */
export function legPnl(dir: 1 | -1, entry: number, exit: number, notional: number, ageH: number, carry: boolean, fees: LegFees): LegResult {
  if (!(entry > 0) || !(notional > 0) || !Number.isFinite(exit)) return { pnl: 0, fees: 0 };
  const grossPct = (dir * (exit - entry)) / entry;
  const feeFrac = fees.entry + fees.taker + (carry ? rollPeriods(ageH) * fees.roll4h : 0);
  return { pnl: (grossPct - feeFrac) * notional, fees: feeFrac * notional };
}

/**
 * Is the partial due on this COMPLETED bar? The favourable extreme (a long's high, a short's low)
 * reached entry + partialAtR × R. One partial per trade — the caller passes `already`.
 */
export function partialDue(partialAtR: number | undefined, dir: 1 | -1, entry: number, oneR: number, bar: { h: number; l: number }, already: boolean): boolean {
  if (partialAtR == null || !(partialAtR > 0) || already || !(oneR > 0)) return false;
  const best = dir > 0 ? bar.h : bar.l;
  return Number.isFinite(best) && (dir * (best - entry)) / oneR >= partialAtR;
}

/**
 * The partial's fill: the level itself, or the bar's OPEN when the bar gapped through it — a
 * resting limit fills at the better price, never worse. Mirrors the evaluator's gap-aware stop
 * fill in the favourable direction.
 */
export function partialFillPx(dir: 1 | -1, entry: number, oneR: number, partialAtR: number, barOpen: number): number {
  const level = entry + dir * oneR * partialAtR;
  if (!Number.isFinite(barOpen)) return level;
  return dir > 0 ? Math.max(level, barOpen) : Math.min(level, barOpen);
}

export interface PartialTradeInput {
  dir: 1 | -1; entry: number; exit: number; notional: number;
  partial: PartialLeg; tOpen: number; tExit: number;   // epoch secs
  carry: boolean; fees: LegFees;
}

/** Whole-trade P&L once a partial has been banked: the banked leg to its time + the remainder to the final exit. */
export function partialTradePnl(i: PartialTradeInput): LegResult & { remainderNotional: number } {
  const remainderNotional = Math.max(0, i.notional - i.partial.notional);
  const banked = legPnl(i.dir, i.entry, i.partial.px, i.partial.notional, (i.partial.t - i.tOpen) / 3600, i.carry, i.fees);
  const rest = legPnl(i.dir, i.entry, i.exit, remainderNotional, (i.tExit - i.tOpen) / 3600, i.carry, i.fees);
  return { pnl: banked.pnl + rest.pnl, fees: banked.fees + rest.fees, remainderNotional };
}
