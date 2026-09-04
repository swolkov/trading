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

/** Lock value is `${iso}#token`. Health UI must parse the iso, not Date(fullstring). */
export const EXEC_LOCK_TTL_MS = 330_000;

export function execLockHeldSince(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = raw.split("#")[0]?.trim();
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? iso : null;
}
