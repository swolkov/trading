import { prisma } from "./db";

// ============ PATTERN MEMORY ============
// Stores every trade setup as a feature vector with its outcome.
// Before each new trade: finds the 20 most similar historical setups.
// Returns their win rate as a prediction score.
// The more trades stored, the smarter the predictions.

export interface SetupVector {
  // Market context
  regime: "bull" | "bear" | "choppy";
  session: string; // morning, afternoon, midday, eth_*
  vixLevel: number; // 0-100
  vixTrend: "rising" | "falling" | "flat";
  atr: number; // normalized ATR (ATR / price * 1000)

  // Technical
  rsi: number; // 0-100
  priceVsVwap: number; // % above/below VWAP
  trend15m: "up" | "down" | "flat";
  trendDaily: "up" | "down" | "flat";

  // Setup
  instrument: string; // MES, MNQ, MGC
  setupType: string; // opening_range, trend_continuation, mean_reversion, gap_fill
  direction: "long" | "short";
  riskReward: number; // target / stop distance

  // Intermarket
  dollarTrend: "rising" | "falling" | "flat";
  bondTrend: "rising" | "falling" | "flat";

  // Outcome (filled after trade completes)
  outcome?: "win" | "loss";
  pnlR?: number; // P&L in R-multiples
}

// Store a completed trade's setup for future pattern matching
export async function storePattern(vector: SetupVector): Promise<void> {
  try {
    await prisma.agentConfig.findUnique({ where: { key: "pattern_memory" } }); // existence check
    const existing = await prisma.agentConfig.findUnique({ where: { key: "pattern_memory" } });
    const patterns: SetupVector[] = existing?.value ? JSON.parse(existing.value) : [];
    patterns.push(vector);
    // Keep last 1000 patterns (rolling window)
    const trimmed = patterns.slice(-1000);
    await prisma.agentConfig.upsert({
      where: { key: "pattern_memory" },
      update: { value: JSON.stringify(trimmed) },
      create: { key: "pattern_memory", value: JSON.stringify(trimmed) },
    });
  } catch {}
}

// Correct a stored pattern's outcome when fill reconciliation finds the real P&L
// Matches on instrument + direction + old outcome (most recent match wins)
export async function correctPattern(
  instrument: string,
  direction: "long" | "short",
  oldOutcome: "win" | "loss",
  newOutcome: "win" | "loss",
  newPnlR: number,
): Promise<boolean> {
  try {
    const existing = await prisma.agentConfig.findUnique({ where: { key: "pattern_memory" } });
    if (!existing?.value) return false;

    const patterns: SetupVector[] = JSON.parse(existing.value);

    // Find the most recent matching pattern (search from end)
    let matchIdx = -1;
    for (let i = patterns.length - 1; i >= 0; i--) {
      const p = patterns[i];
      if (p.instrument === instrument && p.direction === direction && p.outcome === oldOutcome) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx === -1) return false;

    patterns[matchIdx].outcome = newOutcome;
    patterns[matchIdx].pnlR = newPnlR;

    await prisma.agentConfig.upsert({
      where: { key: "pattern_memory" },
      update: { value: JSON.stringify(patterns) },
      create: { key: "pattern_memory", value: JSON.stringify(patterns) },
    });
    return true;
  } catch {
    return false;
  }
}

// Find similar historical setups and return their win rate
export async function predictOutcome(current: Omit<SetupVector, "outcome" | "pnlR">): Promise<{
  matchCount: number;
  winRate: number;
  avgPnlR: number;
  score: number; // 0-100 pattern confidence
  topMatches: { similarity: number; outcome: string; pnlR: number }[];
}> {
  try {
    const stored = await prisma.agentConfig.findUnique({ where: { key: "pattern_memory" } });
    if (!stored?.value) return { matchCount: 0, winRate: 0.5, avgPnlR: 0, score: 50, topMatches: [] };

    const patterns: SetupVector[] = JSON.parse(stored.value).filter((p: SetupVector) => p.outcome);

    if (patterns.length < 10) return { matchCount: patterns.length, winRate: 0.5, avgPnlR: 0, score: 50, topMatches: [] };

    // Calculate similarity score for each historical pattern
    const scored = patterns.map(p => ({
      pattern: p,
      similarity: calculateSimilarity(current, p),
    })).sort((a, b) => b.similarity - a.similarity);

    // Take top 20 most similar
    const topN = scored.slice(0, 20);
    const wins = topN.filter(s => s.pattern.outcome === "win").length;
    const winRate = wins / topN.length;
    const avgPnlR = topN.reduce((s, t) => s + (t.pattern.pnlR || 0), 0) / topN.length;

    // Convert win rate to a score (50 = baseline, 100 = all wins, 0 = all losses)
    const score = Math.round(winRate * 100);

    return {
      matchCount: patterns.length,
      winRate,
      avgPnlR,
      score,
      topMatches: topN.slice(0, 5).map(s => ({
        similarity: Math.round(s.similarity * 100),
        outcome: s.pattern.outcome || "unknown",
        pnlR: s.pattern.pnlR || 0,
      })),
    };
  } catch {
    return { matchCount: 0, winRate: 0.5, avgPnlR: 0, score: 50, topMatches: [] };
  }
}

// Similarity function — weighted feature comparison
function calculateSimilarity(a: Omit<SetupVector, "outcome" | "pnlR">, b: SetupVector): number {
  let score = 0;
  let maxScore = 0;

  // Exact matches (high weight)
  maxScore += 3;
  if (a.regime === b.regime) score += 3;

  maxScore += 3;
  if (a.instrument === b.instrument) score += 3;

  maxScore += 2;
  if (a.setupType === b.setupType) score += 2;

  maxScore += 2;
  if (a.direction === b.direction) score += 2;

  maxScore += 2;
  if (a.session === b.session) score += 2;

  maxScore += 1;
  if (a.trend15m === b.trend15m) score += 1;

  maxScore += 1;
  if (a.trendDaily === b.trendDaily) score += 1;

  maxScore += 1;
  if (a.dollarTrend === b.dollarTrend) score += 1;

  maxScore += 1;
  if (a.vixTrend === b.vixTrend) score += 1;

  // Continuous similarity (closer = more similar)
  maxScore += 2;
  score += (1 - Math.min(1, Math.abs(a.rsi - b.rsi) / 30)) * 2;

  maxScore += 2;
  score += (1 - Math.min(1, Math.abs(a.vixLevel - b.vixLevel) / 15)) * 2;

  maxScore += 1;
  score += (1 - Math.min(1, Math.abs(a.riskReward - b.riskReward) / 3)) * 1;

  maxScore += 1;
  score += (1 - Math.min(1, Math.abs(a.atr - b.atr) / 5)) * 1;

  return score / maxScore; // 0 to 1
}
