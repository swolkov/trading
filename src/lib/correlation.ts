import { getHistoricalBars } from "./yahoo";

// Cache bar data within a single run to avoid redundant API calls
const barsCache = new Map<string, number[]>();

async function getCloses(symbol: string): Promise<number[]> {
  if (barsCache.has(symbol)) return barsCache.get(symbol)!;
  try {
    const bars = await getHistoricalBars(symbol, 30);
    const closes = bars.map((b) => b.c);
    barsCache.set(symbol, closes);
    return closes;
  } catch {
    return [];
  }
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0; // not enough data
  const xSlice = x.slice(-n);
  const ySlice = y.slice(-n);

  const meanX = xSlice.reduce((a, b) => a + b, 0) / n;
  const meanY = ySlice.reduce((a, b) => a + b, 0) / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - meanX;
    const dy = ySlice[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

// Extract underlying symbol from options symbol (TSLA260522P00385000 → TSLA)
function extractUnderlying(symbol: string): string {
  if (symbol.length <= 10) return symbol; // already a stock symbol
  const match = symbol.match(/^([A-Z]+)\d/);
  return match ? match[1] : symbol;
}

export async function checkCorrelationWithPortfolio(
  candidateSymbol: string,
  existingPositions: { symbol: string }[]
): Promise<{ correlated: boolean; with?: string; correlation?: number }> {
  if (existingPositions.length === 0) return { correlated: false };

  // Get unique underlyings from existing positions (max 5 to avoid timeout)
  const underlyings = [...new Set(existingPositions.map((p) => extractUnderlying(p.symbol)))].slice(0, 5);

  const candidateCloses = await getCloses(candidateSymbol);
  if (candidateCloses.length < 10) return { correlated: false };

  for (const existing of underlyings) {
    if (existing === candidateSymbol) continue;
    const existingCloses = await getCloses(existing);
    if (existingCloses.length < 10) continue;

    const corr = pearsonCorrelation(candidateCloses, existingCloses);
    if (Math.abs(corr) > 0.85) {
      return { correlated: true, with: existing, correlation: corr };
    }
  }

  return { correlated: false };
}

// Clear cache between runs
export function clearCorrelationCache() {
  barsCache.clear();
}
