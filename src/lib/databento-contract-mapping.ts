export interface DatabentoContractRow {
  symbol: string;
  rawContract: string | null | undefined;
  timestampMs: number;
}

/**
 * Select the same fresh quote-to-contract mapping used by the price path.
 * Preference order is significant: exact traded symbol first, then any explicit sibling fallback.
 */
export function selectFreshContractMapping(
  preferredSymbols: readonly string[],
  rows: readonly DatabentoContractRow[],
  nowMs: number,
  maxAgeMs: number,
): DatabentoContractRow | null {
  for (const symbol of preferredSymbols) {
    const row = rows.find((candidate) => candidate.symbol === symbol);
    if (!row || !row.rawContract?.startsWith(symbol)) continue;
    if (!Number.isFinite(row.timestampMs) || row.timestampMs > nowMs || nowMs - row.timestampMs >= maxAgeMs) continue;
    return row;
  }
  return null;
}

/** Verify that a quote row still describes the exact delivery month selected at the broker. */
export function contractMappingMatchesBroker(
  tradedSymbol: string,
  sourceSymbol: string,
  rawContract: string,
  brokerContractName: string,
): boolean {
  if (!rawContract.startsWith(sourceSymbol) || !brokerContractName.startsWith(tradedSymbol)) return false;
  return rawContract.slice(sourceSymbol.length) === brokerContractName.slice(tradedSymbol.length);
}
