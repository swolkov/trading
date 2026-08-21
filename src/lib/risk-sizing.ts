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
  policyPerTradeMax: number,
  aggregateMax: number,
  currentlyOpen: number,
): number {
  const remaining = Math.max(0, Math.floor(aggregateMax) - Math.max(0, Math.floor(currentlyOpen)));
  return Math.max(0, Math.min(
    Math.max(0, Math.floor(configuredPerTradeMax)),
    Math.max(0, Math.floor(policyPerTradeMax)),
    remaining,
  ));
}

export function riskSizedContractQuantity(args: {
  equity: number;
  riskPerTradePct: number;
  sizeMultiplier: number;
  perContractRisk: number;
  maxContracts: number;
  hardRiskLimitPct?: number;
}): number {
  const {
    equity,
    riskPerTradePct,
    sizeMultiplier,
    perContractRisk,
    maxContracts,
    hardRiskLimitPct = 15,
  } = args;
  if (![equity, riskPerTradePct, sizeMultiplier, perContractRisk, maxContracts, hardRiskLimitPct].every(Number.isFinite)) return 0;
  if (equity <= 0 || riskPerTradePct <= 0 || sizeMultiplier <= 0 || perContractRisk <= 0 || maxContracts < 1 || hardRiskLimitPct <= 0) return 0;

  const budget = equity * (riskPerTradePct / 100) * sizeMultiplier;
  const hardBudget = equity * (hardRiskLimitPct / 100);
  return Math.max(0, Math.min(
    Math.floor(maxContracts),
    Math.floor(budget / perContractRisk),
    Math.floor(hardBudget / perContractRisk),
  ));
}

/** Parse an operator risk setting without turning an intentional zero into a default. */
export function nonNegativeConfigNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
