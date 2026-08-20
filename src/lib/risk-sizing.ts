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
