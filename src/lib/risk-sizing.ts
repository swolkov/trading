export function isFreshPositiveEquity(
  equity: number,
  observedAt: number,
  now: number,
  maxAgeMs: number,
): boolean {
  return Number.isFinite(equity) && equity > 0
    && Number.isFinite(observedAt) && observedAt > 0
    && now >= observedAt && now - observedAt <= maxAgeMs;
}

export function cappedContractLimit(
  configuredPerTradeMax: number,
  equityGrowthCap: number,
  aggregateMax: number,
  currentlyOpen: number,
): number {
  const remaining = Math.max(0, Math.floor(aggregateMax) - Math.max(0, Math.floor(currentlyOpen)));
  return Math.max(0, Math.min(
    Math.max(0, Math.floor(configuredPerTradeMax)),
    Math.max(0, Math.floor(equityGrowthCap)),
    remaining,
  ));
}

/** Parse an operator risk setting without turning an intentional zero into a default. */
export function nonNegativeConfigNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
