import { prisma } from "./db";
import { getAccount } from "./alpaca";
import { getTradovateAccountSummary } from "./tradovate";
import { sendNotification } from "./notifications";

// ============ DRAWDOWN RECOVERY PROTOCOL ============
// When the account draws down, don't just trade smaller — trade DIFFERENTLY.
// 4 operating modes: NORMAL → CAUTION → RECOVERY → LOCKDOWN
// Each mode changes: min score, stops, strategies, correlation, sizing.
// The simple "loss multiplier" approach loses money differently but still loses.
// This protocol changes the ENTIRE trading approach.

export type DrawdownMode = "NORMAL" | "CAUTION" | "RECOVERY" | "LOCKDOWN";

export interface DrawdownState {
  mode: DrawdownMode;
  currentDrawdownPct: number;
  peakEquity: number;
  currentEquity: number;
  daysSinceNewHigh: number;
  consecutiveLosses: number;
  recentWinRate: number;
  // Mode-specific overrides
  overrides: DrawdownOverrides;
  // History
  modeChangedAt: string;
  reason: string;
}

export interface DrawdownOverrides {
  // Position sizing
  sizeMultiplier: number;
  // Entry quality
  minScoreOverride: number; // raise minimum AI score
  minConfidenceOverride: number;
  // Risk management
  stopMultiplier: number; // tighten stops (e.g., 0.8 = 20% tighter)
  profitTargetMultiplier: number; // lower profit targets to lock in sooner
  // Strategy selection
  allowedStrategies: string[];
  bannedStrategies: string[];
  // Correlation
  maxCorrelation: number; // lower = stricter
  maxPositions: number;
  // Recovery conditions
  winsToRecover: number; // consecutive wins needed to step up a mode
}

// Mode definitions
const MODE_CONFIGS: Record<DrawdownMode, {
  triggers: { drawdownPct?: number; consecutiveLosses?: number; winRate?: number };
  overrides: DrawdownOverrides;
  description: string;
}> = {
  NORMAL: {
    triggers: {},
    overrides: {
      sizeMultiplier: 1.0,
      minScoreOverride: 0, // use agent's default
      minConfidenceOverride: 0,
      stopMultiplier: 1.0,
      profitTargetMultiplier: 1.0,
      allowedStrategies: ["all"],
      bannedStrategies: [],
      maxCorrelation: 0.7,
      maxPositions: 8,
      winsToRecover: 0,
    },
    description: "Normal operations. All strategies available.",
  },
  CAUTION: {
    triggers: { drawdownPct: 5, consecutiveLosses: 4 },
    overrides: {
      sizeMultiplier: 0.75,
      minScoreOverride: 60,
      minConfidenceOverride: 65,
      stopMultiplier: 0.9, // 10% tighter stops
      profitTargetMultiplier: 0.85,
      allowedStrategies: ["all"],
      bannedStrategies: ["quick_play"],
      maxCorrelation: 0.5,
      maxPositions: 6,
      winsToRecover: 2,
    },
    description: "Caution. Slightly tighter risk, still trading all setups.",
  },
  RECOVERY: {
    triggers: { drawdownPct: 8, consecutiveLosses: 6, winRate: 25 },
    overrides: {
      sizeMultiplier: 0.5,
      minScoreOverride: 65,
      minConfidenceOverride: 70,
      stopMultiplier: 0.8, // 20% tighter stops
      profitTargetMultiplier: 0.7,
      allowedStrategies: ["premium_selling", "credit_spread", "iron_condor", "directional_high_conviction"],
      bannedStrategies: ["quick_play", "gap_play", "momentum"],
      maxCorrelation: 0.4,
      maxPositions: 4,
      winsToRecover: 3,
    },
    description: "Recovery mode. High conviction only. Reduced size but still trading.",
  },
  LOCKDOWN: {
    triggers: { drawdownPct: 12, consecutiveLosses: 8 },
    overrides: {
      sizeMultiplier: 0,
      minScoreOverride: 100, // effectively blocks all trades
      minConfidenceOverride: 100,
      stopMultiplier: 0.5,
      profitTargetMultiplier: 0.5,
      allowedStrategies: [],
      bannedStrategies: ["all"],
      maxCorrelation: 0,
      maxPositions: 0,
      winsToRecover: 5,
    },
    description: "LOCKDOWN. No new trades. Manage existing positions only. Manual review required.",
  },
};

