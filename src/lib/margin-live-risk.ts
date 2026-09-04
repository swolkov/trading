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
