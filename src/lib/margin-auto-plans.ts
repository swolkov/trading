// Auto paper-entry policy. The scanner still WATCHES every liquid coin; this module
// decides which directional events are allowed to open a scored paper trade.
//
// Conviction filter is the intelligence. The scoreConviction formula is left alone
// (changing it would mix the only paying sample). What changes is WHO gets opened:
// low/med auto-paper is off. High-conviction breakout/breakdown only.

export const RETIRED_AUTO_SOURCES = new Set([
  "fast-tight",       // RETIRED Sep 1 2026 — 2% stop, t=−4.2
  "sweep-fade",       // RETIRED Sep 3 2026 — ICT/SMC fade, t=−2.7 / −6.0
  "scanner",          // RETIRED Sep 4 2026 — wide 6% spray, 45 res, t=−1.9, −$2.3k
  "selective-swing",  // RETIRED Sep 4 2026 — 5%/4d A/B, 22 res, t=−3.8, −$4.1k (give-back)
]);

export type AutoPlan = { source: string; lev: number };

/**
 * Plans for one fresh directional signal. Empty = do not open paper.
 * Open trades on retired sources still resolve via exitParams — we just stop
 * adding new ones.
 */
export function autoShadowPlans(
  kind: string,
  timeframe: string,
  convTier: string,
  lev: number,
): AutoPlan[] {
  if (kind !== "breakout" && kind !== "breakdown") return [];
  if (convTier !== "high") return [];

  const capped = Math.max(2, Math.min(20, lev));
  const plans: AutoPlan[] = [{ source: "selective", lev: capped }];
  // Higher-TF breaks also fill the two swing containers — same high-conviction
  // setups, different hold/stop. Still gathering (not proven losers). Intraday
  // is selective only; the old `scanner` spray is retired.
  if (timeframe === "4h" || timeframe === "1d") {
    plans.push({ source: "swing-lev", lev: capped });
    plans.push({ source: "swing-spot", lev: 1 });
  }
  return plans;
}
