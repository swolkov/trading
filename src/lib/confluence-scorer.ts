import { prisma } from "./db";

// ============ CONFLUENCE SCORER ============
// Combines all independent signals into one weighted score (0-100).
// The closer to 100, the higher probability the trade wins.
// Weights are updated by synthesis agent based on what actually predicts wins.

export interface ConfluenceFactors {
  // Technical (from setup detection)
  technicalScore: number; // 0-100 from setup detector
  rsiConfirms: boolean; // RSI supports direction (not overbought into longs, etc.)
  vwapConfirms: boolean; // price on right side of VWAP for direction
  atrNormal: boolean; // ATR not extreme (not too tight, not too wide)
  multiTimeframeAligned: boolean; // 5m, 15m, daily all agree on direction

  // Intermarket
  dollarConfirms: boolean; // DXY supports (down for gold longs, etc.)
  bondsConfirm: boolean; // bond direction supports equity direction
  vixConfirms: boolean; // VIX level/trend supports trade

  // Market Internals
  tickConfirms: boolean; // TICK index supports direction
  volumeConfirms: boolean; // volume above average in trade direction
  breadthConfirms: boolean; // market breadth (advance/decline) supports

  // Context
  regimeConfirms: boolean; // current regime matches strategy (trending for breakouts)
  timeOfDayScore: number; // 0-100 based on historical WR at this time
  noAdverseEvents: boolean; // no FOMC/CPI/NFP within 2 hours
  patternMatchScore: number; // 0-100 from pattern memory (similar setups historically)

  // AI
  aiConfirms: boolean; // Claude agrees with the trade
  aiConfidence: number; // 0-100 AI confidence

  // Brain/Lessons
  brainSupports: boolean; // no active anti-pattern triggered, lessons support
}

export interface ConfluenceResult {
  score: number; // 0-100 final confluence
  grade: "A+" | "A" | "B" | "C" | "F";
  shouldTrade: boolean;
  reasoning: string[];
  threshold: number; // current adaptive threshold
}

// Default weights — updated by synthesis agent as it learns what predicts wins
const DEFAULT_WEIGHTS = {
  technicalScore: 0.15,
  rsiConfirms: 0.05,
  vwapConfirms: 0.05,
  atrNormal: 0.03,
  multiTimeframeAligned: 0.10,
  dollarConfirms: 0.05,
  bondsConfirm: 0.04,
  vixConfirms: 0.05,
  tickConfirms: 0.08,
  volumeConfirms: 0.07,
  breadthConfirms: 0.04,
  regimeConfirms: 0.08,
  timeOfDayScore: 0.06,
  noAdverseEvents: 0.03,
  patternMatchScore: 0.12,
  aiConfirms: 0.05,
  aiConfidence: 0.05,
  brainSupports: 0.03,
};

export async function scoreConfluence(factors: ConfluenceFactors): Promise<ConfluenceResult> {
  // Load weights from DB (synthesis agent updates these)
  let weights = { ...DEFAULT_WEIGHTS };
  try {
    const stored = await prisma.agentConfig.findUnique({ where: { key: "confluence_weights" } });
    if (stored?.value) {
      const parsed = JSON.parse(stored.value);
      weights = { ...weights, ...parsed };
    }
  } catch {}

  // Load adaptive threshold (adjusts based on recent performance)
  let threshold = 75; // default
  try {
    const stored = await prisma.agentConfig.findUnique({ where: { key: "confluence_threshold" } });
    if (stored?.value) threshold = parseFloat(stored.value);
  } catch {}

  // Calculate weighted score
  const reasoning: string[] = [];
  let rawScore = 0;

  // Technical (continuous scores normalized to 0-1)
  rawScore += (factors.technicalScore / 100) * weights.technicalScore;
  rawScore += (factors.rsiConfirms ? 1 : 0) * weights.rsiConfirms;
  rawScore += (factors.vwapConfirms ? 1 : 0) * weights.vwapConfirms;
  rawScore += (factors.atrNormal ? 1 : 0) * weights.atrNormal;
  rawScore += (factors.multiTimeframeAligned ? 1 : 0) * weights.multiTimeframeAligned;
  if (factors.multiTimeframeAligned) reasoning.push("multi-TF aligned");

  // Intermarket
  rawScore += (factors.dollarConfirms ? 1 : 0) * weights.dollarConfirms;
  rawScore += (factors.bondsConfirm ? 1 : 0) * weights.bondsConfirm;
  rawScore += (factors.vixConfirms ? 1 : 0) * weights.vixConfirms;
  if (factors.dollarConfirms && factors.bondsConfirm) reasoning.push("intermarket confirms");

  // Internals
  rawScore += (factors.tickConfirms ? 1 : 0) * weights.tickConfirms;
  rawScore += (factors.volumeConfirms ? 1 : 0) * weights.volumeConfirms;
  rawScore += (factors.breadthConfirms ? 1 : 0) * weights.breadthConfirms;
  if (factors.tickConfirms) reasoning.push("TICK confirms");

  // Context
  rawScore += (factors.regimeConfirms ? 1 : 0) * weights.regimeConfirms;
  rawScore += (factors.timeOfDayScore / 100) * weights.timeOfDayScore;
  rawScore += (factors.noAdverseEvents ? 1 : 0) * weights.noAdverseEvents;
  rawScore += (factors.patternMatchScore / 100) * weights.patternMatchScore;
  if (factors.patternMatchScore > 70) reasoning.push(`pattern match ${factors.patternMatchScore}%`);
  if (!factors.noAdverseEvents) reasoning.push("EVENT WARNING");

  // AI
  rawScore += (factors.aiConfirms ? 1 : 0) * weights.aiConfirms;
  rawScore += (factors.aiConfidence / 100) * weights.aiConfidence;
  if (factors.aiConfirms) reasoning.push("AI confirms");

  // Brain
  rawScore += (factors.brainSupports ? 1 : 0) * weights.brainSupports;
  if (!factors.brainSupports) reasoning.push("brain anti-pattern triggered");

  // Normalize to 0-100
  const score = Math.round(rawScore * 100);

  // Grade
  const grade = score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "C" : "F";
  const shouldTrade = score >= threshold;

  if (!shouldTrade) reasoning.push(`below threshold (${score} < ${threshold})`);

  return { score, grade, shouldTrade, reasoning, threshold };
}

// Adaptive threshold: adjusts based on recent win/loss streak
export async function updateAdaptiveThreshold(): Promise<number> {
  try {
    const recentTrades = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "FUT:" }, pnl: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    if (recentTrades.length < 3) return 75;

    const recentWins = recentTrades.filter(t => (t.pnl || 0) > 0).length;
    const recentWR = recentWins / recentTrades.length;

    // After losses: raise threshold (be more selective)
    // After wins: lower threshold (ride the hot streak)
    let threshold: number;
    if (recentWR < 0.3) threshold = 85; // cold streak — only A+ trades
    else if (recentWR < 0.5) threshold = 80; // below average — be selective
    else if (recentWR > 0.7) threshold = 70; // hot streak — slightly looser
    else threshold = 75; // normal

    await prisma.agentConfig.upsert({
      where: { key: "confluence_threshold" },
      update: { value: String(threshold) },
      create: { key: "confluence_threshold", value: String(threshold) },
    });

    return threshold;
  } catch { return 75; }
}
