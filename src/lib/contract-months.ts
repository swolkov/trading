/**
 * Front-month contract selection — shared by the Next app (lib/tradovate.ts) AND the Railway engine
 * (services/futures-realtime.ts), which each resolve contracts through their own API client.
 *
 * WHY THIS EXISTS
 *   Tradovate's /contract/suggest returns months CHRONOLOGICALLY, so taking [0] means "nearest
 *   expiry". That is only the right answer when the exchange lists nothing but liquid months.
 *   It is wrong for full-size gold: CME lists GC in EVERY month, so [0] resolved to GCN6 — a thin
 *   July contract days from expiry — while the actively traded month was GCQ6. The micro (MGC) is
 *   only LISTED in the liquid months, which is exactly why MGC resolved correctly and GC did not.
 *   Demo trades GC, so after the late-May roll it was pointed at a contract nobody trades and
 *   silently stopped trading gold (last fill 2026-05-22, discovered 2026-07-25).
 *
 *   The fix originally went into lib/tradovate.ts only — but the ENGINE has its own resolver and
 *   never calls that function, so demo stayed broken. Hence this shared module: one definition,
 *   both call sites, no chance of them drifting apart again.
 *
 * Pure data + pure functions — no imports, no side effects — so the engine can use it freely.
 */

/**
 * Month codes whose liquidity is real, for symbols the exchange also lists in thin months.
 * Gold trades Feb/Apr/Jun/Aug/Oct/Dec (G/J/M/Q/V/Z); Jan, Mar, May, Jul, Sep and Nov are listed but
 * barely traded. Verified empirically against Tradovate: MGC (listed only in liquid months) offers
 * Q6, V6, Z6, G7, J7, M7… while GC offers N6, Q6, U6, V6, X6, Z6…
 *
 * A symbol absent from this map keeps nearest-expiry behaviour, which is correct for the equity
 * index contracts — only quarterlies (H/M/U/Z) are listed at all, so [0] is always right.
 */
export const ACTIVE_MONTH_CODES: Record<string, Set<string>> = {
  GC: new Set(["G", "J", "M", "Q", "V", "Z"]),
};

/** "GCQ6" -> "Q". Returns "" when the name doesn't start with the root, so callers can't crash. */
export function monthCodeOf(symbol: string, contractName: string): string {
  if (!contractName?.startsWith(symbol)) return "";
  return contractName.slice(symbol.length, symbol.length + 1);
}

/**
 * Pick the contract that actually trades from a chronologically-ordered /contract/suggest response.
 * Falls back to the first candidate for any symbol without a liquidity restriction, so this is
 * behaviour-preserving everywhere except the symbols listed above.
 */
export function pickActiveContract<T extends { name: string }>(symbol: string, candidates: T[]): T | undefined {
  if (!candidates?.length) return undefined;
  const active = ACTIVE_MONTH_CODES[symbol];
  if (!active) return candidates[0];
  return candidates.find((c) => active.has(monthCodeOf(symbol, c.name))) ?? candidates[0];
}
