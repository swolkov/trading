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

// PRE-REGISTERED TWINS (Sep 7 2026) — the live candidate's OWN signals, re-scored in a
// different container or under a filter. Same entries, so they are never pooled with the
// record (EXPERIMENT_SOURCES). Each is judged at 30 resolved, t ≥ 2, 7 days, and replaces
// the live rule only by beating `selective` on the same signals. Why these three:
//   selective-tight  — winners peak 2.5R and bank 1.55R: trail 0.5R (not 1R) once +2R.
//   selective-launch — losers peak 0.42R and die in ~12h, winners take ~22h: a trade still
//                      below +0.5R after 8h is closed (frees the slot).
//   selective-btc    — opened only while BTC closes above its 20-day average: the regime
//                      hypothesis behind the 12–18 UTC and clustered-alt losses.
//   selective-majors — the same rule on BTC, ETH and SOL ONLY (Spencer's Aug 30 instinct:
//                      his +$732 / +$596 days were BTC and ETH). Does the rule pay more per
//                      trade at the same risk on the deepest books? Registered Sep 7 2026.
export const TWIN_SOURCES = ["selective-tight", "selective-launch", "selective-btc", "selective-majors"] as const;
export const MAJORS = new Set(["BTC", "ETH", "SOL"]);

export type AutoPlan = { source: string; lev: number };
export type Regime = { btcUp: boolean | null };   // null = daily bars unavailable → no regime twin this run

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
  regime?: Regime,
  symbol?: string,   // "BTC/USD" — the majors twin opens only on BTC/ETH/SOL
): AutoPlan[] {
  if (kind !== "breakout") return [];
  if (conv.tier !== "high") return [];
  if (!PAYING_TFS.has(timeframe)) return [];
  if (isStretched(conv.factors)) return [];

  const capped = Math.max(2, Math.min(20, lev));
  // The ×5-size twin rides the same signal at 5× leverage (capped by the coin's own max).
  const plans: AutoPlan[] = [
    { source: "selective", lev: capped },
    { source: "selective-x5", lev: Math.max(2, Math.min(5, lev)) },
    { source: "selective-tight", lev: capped },
    { source: "selective-launch", lev: capped },
  ];
  // The regime twin opens ONLY in a confirmed BTC up-regime; an unreadable regime opens nothing.
  if (regime?.btcUp === true) plans.push({ source: "selective-btc", lev: capped });
  // The majors twin: the same signal, only when the coin is BTC, ETH or SOL.
  const base = (symbol ?? "").split("/")[0].toUpperCase();
  if (MAJORS.has(base === "XBT" ? "BTC" : base)) plans.push({ source: "selective-majors", lev: capped });
  return plans;
}
