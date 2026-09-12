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
//   swing-wide       — swing-lev's own signals with a 2R trail instead of 1R and a 7-day
//                      hold (registered Sep 9 2026). The 134 resolved high-conviction trades
//                      average a 0.93R WIN against a 3.3R best, and most exit on the trailing
//                      stop: the 1R trail may be cutting the right tail off. selective-tight
//                      tests a NARROWER trail, so nothing on the desk could answer "are we
//                      cutting winners short?" with a yes. Live-capable from Sep 12 2026 —
//                      the guardian mirrors a container's trail width (LIVE_CONTAINERS).
//   swing-lock       — swing-lev's own signals on swing-wide's 2R trail, locking 0.5R
//                      behind the peak once +3R (registered Sep 11 2026, replacing
//                      swing-tight before it took a trade). "When we're up a lot, don't
//                      give it back" — without touching the modal ~1R winner. Replay: the
//                      2R trail is the biggest lever (+$104/trade, t=1.94); the +3R lock
//                      costs ~$26 of that for a tighter outcome distribution. Forward
//                      record decides. Paper only.
//   swing-pyr        — swing-wide plus ONE risk-sized add when a completed 4h bar closes ≥ +1R
//                      (registered Sep 12 2026). Paired replay Q2f: +$125/trade over swing-wide,
//                      t=2.63; worst trade −$499 vs −$403 (second unit's fees and carry — price
//                      risk stays one R because the add is sized to the resting stop). Same-
//                      notional adds were rejected (worst −$694). Live-capable: the guardian
//                      triggers the add, the executor sizes it with the same function.
export const TWIN_SOURCES = ["selective-tight", "selective-launch", "selective-btc", "selective-majors", "swing-wide", "swing-lock", "swing-pyr"] as const;
// SELECTIVE-SHORT (registered Sep 8 2026) — NOT a twin: its own signals (high-conviction
// BREAKDOWNS, 5m/15m, not stretched), opened ONLY while BTC's last complete daily close is
// BELOW its 20-day average. Every short on the record (37, 11% won, −$5,140) was taken inside
// a 20–40% rally; this sleeve exists so the next bear stretch produces evidence instead of
// finding the desk idle. It opens nothing in an up-regime. Paper only, judged like every sleeve.
export const SHORT_SOURCE = "selective-short";
// THE SLOW FAMILY, REACTIVATED Sep 8 2026. swing-lev (4% stop / 4-day hold, leveraged) and
// swing-spot (6% / 14-day, spot, no rollover) were paused Sep 4 as "not the live candidate".
// Their Sep 2–4 samples (35 each) then resolved through the rally: swing-spot +$1,430 with
// +$1,247 still floating, swing-lev +$618, while the fast 5m/15m rule lost $2,662 on paper
// in the Sep 7–8 chop. Day-to-day the fast and slow families do NOT lose together — the
// two-slot desk needs a proven slow sleeve, and a paused sleeve can never earn its 30.
// Entry rule = the Sep 3–4 rule they were paused under, longs only: high-conviction 4h/1d
// BREAKOUTS. Paper only; judged like every sleeve.
export const SWING_TFS = new Set(["4h", "1d"]);
/**
 * THE LEVERAGED SLEEVE TAKES 4h ONLY (2026-09-09). Measured, not assumed.
 *
 * `scripts/backtest-variants.ts` replayed swing-lev's own container over every Kraken 4h and
 * 1d bar available (one open trade per coin, paper's exact detector, conviction scorer, exit
 * engine, chase and fees):
 *
 *   4h leg   88 trades   avg +$152   t = 2.72   95% CI  +$42 … +$262
 *   1d leg   31 trades   avg −$107   t = −1.12  95% CI −$295 … +$81
 *   Welch test on the difference: +$259/trade, t = 2.34, 95% CI +$42 … +$477
 *
 * The claim is NOT "1d loses money" — on its own it is not significantly negative. The claim
 * is that the two legs are significantly DIFFERENT in the container swing-lev runs, and the
 * 1d leg drags the combined record from t = 2.72 to t = 1.72. A separate two-year daily
 * sample (110 trades, med+ conviction, −$1,992, 6/18 months positive) points the same way
 * without reaching significance itself. Two samples, same sign, one significant difference.
 *
 * ⚠️ SCOPE. This was measured in the 4%/96h container ONLY. swing-spot runs a different one
 * (6% stop, 14-day hold) and was NOT tested, so it keeps both timeframes — cutting it there
 * would be exactly the assumption this comment exists to avoid.
 */
export const SWING_LEV_TFS = new Set(["4h"]);
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
  if (conv.tier !== "high") return [];
  const capped = Math.max(2, Math.min(20, lev));
  // Higher-timeframe BREAKOUTS feed the slow family only (the Sep 3–4 rule: high, 4h/1d, long).
  // The LEVERAGED container is 4h-only from 2026-09-09 — measured, see SWING_LEV_TFS. Its
  // wide-trail twin shares that container, so it follows. swing-spot's container was not
  // tested and keeps both timeframes.
  if (kind === "breakout" && SWING_TFS.has(timeframe)) {
    const plans: AutoPlan[] = [{ source: "swing-spot", lev: 1 }];
    if (SWING_LEV_TFS.has(timeframe)) {
      plans.unshift({ source: "swing-lev", lev: capped });
      plans.push({ source: "swing-wide", lev: capped });
      plans.push({ source: "swing-lock", lev: capped });
      plans.push({ source: "swing-pyr", lev: capped });
    }
    return plans;
  }
  if (!PAYING_TFS.has(timeframe)) return [];
  if (isStretched(conv.factors)) return [];

  // Breakdowns: only the regime-gated short sleeve, and only in a confirmed BTC down-regime.
  if (kind === "breakdown") return regime?.btcUp === false ? [{ source: SHORT_SOURCE, lev: capped }] : [];
  if (kind !== "breakout") return [];
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
