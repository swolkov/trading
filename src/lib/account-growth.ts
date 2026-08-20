export interface GrowthPath {
  endingEquity: number;
  maxDrawdownPct: number;
  killed: boolean;
}

export function compoundRMultiples(
  startingEquity: number,
  riskFraction: number,
  returnsR: readonly number[],
  drawdownLimitFraction = 0.25,
): GrowthPath {
  let equity = startingEquity;
  let peak = startingEquity;
  let maxDrawdownPct = 0;
  for (const rMultiple of returnsR) {
    if (!Number.isFinite(rMultiple)) continue;
    equity += equity * riskFraction * rMultiple;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak : 1);
    if (equity <= 0 || maxDrawdownPct >= drawdownLimitFraction) {
      return { endingEquity: Math.max(0, equity), maxDrawdownPct, killed: true };
    }
  }
  return { endingEquity: equity, maxDrawdownPct, killed: false };
}

export function requiredExpectancyR(
  weeklyDollarTarget: number,
  equity: number,
  riskFraction: number,
  tradesPerWeek: number,
): number {
  const weeklyRiskBudget = equity * riskFraction * tradesPerWeek;
  return weeklyRiskBudget > 0 ? weeklyDollarTarget / weeklyRiskBudget : Infinity;
}

export function bootstrapGrowth(
  startingEquity: number,
  riskFraction: number,
  observedR: readonly number[],
  trades: number,
  paths = 10_000,
): { median: number; p10: number; p90: number; killRate: number } {
  if (!observedR.length || trades < 1 || paths < 1) return { median: startingEquity, p10: startingEquity, p90: startingEquity, killRate: 0 };
  let seed = 0x5eed1234;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const endings: number[] = [];
  let killed = 0;
  for (let path = 0; path < paths; path++) {
    const sample = Array.from({ length: trades }, () => observedR[Math.floor(random() * observedR.length)]);
    const result = compoundRMultiples(startingEquity, riskFraction, sample);
    endings.push(result.endingEquity);
    if (result.killed) killed++;
  }
  endings.sort((a, b) => a - b);
  return {
    median: endings[Math.floor(paths * 0.5)],
    p10: endings[Math.floor(paths * 0.1)],
    p90: endings[Math.floor(paths * 0.9)],
    killRate: killed / paths,
  };
}