export async function evaluateDrawdownState(): Promise<DrawdownState> {
  // Try Tradovate first (futures account), fall back to Alpaca (stocks/options)
  let currentEquity = 0;
  try {
    const tradovate = await getTradovateAccountSummary();
    currentEquity = tradovate.netLiq || tradovate.balance || 0;
  } catch {
    // Fallback to Alpaca if Tradovate unavailable
    const account = await getAccount();
    currentEquity = parseFloat(account.equity);
  }

  // Get peak equity from stored state
  const storedState = await prisma.agentConfig.findUnique({ where: { key: "drawdown_state" } });
  let peakEquity = currentEquity;
  let previousMode: DrawdownMode = "NORMAL";

  if (storedState?.value) {
    try {
      const prev = JSON.parse(storedState.value) as DrawdownState;
      peakEquity = Math.max(prev.peakEquity, currentEquity);
      previousMode = prev.mode;
    } catch { /* use defaults */ }
  }

  // Update peak if we made a new high
  if (currentEquity > peakEquity) {
    peakEquity = currentEquity;
  }

  const currentDrawdownPct = peakEquity > 0
    ? ((peakEquity - currentEquity) / peakEquity) * 100
    : 0;

  // Calculate consecutive losses and recent win rate
  const recentTrades = await prisma.autoTradeLog.findMany({
    where: {
      pnl: { not: null },
      action: { notIn: ["skip", "risk_veto", "liquidity_veto"] },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  let consecutiveLosses = 0;
  for (const trade of recentTrades) {
    if ((trade.pnl || 0) < 0) consecutiveLosses++;
    else break;
  }

  const recentWins = recentTrades.filter((t) => (t.pnl || 0) > 0).length;
  const recentWinRate = recentTrades.length > 0 ? (recentWins / recentTrades.length) * 100 : 50;

  // Days since new equity high (rough estimate from drawdown depth)
  let daysSinceNewHigh = 0;
  if (currentEquity < peakEquity) {
    daysSinceNewHigh = Math.ceil(currentDrawdownPct * 2); // rough estimate
  }

  // Determine mode based on triggers
  let newMode: DrawdownMode = "NORMAL";

  if (currentDrawdownPct >= (MODE_CONFIGS.LOCKDOWN.triggers.drawdownPct || 99) ||
      consecutiveLosses >= (MODE_CONFIGS.LOCKDOWN.triggers.consecutiveLosses || 99)) {
    newMode = "LOCKDOWN";
  } else if (currentDrawdownPct >= (MODE_CONFIGS.RECOVERY.triggers.drawdownPct || 99) ||
             consecutiveLosses >= (MODE_CONFIGS.RECOVERY.triggers.consecutiveLosses || 99) ||
             recentWinRate <= (MODE_CONFIGS.RECOVERY.triggers.winRate || 0)) {
    newMode = "RECOVERY";
  } else if (currentDrawdownPct >= (MODE_CONFIGS.CAUTION.triggers.drawdownPct || 99) ||
             consecutiveLosses >= (MODE_CONFIGS.CAUTION.triggers.consecutiveLosses || 99)) {
    newMode = "CAUTION";
  }

  // Check for mode upgrade (consecutive wins during recovery)
  if (previousMode !== "NORMAL" && newMode === previousMode) {
    // Check if we've earned an upgrade via consecutive wins
    let consecutiveWins = 0;
    for (const trade of recentTrades) {
      if ((trade.pnl || 0) > 0) consecutiveWins++;
      else break;
    }

    const winsNeeded = MODE_CONFIGS[previousMode].overrides.winsToRecover;
    if (consecutiveWins >= winsNeeded) {
      // Step up one level
      if (previousMode === "LOCKDOWN") newMode = "RECOVERY";
      else if (previousMode === "RECOVERY") newMode = "CAUTION";
      else if (previousMode === "CAUTION") newMode = "NORMAL";
    }
  }

  const config = MODE_CONFIGS[newMode];
  let reason = config.description;

  if (newMode !== previousMode) {
    if (newMode === "NORMAL" && previousMode !== "NORMAL") {
      reason = `Upgraded from ${previousMode} — consecutive wins met threshold. Resuming normal operations.`;
    } else if (newMode !== "NORMAL") {
      reason = `Drawdown ${currentDrawdownPct.toFixed(1)}%, ${consecutiveLosses} consecutive losses, ${recentWinRate.toFixed(0)}% win rate. ${config.description}`;
    }
  }

  const state: DrawdownState = {
    mode: newMode,
    currentDrawdownPct,
    peakEquity,
    currentEquity,
    daysSinceNewHigh,
    consecutiveLosses,
    recentWinRate,
    overrides: config.overrides,
    modeChangedAt: new Date().toISOString(),
    reason,
  };

  // Store state
  await prisma.agentConfig.upsert({
    where: { key: "drawdown_state" },
    update: { value: JSON.stringify(state) },
    create: { key: "drawdown_state", value: JSON.stringify(state) },
  });

  // Store overrides for agents to read
  await prisma.agentConfig.upsert({
    where: { key: "drawdown_mode" },
    update: { value: newMode },
    create: { key: "drawdown_mode", value: newMode },
  });

  await prisma.agentConfig.upsert({
    where: { key: "drawdown_overrides" },
    update: { value: JSON.stringify(config.overrides) },
    create: { key: "drawdown_overrides", value: JSON.stringify(config.overrides) },
  });

  // Notify on mode changes
  if (newMode !== previousMode) {
    const emoji = newMode === "LOCKDOWN" ? "🔴" : newMode === "RECOVERY" ? "🟠" : newMode === "CAUTION" ? "🟡" : "🟢";
    await sendNotification(
      `${emoji} DRAWDOWN MODE: ${previousMode} → ${newMode}\n` +
      `Drawdown: ${currentDrawdownPct.toFixed(1)}% | Peak: $${peakEquity.toFixed(0)} | Current: $${currentEquity.toFixed(0)}\n` +
      `Consecutive losses: ${consecutiveLosses} | Win rate: ${recentWinRate.toFixed(0)}%\n` +
      `${reason}\n` +
      `Sizing: ${(config.overrides.sizeMultiplier * 100).toFixed(0)}% | Max positions: ${config.overrides.maxPositions} | Min score: ${config.overrides.minScoreOverride || "default"}`,
      "general"
    );
  }

  return state;
}

// Helper for agents: get current drawdown overrides
export async function getDrawdownOverrides(): Promise<DrawdownOverrides | null> {
  try {
    const config = await prisma.agentConfig.findUnique({ where: { key: "drawdown_overrides" } });
    if (!config?.value) return null;
    return JSON.parse(config.value) as DrawdownOverrides;
  } catch {
    return null;
  }
}

// Helper for agents: check if a strategy is allowed
export async function isStrategyAllowed(strategy: string): Promise<boolean> {
  const overrides = await getDrawdownOverrides();
  if (!overrides) return true; // no overrides = everything allowed
  if (overrides.bannedStrategies.includes("all")) return false;
  if (overrides.allowedStrategies.includes("all")) return true;
  if (overrides.bannedStrategies.includes(strategy)) return false;
  if (overrides.allowedStrategies.length > 0) return overrides.allowedStrategies.includes(strategy);
  return true;
}
