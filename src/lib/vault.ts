import { prisma } from "./db";

// ============ OBSIDIAN VAULT INTERFACE ============
// DB-backed vault that syncs with local Obsidian at ~/Desktop/Trading/Trading/
// Agents read/write via DB (works on Vercel/Railway).
// Local sync script keeps Obsidian files in sync.

// ============ READ ============

export async function vaultRead(path: string): Promise<string | null> {
  const doc = await prisma.vaultDocument.findUnique({ where: { path } });
  return doc?.content ?? null;
}

export async function vaultReadMultiple(paths: string[]): Promise<Record<string, string>> {
  const docs = await prisma.vaultDocument.findMany({
    where: { path: { in: paths } },
  });
  const result: Record<string, string> = {};
  for (const doc of docs) {
    result[doc.path] = doc.content;
  }
  return result;
}

// ============ WRITE ============

export async function vaultWrite(path: string, content: string, updatedBy: string): Promise<void> {
  await prisma.vaultDocument.upsert({
    where: { path },
    create: { path, content, updatedBy },
    update: { content, updatedBy },
  });
}

export async function vaultAppend(path: string, appendContent: string, updatedBy: string): Promise<void> {
  const existing = await vaultRead(path);
  const newContent = existing ? `${existing}\n${appendContent}` : appendContent;
  await vaultWrite(path, newContent, updatedBy);
}

// ============ LIST ============

export async function vaultList(prefix?: string): Promise<{ path: string; updatedAt: Date; updatedBy: string }[]> {
  const where = prefix ? { path: { startsWith: prefix } } : {};
  return prisma.vaultDocument.findMany({
    where,
    select: { path: true, updatedAt: true, updatedBy: true },
    orderBy: { updatedAt: "desc" },
  });
}

// ============ AGENT CONTEXT LOADER ============
// Loads all vault context an agent needs before trading

export interface AgentContext {
  riskRules: string | null;
  marketRegime: string | null;
  volatility: string | null;
  strategy: string | null;
  activeLessons: string | null;
  antiPatterns: string | null;
  agentConfig: string | null;
  recentJournals: string[];
}

export async function loadAgentContext(agentName: string, strategyFile: string): Promise<AgentContext> {
  const paths = [
    "Rules/risk-management.md",
    "Brain/market-regime.md",
    "Brain/volatility-environment.md",
    `Strategies/${strategyFile}`,
    "Lessons/active-lessons.md",
    "Rules/anti-patterns.md",
    `Agent-Config/${agentName}.md`,
  ];

  const docs = await vaultReadMultiple(paths);

  // Get last 3 journal entries
  const journals = await prisma.vaultDocument.findMany({
    where: { path: { startsWith: "Journal/" }, NOT: { path: { contains: "_template" } } },
    orderBy: { updatedAt: "desc" },
    take: 3,
  });

  return {
    riskRules: docs["Rules/risk-management.md"] ?? null,
    marketRegime: docs["Brain/market-regime.md"] ?? null,
    volatility: docs["Brain/volatility-environment.md"] ?? null,
    strategy: docs[`Strategies/${strategyFile}`] ?? null,
    activeLessons: docs["Lessons/active-lessons.md"] ?? null,
    antiPatterns: docs["Rules/anti-patterns.md"] ?? null,
    agentConfig: docs[`Agent-Config/${agentName}.md`] ?? null,
    recentJournals: journals.map((j) => j.content),
  };
}

// ============ TRADE JOURNAL LOGGING ============

export interface TradeEntry {
  tradeId: string;
  timestamp: string;
  instrument: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  setupType: string;
  contracts: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitPrice?: number;
  pnlDollars?: number;
  rMultiple?: number;
  conviction: number;
  exitReason?: string;
  followedPlan?: boolean;
  lesson?: string;
}

