// Shared LIVE risk math — paper scoreboard and the Kraken executor MUST use this
// module so the "At LIVE sizing" column cannot drift from what would actually be risked.
// Defaults match the agreed policy: 3% base, conviction 2×/0.5×, 6% ceiling.

export const LIVE_RISK_DEFAULT_PCT = 3;
export const LIVE_RISK_CEILING_PCT = 6;
export const LIVE_RISK_FLOOR_PCT = 0.1;

export type ConvictionTier = "low" | "med" | "high";

export function convictionMultiplier(tier: string | null | undefined): number {
  if (tier === "high") return 2;
  if (tier === "low") return 0.5;
  return 1; // med, null, unknown — never treat unverified as high
}

export function parseLiveRiskBasePct(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return LIVE_RISK_DEFAULT_PCT;
  return Math.min(LIVE_RISK_CEILING_PCT, Math.max(LIVE_RISK_FLOOR_PCT, raw));
}

/** Percent of equity risked on this trade (e.g. 3, 6, 1.5). */
export function liveRiskPct(basePct: number, tier: string | null | undefined): number {
  return Math.min(LIVE_RISK_CEILING_PCT, parseLiveRiskBasePct(basePct) * convictionMultiplier(tier));
}

/** Same as liveRiskPct but as a fraction (0.03). Used by both sizers. */
export function liveRiskFraction(basePct: number, tier: string | null | undefined): number {
  return liveRiskPct(basePct, tier) / 100;
}

/**
 * Leverage CAP grows with the account. Risk % does not.
 *
 * Dollar risk is always equity × 3% (6% high-conviction ceiling). A larger book
 * therefore takes larger dollar bets at the same percentage — that is how a $5k
 * account becomes a $50k account without changing the risk model. The cap only
 * decides how much notional that dollar-risk is allowed to buy (tighter stops
 * need more leverage to spend the same risk budget).
 *
 *   ~$5k  → 2×   US-retail margin, the live book
 *   ~$10k → 3×   after the account has actually grown
 *   ~$20k → 5×   still well inside Kraken's 5–20× pair limits
 *
 * Unreadable / non-positive equity fails closed to 2× — never "treat missing
 * as large." The operator key kraken_margin_max_leverage is a CEILING on this
 * ladder (default 5 so growth is possible); it cannot raise leverage above
 * the rung the equity has earned.
 */
export const LEV_CAP_AT_5K = 2;
export const LEV_CAP_AT_10K = 3;
export const LEV_CAP_AT_20K = 5;
export const LEV_EQUITY_10K = 10_000;
export const LEV_EQUITY_20K = 20_000;
export const DEFAULT_MAX_LEVERAGE = 5; // operator ceiling; ladder still holds $5k at 2×

export function leverageCapForEquity(equity: number): number {
  if (!Number.isFinite(equity) || equity <= 0) return LEV_CAP_AT_5K;
  if (equity < LEV_EQUITY_10K) return LEV_CAP_AT_5K;
  if (equity < LEV_EQUITY_20K) return LEV_CAP_AT_10K;
  return LEV_CAP_AT_20K;
}

/** min(operator ceiling, equity ladder). cfgMax < 2 means "entries disabled" — returned as-is. */
export function effectiveMaxLeverage(cfgMax: number, equity: number): number {
  if (!(cfgMax >= 2)) return cfgMax;
  return Math.min(20, cfgMax, leverageCapForEquity(equity));
}

/**
 * Kraken OpenPositions can return [] during degradation while margin is still in use.
 * Treating that as "no conflict" would wave through an opposing entry that nets against
 * a hidden manual position. Fail closed.
 */
export function failClosedOnEmptyPositions(
  openCount: number,
  marginUsedRaw: number | null | undefined,
): boolean {
  return openCount === 0 && (marginUsedRaw == null || marginUsedRaw > 0);
}

export function pairHasExposure(
  symbol: string,
  openPairs: string[],
  restingPairs: string[],
  pairMatches: (a: string, b: string) => boolean,
): boolean {
  return openPairs.some((p) => pairMatches(p, symbol))
    || restingPairs.some((p) => pairMatches(p, symbol));
}

// ---------- THE CONTAINER — live mirrors the paper record's `selective` sleeve ----------
// Paper's live candidate: 3% initial stop, breakeven once +1R, then a 1R trail behind the
// peak, 48h time stop, notional = risk × equity ÷ stop (capped at leverage × equity).
// Until Sep 5 2026 the executor defaulted to a 15% stop (0.3/leverage), no trail, and a
// $100 per-trade cap — the same signal in a different container, which is exactly the
// class of gap the Sep 3 conviction fix closed one layer up. These constants are the
// single source both the executor and the guardian's managed exit read.
export const LIVE_STOP_DEFAULT_PCT = 3;      // = paper selective's oneR (entry × 0.03)
export const LIVE_MAX_HOLD_H = 48;           // = paper MAX_HOLD_H
export const LIVE_STOP_RATCHET_MIN_FRAC = 0.0005;   // move a resting stop only for ≥0.05% of price

/**
 * Notional exactly as paper's positionNotional: risk × equity ÷ stop distance, capped at
 * leverage × equity. `perTradeCapUsd` > 0 is an optional operator ceiling on margin
 * committed per entry (× leverage = notional); 0 means none — the default, because a
 * $100 cap silently turned 3% risk into ~0.6% and made the scoreboard's "At LIVE sizing"
 * column describe a trade the executor would never have placed.
 */
export function liveNotional(equity: number, riskFrac: number, stopFrac: number, leverage: number, perTradeCapUsd = 0): number {
  if (!(equity > 0) || !(riskFrac > 0) || !(stopFrac > 0) || !(leverage >= 1)) return 0;
  let notional = Math.min((riskFrac * equity) / stopFrac, equity * leverage);
  if (perTradeCapUsd > 0) notional = Math.min(notional, perTradeCapUsd * leverage);
  return notional;
}

/**
 * Paper's managed exit, as a pure function the guardian can apply to a real resting stop:
 * once the best price reached is ≥ +1R, the stop is at least breakeven and trails 1R
 * behind the peak; it only ever ratchets in the trade's favour. Returns the stop level
 * that should be resting now (unchanged when no ratchet is due).
 */
export function managedStopTarget(side: "long" | "short", entry: number, peak: number, currentStop: number, oneR: number): number {
  if (!(entry > 0) || !(oneR > 0) || !Number.isFinite(peak) || !Number.isFinite(currentStop)) return currentStop;
  const dir = side === "long" ? 1 : -1;
  const peakR = (dir * (peak - entry)) / oneR;
  if (peakR < 1) return currentStop;
  const trail = peak - dir * oneR;
  const candidate = dir > 0 ? Math.max(entry, trail) : Math.min(entry, trail);
  return dir > 0 ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}

/** True when `target` improves on `currentStop` by at least the ratchet threshold. */
export function stopNeedsRatchet(side: "long" | "short", currentStop: number, target: number, price: number): boolean {
  if (!(price > 0) || !Number.isFinite(target) || !Number.isFinite(currentStop)) return false;
  const improvement = side === "long" ? target - currentStop : currentStop - target;
  return improvement >= price * LIVE_STOP_RATCHET_MIN_FRAC;
}

/** Lock value is `${iso}#token`. Health UI must parse the iso, not Date(fullstring). */
export const EXEC_LOCK_TTL_MS = 330_000;

export function execLockHeldSince(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = raw.split("#")[0]?.trim();
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? iso : null;
}
