// ============ SYNTHESIS AGENT ============
// Analyzes trade history, extracts patterns, updates the Obsidian vault.
// Runs daily at 4:30 PM ET (post-market) or after every 10 trades.
// This is the learning engine — it makes agents smarter over time.

import { runSynthesis, vaultWrite, logObservation, type SynthesisResult } from "./vault";
import { prisma } from "./db";

export interface SynthesisAgentResult extends SynthesisResult {
  shouldRun: boolean;
  reason: string;
  details: string[];
}

// Check if synthesis should run (every 10 new trades or daily)
async function shouldRunSynthesis(): Promise<{ should: boolean; reason: string }> {
  const lastRun = await prisma.agentConfig.findUnique({
    where: { key: "synthesis_last_run" },
  });

  const lastRunTime = lastRun?.value ? new Date(lastRun.value).getTime() : 0;
  const hoursSinceLastRun = (Date.now() - lastRunTime) / (1000 * 60 * 60);

  // Always run if > 6 hours since last run
  if (hoursSinceLastRun > 6) {
    return { should: true, reason: `${hoursSinceLastRun.toFixed(0)}h since last synthesis` };
  }

  // Count new trades since last run
  const newTrades = await prisma.autoTradeLog.count({
    where: {
      pnl: { not: null },
      createdAt: { gt: lastRun?.value ? new Date(lastRun.value) : new Date(0) },
    },
  });

  if (newTrades >= 10) {
    return { should: true, reason: `${newTrades} new closed trades since last run` };
  }

  return { should: false, reason: `Only ${newTrades} new trades, last run ${hoursSinceLastRun.toFixed(1)}h ago` };
}

export async function runSynthesisAgent(force = false): Promise<SynthesisAgentResult> {
  const details: string[] = [];

  // Check if we should run
  const check = await shouldRunSynthesis();
  if (!check.should && !force) {
    return {
      shouldRun: false,
      reason: check.reason,
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      lessonsExtracted: 0,
      antiPatternsFound: 0,
      details: [check.reason],
    };
  }

  details.push(`Running synthesis: ${check.reason}`);

  try {
    // Run the core synthesis engine from vault.ts
    const result = await runSynthesis();
    details.push(`Analyzed ${result.totalTrades} trades`);
    details.push(`Win rate: ${(result.winRate * 100).toFixed(1)}%, PF: ${result.profitFactor.toFixed(2)}`);
    details.push(`Lessons extracted: ${result.lessonsExtracted}, Anti-patterns: ${result.antiPatternsFound}`);

    // Log observation about the synthesis run
    try {
      const summary = `Synthesis run: ${result.totalTrades} trades, ${(result.winRate * 100).toFixed(0)}% WR, PF ${result.profitFactor.toFixed(2)}, ${result.lessonsExtracted} lessons, ${result.antiPatternsFound} anti-patterns`;
      await logObservation("synthesis-agent", summary);
    } catch { /* best effort */ }

    // Update last run timestamp
    await prisma.agentConfig.upsert({
      where: { key: "synthesis_last_run" },
      update: { value: new Date().toISOString() },
      create: { key: "synthesis_last_run", value: new Date().toISOString() },
    });

    return {
      shouldRun: true,
      reason: check.reason,
      ...result,
      details,
    };
  } catch (error) {
    details.push(`Synthesis error: ${error instanceof Error ? error.message : String(error)}`);
    return {
      shouldRun: true,
      reason: check.reason,
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      lessonsExtracted: 0,
      antiPatternsFound: 0,
      details,
    };
  }
}