function formatTradeYaml(trade: TradeEntry): string {
  return `### Trade ${trade.tradeId}
\`\`\`yaml
trade_id: "${trade.tradeId}"
timestamp_entry: "${trade.timestamp}"
instrument: "${trade.instrument}"
direction: "${trade.direction}"
strategy: "${trade.strategy}"
setup_type: "${trade.setupType}"
contracts_shares: ${trade.contracts}
entry_price: ${trade.entryPrice}
stop_price: ${trade.stopPrice}
target_price: ${trade.targetPrice}
${trade.exitPrice != null ? `exit_price: ${trade.exitPrice}` : "exit_price: null"}
${trade.pnlDollars != null ? `pnl_dollars: ${trade.pnlDollars.toFixed(2)}` : "pnl_dollars: null"}
${trade.rMultiple != null ? `r_multiple: ${trade.rMultiple.toFixed(2)}` : "r_multiple: null"}
conviction: ${trade.conviction}
${trade.exitReason ? `exit_reason: "${trade.exitReason}"` : "exit_reason: null"}
${trade.followedPlan != null ? `followed_plan: ${trade.followedPlan}` : "followed_plan: null"}
${trade.lesson ? `lesson: "${trade.lesson}"` : "lesson: null"}
\`\`\`
`;
}

export async function logTradeToJournal(trade: TradeEntry, agentName: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const journalPath = `Journal/${today}.md`;

  const existing = await vaultRead(journalPath);
  const tradeYaml = formatTradeYaml(trade);

  if (existing) {
    await vaultAppend(journalPath, tradeYaml, agentName);
  } else {
    // Create new journal entry for today
    const header = `---
date: "${today}"
agent: "${agentName}"
---

# Trading Journal — ${today}

## Trades

`;
    await vaultWrite(journalPath, header + tradeYaml, agentName);
  }
}

// ============ DECISION LOGGING ============

export async function logDecision(
  agentName: string,
  type: "ENTRY" | "EXIT" | "SKIP" | "ADJUSTMENT",
  instrument: string,
  rationale: string,
  confidence: number,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const path = `Decisions/${today}.md`;
  const timestamp = new Date().toISOString();
  const id = `D${Date.now().toString(36)}`;

  const entry = `### ${id}
\`\`\`yaml
timestamp: "${timestamp}"
type: "${type}"
agent: "${agentName}"
instrument: "${instrument}"
rationale: "${rationale.replace(/"/g, "'")}"
confidence: ${confidence}
\`\`\`

`;

  const existing = await vaultRead(path);
  if (existing) {
    await vaultAppend(path, entry, agentName);
  } else {
    const header = `---
date: "${today}"
agent: "${agentName}"
---

# Decision Log — ${today}

`;
    await vaultWrite(path, header + entry, agentName);
  }
}

// ============ OBSERVATION LOGGING ============

export async function logObservation(agentName: string, observation: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const entry = `- [${today}] [${agentName}] ${observation}`;
  await vaultAppend("Lessons/raw-observations.md", entry, agentName);
}

// ============ MARKET BRAIN UPDATES ============

export async function updateMarketRegime(
  regime: string,
  details: {
    trend?: string;
    volatility?: string;
    breadth?: string;
    momentum?: string;
    spxSupport?: string;
    spxResistance?: string;
    implications?: string;
  },
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const content = `---
last_updated: "${today}"
updated_by: "research-agent"
---

# Market Regime Assessment

## Current Regime
- **Trend**: ${details.trend || "unknown"}
- **Volatility**: ${details.volatility || "unknown"}
- **Breadth**: ${details.breadth || "unknown"}
- **Momentum**: ${details.momentum || "unknown"}

## Regime Classification

**Current**: \`${regime.toUpperCase()}\`

## Key Levels
| Index | Support | Resistance |
|-------|---------|------------|
| SPX   | ${details.spxSupport || ""} | ${details.spxResistance || ""} |

## Implications for Agents
${details.implications || "Follow standard strategy parameters for current regime."}
`;

  await vaultWrite("Brain/market-regime.md", content, "research-agent");
}

export async function updateVolatilityEnvironment(
  vix: number,
  vixPercentile: string,
  termStructure: string,
  volRegime: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const content = `---
last_updated: "${today}"
updated_by: "research-agent"
---

# Volatility Environment

## Current State
- **VIX**: ${vix.toFixed(1)}
- **VIX Percentile (1Y)**: ${vixPercentile}
- **VIX Term Structure**: ${termStructure}

## Vol Regime

**Current**: \`${volRegime}\`

## Implications
${vix > 30 ? "- HIGH VOL: Reduce position sizes, widen stops, avoid new entries unless high conviction" : ""}
${vix > 20 && vix <= 30 ? "- ELEVATED: Normal sizing but wider stops, good premium selling environment" : ""}
${vix <= 20 ? "- NORMAL/LOW: Standard parameters, tight stops acceptable" : ""}
`;

  await vaultWrite("Brain/volatility-environment.md", content, "research-agent");
}

