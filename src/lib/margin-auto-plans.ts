// Auto paper-entry policy. The scanner still WATCHES every liquid coin; this module
// decides which directional events are allowed to open a scored paper trade.
//
// Conviction FORMULA is unchanged (rewriting it would mix the only paying sample).
// Intelligence is the filter — who gets opened — updated from the selective autopsy
// (59 resolved v2, judged at live 3% + conviction sizing, 4 Sep 2026):
//
//   longs 47  68%  +$6,595  avg +$140
//   shorts 12  17%  −$3,187  avg −$266   ← stop opening
//   5m+15m 47        +$3,754              ← the money
//   1h+4h 12         −$346                ← pause; 3%/48h was not built for those breaks
//   stretched 20 50% −$54                 ← skip (buying into RSI extreme)
//   long + vol + not stretched: 19, 79%, +$5,741 avg +$302
//
// Nothing is "always" profitable. 79% still means one in five stops. Paper exists to
// see whether this subset holds for 30+ trades and 7+ days before the $5k book is armed.

export const RETIRED_AUTO_SOURCES = new Set([
  "fast-tight",       // RETIRED Sep 1 2026 — 2% stop, t=−4.2
  "sweep-fade",       // RETIRED Sep 3 2026 — ICT/SMC fade, t=−2.7 / −6.0
  "scanner",          // RETIRED Sep 4 2026 — wide 6% spray, t=−1.9 / −2.0
  "selective-swing",  // RETIRED Sep 4 2026 — 5%/4d A/B, t=−3.8, give-back
]);

export type AutoPlan = { source: string; lev: number };

export type ConvictionInput = { tier: string; factors: string[] };

const PAYING_TFS = new Set(["5m", "15m"]);

function isStretched(factors: string[]): boolean {
  return factors.some((f) => /stretched/i.test(f));
}

/**
 * Plans for one fresh directional signal. Empty = do not open paper.
 * Open trades on retired/paused sources still resolve via exitParams.
 */
export function autoShadowPlans(
  kind: string,
  timeframe: string,
  conv: ConvictionInput,
  lev: number,
): AutoPlan[] {
  if (kind !== "breakout") return [];
  if (conv.tier !== "high") return [];
  if (!PAYING_TFS.has(timeframe)) return [];
  if (isStretched(conv.factors)) return [];

  const capped = Math.max(2, Math.min(20, lev));
  return [{ source: "selective", lev: capped }];
}