// ============ SYNTHESIS ENGINE ============
// Run after every 10 trades or at end of day

export interface SynthesisResult {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  lessonsExtracted: number;
  antiPatternsFound: number;
}

export async function runSynthesis(): Promise<SynthesisResult> {
  // Get all closed trades from DB
  const allTrades = await prisma.autoTradeLog.findMany({
    where: { pnl: { not: null } },
    orderBy: { createdAt: "desc" },
  });

  const winners = allTrades.filter((t) => (t.pnl || 0) > 0);
  const losers = allTrades.filter((t) => (t.pnl || 0) <= 0);
  const totalTrades = allTrades.length;
  const winRate = totalTrades > 0 ? winners.length / totalTrades : 0;
  const grossProfit = winners.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const totalPnl = allTrades.reduce((s, t) => s + (t.pnl || 0), 0);

  // Break down by action type (strategy proxy)
  const futuresTrades = allTrades.filter((t) => t.symbol.startsWith("FUT:"));
  const optionsTrades = allTrades.filter((t) =>
    t.action.includes("call") || t.action.includes("put") || t.action.includes("condor") || t.action.includes("spread"),
  );
  const stockTrades = allTrades.filter((t) => !t.symbol.startsWith("FUT:") && !t.action.includes("call") && !t.action.includes("put"));

  function calcStats(trades: typeof allTrades) {
    if (trades.length === 0) return { trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0 };
    const w = trades.filter((t) => (t.pnl || 0) > 0);
    return {
      trades: trades.length,
      winRate: w.length / trades.length,
      avgPnl: trades.reduce((s, t) => s + (t.pnl || 0), 0) / trades.length,
      totalPnl: trades.reduce((s, t) => s + (t.pnl || 0), 0),
    };
  }

  const futuresStats = calcStats(futuresTrades);
  const optionsStats = calcStats(optionsTrades);
  const stockStats = calcStats(stockTrades);

  // Time-of-day analysis
  const hourBuckets: Record<string, { trades: number; wins: number }> = {};
  for (const t of allTrades) {
    const hour = t.createdAt.getUTCHours();
    let bucket = "other";
    if (hour >= 13 && hour < 14) bucket = "first_30_min";
    else if (hour >= 14 && hour < 16) bucket = "mid_morning";
    else if (hour >= 16 && hour < 18) bucket = "midday";
    else if (hour >= 18 && hour < 20) bucket = "afternoon";
    else if (hour >= 20) bucket = "last_30_min";
    if (!hourBuckets[bucket]) hourBuckets[bucket] = { trades: 0, wins: 0 };
    hourBuckets[bucket].trades++;
    if ((t.pnl || 0) > 0) hourBuckets[bucket].wins++;
  }

  // Score-based analysis
  const scoredTrades = allTrades.filter((t) => t.aiScore != null);
  const scoreGroups: Record<string, { trades: number; wins: number }> = {};
  for (const t of scoredTrades) {
    const bucket = t.aiScore! >= 80 ? "5" : t.aiScore! >= 70 ? "4" : t.aiScore! >= 60 ? "3" : t.aiScore! >= 50 ? "2" : "1";
    if (!scoreGroups[bucket]) scoreGroups[bucket] = { trades: 0, wins: 0 };
    scoreGroups[bucket].trades++;
    if ((t.pnl || 0) > 0) scoreGroups[bucket].wins++;
  }

  // Update Performance/statistics.md
  const today = new Date().toISOString().slice(0, 10);
  const statsContent = `---
last_updated: "${today}"
updated_by: "synthesis-agent"
---

# Performance Statistics

## Lifetime Stats
\`\`\`yaml
total_trades: ${totalTrades}
total_pnl: ${totalPnl.toFixed(2)}
win_rate: ${(winRate * 100).toFixed(1)}
profit_factor: ${profitFactor.toFixed(2)}
max_consecutive_wins: 0
max_consecutive_losses: 0
\`\`\`

## By Strategy
\`\`\`yaml
futures:
  trades: ${futuresStats.trades}
  win_rate: ${(futuresStats.winRate * 100).toFixed(1)}
  avg_pnl: ${futuresStats.avgPnl.toFixed(2)}
  total_pnl: ${futuresStats.totalPnl.toFixed(2)}

options:
  trades: ${optionsStats.trades}
  win_rate: ${(optionsStats.winRate * 100).toFixed(1)}
  avg_pnl: ${optionsStats.avgPnl.toFixed(2)}
  total_pnl: ${optionsStats.totalPnl.toFixed(2)}

stocks:
  trades: ${stockStats.trades}
  win_rate: ${(stockStats.winRate * 100).toFixed(1)}
  avg_pnl: ${stockStats.avgPnl.toFixed(2)}
  total_pnl: ${stockStats.totalPnl.toFixed(2)}
\`\`\`

## By Conviction/Score Level
\`\`\`yaml
${Object.entries(scoreGroups).map(([k, v]) => `conviction_${k}: { trades: ${v.trades}, win_rate: ${v.trades > 0 ? ((v.wins / v.trades) * 100).toFixed(1) : 0} }`).join("\n")}
\`\`\`

## By Time of Day
\`\`\`yaml
${Object.entries(hourBuckets).map(([k, v]) => `${k}: { trades: ${v.trades}, win_rate: ${v.trades > 0 ? ((v.wins / v.trades) * 100).toFixed(1) : 0} }`).join("\n")}
\`\`\`

## Equity Curve Data Points
\`\`\`csv
date,cumulative_pnl
${today},${totalPnl.toFixed(2)}
\`\`\`
`;

  await vaultWrite("Performance/statistics.md", statsContent, "synthesis-agent");

  // Extract lessons from patterns
  let lessonsExtracted = 0;
  let antiPatternsFound = 0;
  const lessons: string[] = [];
  const antiPatterns: string[] = [];

  // Lesson: Score threshold analysis
  for (const [bucket, data] of Object.entries(scoreGroups)) {
    if (data.trades >= 5) {
      const wr = data.wins / data.trades;
      if (wr < 0.35) {
        antiPatterns.push(`Low conviction trades (score bucket ${bucket}) have only ${(wr * 100).toFixed(0)}% win rate over ${data.trades} trades — skip these.`);
        antiPatternsFound++;
      }
      if (wr > 0.65) {
        lessons.push(`High conviction trades (score bucket ${bucket}) have ${(wr * 100).toFixed(0)}% win rate over ${data.trades} trades — size up on these.`);
        lessonsExtracted++;
      }
    }
  }

  // Lesson: Time of day analysis
  for (const [bucket, data] of Object.entries(hourBuckets)) {
    if (data.trades >= 5) {
      const wr = data.wins / data.trades;
      if (wr < 0.3) {
        antiPatterns.push(`Trading during ${bucket} has only ${(wr * 100).toFixed(0)}% win rate — avoid or reduce size.`);
        antiPatternsFound++;
      }
    }
  }

  // Lesson: Strategy performance
  if (futuresStats.trades >= 10 && futuresStats.winRate < 0.4) {
    lessons.push(`Futures strategy underperforming (${(futuresStats.winRate * 100).toFixed(0)}% WR) — review setup criteria.`);
    lessonsExtracted++;
  }
  if (optionsStats.trades >= 10 && optionsStats.winRate > 0.6) {
    lessons.push(`Options strategy performing well (${(optionsStats.winRate * 100).toFixed(0)}% WR) — consider increasing allocation.`);
    lessonsExtracted++;
  }

  // Update active lessons (only if we have enough data)
  if (totalTrades >= 10 && (lessonsExtracted > 0 || antiPatternsFound > 0)) {
    const lessonsContent = `---
last_updated: "${today}"
updated_by: "synthesis-agent"
total_lessons: ${lessonsExtracted + antiPatternsFound}
---

# Active Lessons

> Auto-generated by synthesis agent from ${totalTrades} closed trades.
> Trading agents MUST read this file before every session.

## Lessons (Ranked by Impact)

${lessons.length > 0 ? lessons.map((l, i) => `### L${String(i + 1).padStart(3, "0")} — ${l.split(" — ")[0] || "Pattern"}\n- **LESSON**: ${l}\n- **Confidence**: ${totalTrades >= 50 ? "HIGH" : totalTrades >= 20 ? "MEDIUM" : "LOW"} (${totalTrades} trade sample)\n- **Date Added**: ${today}\n`).join("\n") : "_Insufficient data for lessons. Need more trades._\n"}

## Anti-Patterns (Avoid These)

${antiPatterns.length > 0 ? antiPatterns.map((ap, i) => `### AP${String(i + 1).padStart(3, "0")}\n- **PATTERN**: ${ap}\n- **Confidence**: ${totalTrades >= 50 ? "HIGH" : totalTrades >= 20 ? "MEDIUM" : "LOW"}\n- **Date Added**: ${today}\n`).join("\n") : "_No anti-patterns identified yet._\n"}
`;
    await vaultWrite("Lessons/active-lessons.md", lessonsContent, "synthesis-agent");

    // Also update the dedicated Rules/anti-patterns.md file
    if (antiPatterns.length > 0) {
      const antiPatternsContent = `---
last_updated: "${today}"
updated_by: "synthesis-agent"
total_patterns: ${antiPatternsFound}
---

# Anti-Patterns Database

> Auto-generated by synthesis agent from ${totalTrades} closed trades.
> Agents MUST check this before entry. These are proven losing setups.

${antiPatterns.map((ap, i) => `### AP${String(i + 1).padStart(3, "0")}
- **Pattern**: ${ap}
- **Why it fails**: Statistically confirmed losing pattern from ${totalTrades} trades
- **Confidence**: ${totalTrades >= 50 ? "HIGH" : totalTrades >= 20 ? "MEDIUM" : "LOW"}
- **Date Added**: ${today}
`).join("\n")}
`;
      await vaultWrite("Rules/anti-patterns.md", antiPatternsContent, "synthesis-agent");
    }
  }

  return { totalTrades, winRate, profitFactor, lessonsExtracted, antiPatternsFound };
}

// ============ BUILD VAULT CONTEXT STRING FOR AI PROMPTS ============
// Returns a condensed context string agents can inject into their AI analysis prompts

export async function getVaultContextForAI(agentName: string, strategyFile: string): Promise<string> {
  const ctx = await loadAgentContext(agentName, strategyFile);
  const parts: string[] = [];

  if (ctx.marketRegime) {
    // Extract just the regime classification
    const regimeMatch = ctx.marketRegime.match(/\*\*Current\*\*:\s*`([^`]+)`/);
    if (regimeMatch) parts.push(`MARKET REGIME: ${regimeMatch[1]}`);
  }

  if (ctx.volatility) {
    const vixMatch = ctx.volatility.match(/\*\*VIX\*\*:\s*(\S+)/);
    const volRegimeMatch = ctx.volatility.match(/\*\*Current\*\*:\s*`([^`]+)`/);
    if (vixMatch) parts.push(`VIX: ${vixMatch[1]}`);
    if (volRegimeMatch) parts.push(`VOL REGIME: ${volRegimeMatch[1]}`);
  }

  if (ctx.activeLessons) {
    // Extract lesson lines
    const lessonLines = ctx.activeLessons.match(/\*\*LESSON\*\*:\s*(.+)/g);
    if (lessonLines && lessonLines.length > 0) {
      parts.push(`ACTIVE LESSONS:\n${lessonLines.slice(0, 5).map((l) => `  - ${l.replace("**LESSON**: ", "")}`).join("\n")}`);
    }
    const antiPatternLines = ctx.activeLessons.match(/\*\*PATTERN\*\*:\s*(.+)/g);
    if (antiPatternLines && antiPatternLines.length > 0) {
      parts.push(`ANTI-PATTERNS (AVOID):\n${antiPatternLines.slice(0, 3).map((l) => `  - ${l.replace("**PATTERN**: ", "")}`).join("\n")}`);
    }
  }

  if (ctx.strategy) {
    // Extract YAML params
    const yamlMatch = ctx.strategy.match(/```yaml\n([\s\S]*?)```/);
    if (yamlMatch) parts.push(`STRATEGY PARAMS:\n${yamlMatch[1].trim()}`);
  }

  return parts.length > 0
    ? `\n=== VAULT INTELLIGENCE (from Obsidian Brain) ===\n${parts.join("\n")}\n=== END VAULT ===\n`
    : "";
}
