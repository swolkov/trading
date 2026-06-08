import { prisma } from "./db";
import { emitEventSafe, type EventPayload } from "./event-bus";

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

  // Emit trade event to event bus
  const isEntry = trade.exitPrice == null;
  const isStopLoss = trade.exitReason === "stop_loss";
  const isTarget = trade.exitReason === "target" || trade.exitReason === "target_hit";
  const mode = agentName.includes("live") ? "live" as const : "demo" as const;

  const eventPayload: EventPayload = {
    instrument: trade.instrument,
    direction: trade.direction,
    contracts: trade.contracts,
    price: isEntry ? trade.entryPrice : trade.exitPrice,
    pnl: trade.pnlDollars,
    rMultiple: trade.rMultiple,
    conviction: trade.conviction,
    setupType: trade.setupType,
    mode,
    tradeId: trade.tradeId,
    relatedFile: journalPath,
  };

  if (isEntry) {
    emitEventSafe("trade.entry", agentName, eventPayload);
  } else if (isStopLoss) {
    emitEventSafe("trade.stop_loss", agentName, eventPayload);
  } else if (isTarget) {
    emitEventSafe("trade.target_hit", agentName, eventPayload);
  } else {
    emitEventSafe("trade.exit", agentName, eventPayload);
  }
}

// ============ DECISION LOGGING ============

export async function logDecision(
  agentName: string,
  type: "ENTRY" | "EXIT" | "SKIP" | "ADJUSTMENT" | "PAPER",
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

  // Emit skip events to event bus (entries/exits already emitted from logTradeToJournal)
  if (type === "SKIP") {
    emitEventSafe("trade.skip", agentName, {
      instrument,
      confidence,
      reason: rationale,
      mode: agentName.includes("live") ? "live" : "demo",
    });
  }
}

// ============ OBSERVATION LOGGING ============

export async function logObservation(agentName: string, observation: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const entry = `- [${today}] [${agentName}] ${observation}`;
  await vaultAppend("Lessons/raw-observations.md", entry, agentName);
}

// ============ JARVIS LIVE FEED ============
// Real-time engine activity log in Obsidian — appends entries, trims to last 50

const LIVE_FEED_PATH = "Brain/JARVIS-live-feed.md";
const MAX_FEED_ENTRIES = 50;

export async function appendLiveFeed(
  agentName: string,
  type: "scan" | "setup" | "trade" | "exit" | "skip" | "cooldown" | "alert",
  message: string,
): Promise<void> {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "America/New_York" });
  const icons: Record<string, string> = {
    scan: "~",
    setup: ">>",
    trade: "$$",
    exit: "<<",
    skip: "--",
    cooldown: "!!",
    alert: "**",
  };
  const icon = icons[type] || "--";
  const entry = `- \`${timeStr}\` \`${icon}\` ${message}`;

  const existing = await vaultRead(LIVE_FEED_PATH);
  if (existing) {
    // Split into header and entries
    const lines = existing.split("\n");
    const headerEndIdx = lines.findIndex((l, i) => i > 0 && l.startsWith("- `"));
    const header = headerEndIdx > 0 ? lines.slice(0, headerEndIdx).join("\n") : "";
    const entries = lines.filter((l) => l.startsWith("- `"));

    // Prepend new entry, trim to max
    const updated = [entry, ...entries].slice(0, MAX_FEED_ENTRIES);
    const content = `${header}\n${updated.join("\n")}\n`;
    await vaultWrite(LIVE_FEED_PATH, content, agentName);
  } else {
    // Create fresh feed
    const header = `---
aliases: [Live Feed, Engine Log]
tags: [jarvis, live-feed]
---

# JARVIS Live Feed

> [!live] REAL-TIME ENGINE ACTIVITY
> Auto-updated by trading engines. Most recent first.

`;
    await vaultWrite(LIVE_FEED_PATH, header + entry + "\n", agentName);
  }
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

  // Emit regime change event
  emitEventSafe("regime.changed", "research-agent", {
    toRegime: regime.toUpperCase(),
    confidence: 70,
    message: `Regime updated: ${regime.toUpperCase()} | Trend: ${details.trend || "unknown"}`,
  });
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

// ============ DAILY BALANCES PARSER ============
// Parses Performance/daily-balances.md for true P&L (Tradovate source of truth)

interface DailyBalanceEntry {
  date: string;
  sod: number | null;
  eod: number | null;
  dayPnl: number | null;
}

async function parseDailyBalances(): Promise<{
  startingCapital: number;
  entries: DailyBalanceEntry[];
  cumulative: { date: string; pnl: number }[];
  latestBalance: number | null;
  totalPnl: number | null;
}> {
  const doc = await vaultRead("Performance/daily-balances.md");
  if (!doc) return { startingCapital: 50000, entries: [], cumulative: [], latestBalance: null, totalPnl: null };

  const capMatch = doc.match(/starting_capital:\s*(\d+)/);
  const startingCapital = capMatch ? parseInt(capMatch[1]) : 50000;

  const entries: DailyBalanceEntry[] = [];
  // Allow inline comments (# ...) after values and decimal balances
  const dailyRegex = /(\d{4}-\d{2}-\d{2}):\s*\n\s*sod:\s*(\d+(?:\.\d+)?|null)[^\n]*\n\s*eod:\s*(\d+(?:\.\d+)?|null)[^\n]*\n\s*day_pnl:\s*([+-]?\d+|null)/g;
  let match;
  while ((match = dailyRegex.exec(doc)) !== null) {
    entries.push({
      date: match[1],
      sod: match[2] === "null" ? null : parseFloat(match[2]),
      eod: match[3] === "null" ? null : parseFloat(match[3]),
      dayPnl: match[4] === "null" ? null : parseInt(match[4]),
    });
  }

  const cumulative: { date: string; pnl: number }[] = [];
  const cumulSection = doc.match(/## Cumulative P&L\s*```yaml\s*([\s\S]*?)```/);
  if (cumulSection) {
    const cumulRegex = /(\d{4}-\d{2}-\d{2}):\s*([+\-]?\d+)/g;
    while ((match = cumulRegex.exec(cumulSection[1])) !== null) {
      cumulative.push({ date: match[1], pnl: parseInt(match[2]) });
    }
  }

  let latestBalance: number | null = null;
  let totalPnl: number | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.eod != null) { latestBalance = e.eod; break; }
    if (e.sod != null) { latestBalance = e.sod; break; }
  }
  if (latestBalance != null) totalPnl = latestBalance - startingCapital;
  if (cumulative.length > 0) {
    const lastCumul = cumulative[cumulative.length - 1];
    if (lastCumul.pnl !== null) totalPnl = lastCumul.pnl;
  }

  return { startingCapital, entries, cumulative, latestBalance, totalPnl };
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
  // Get all closed trades from DB (reliable for counts, win/loss, timing — NOT for dollar P&L totals)
  // EXCLUDE May 13, 2026: Railway infrastructure outage prevented trade closure (not a strategy failure)
  const excludeDate = new Date("2026-05-13T00:00:00");
  const excludeEnd = new Date("2026-05-14T00:00:00");
  const allTrades = (await prisma.autoTradeLog.findMany({
    where: { pnl: { not: null } },
    orderBy: { createdAt: "desc" },
  })).filter((t) => t.createdAt < excludeDate || t.createdAt >= excludeEnd);

  const winners = allTrades.filter((t) => (t.pnl || 0) > 0);
  const losers = allTrades.filter((t) => (t.pnl || 0) <= 0);
  const totalTrades = allTrades.length;
  const winRate = totalTrades > 0 ? winners.length / totalTrades : 0;
  const grossProfit = winners.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const dbTotalPnl = allTrades.reduce((s, t) => s + (t.pnl || 0), 0);

  // TRUE P&L: Read from daily-balances.md (Tradovate balance deltas)
  const balances = await parseDailyBalances();

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

  // Per-instrument breakdown (e.g. MES, MNQ, MGC)
  const instrumentGroups: Record<string, typeof allTrades> = {};
  for (const t of futuresTrades) {
    const instrument = t.symbol.replace("FUT:", "");
    if (!instrumentGroups[instrument]) instrumentGroups[instrument] = [];
    instrumentGroups[instrument].push(t);
  }
  const instrumentStats: Record<string, ReturnType<typeof calcStats>> = {};
  for (const [inst, trades] of Object.entries(instrumentGroups)) {
    instrumentStats[inst] = calcStats(trades);
  }

  // Weekly stats (current week Mon-Sun)
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const weekTrades = allTrades.filter((t) => t.createdAt >= monday);
  const weekStats = calcStats(weekTrades);
  const weekWins = weekTrades.filter((t) => (t.pnl || 0) > 0).length;
  const weekLosses = weekTrades.filter((t) => (t.pnl || 0) <= 0).length;
  const weekByInst: Record<string, number> = {};
  for (const t of weekTrades) {
    const inst = t.symbol.replace("FUT:", "");
    weekByInst[inst] = (weekByInst[inst] || 0) + (t.pnl || 0);
  }
  const bestWeekInst = Object.entries(weekByInst).sort((a, b) => b[1] - a[1])[0];

  // Time-of-day analysis (DST-aware: converts to America/New_York)
  // Buckets match the engine's session names for correct vault-gate alignment.
  // IMPORTANT: "last_30_min" = 3:30-4:00 PM ET (real RTH close); "after_hours" = 4:00 PM+ ETH session.
  // Previous version used raw UTC hours which placed ETH trades (4 PM+) into "last_30_min" — now corrected.
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const hourBuckets: Record<string, { trades: number; wins: number }> = {};
  for (const t of allTrades) {
    const parts = etFormatter.formatToParts(t.createdAt);
    const etH = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0")
              + parseInt(parts.find((p) => p.type === "minute")?.value ?? "0") / 60;
    let bucket = "other";
    if (etH >= 9.5 && etH < 10) bucket = "first_30_min";      // 9:30-10:00 AM ET (open)
    else if (etH >= 10 && etH < 12) bucket = "mid_morning";    // 10:00 AM - 12:00 PM ET
    else if (etH >= 12 && etH < 14) bucket = "midday";         // 12:00 PM - 2:00 PM ET
    else if (etH >= 14 && etH < 15.5) bucket = "afternoon";    // 2:00 PM - 3:30 PM ET
    else if (etH >= 15.5 && etH < 16) bucket = "last_30_min";  // 3:30-4:00 PM ET (real last 30 min of RTH)
    else bucket = "after_hours";                                // 4:00 PM+ and pre-market (ETH session)
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

  // Build equity curve from daily-balances.md (preserves history)
  const equityCurveLines = balances.entries
    .filter((e) => e.sod != null || e.eod != null)
    .map((e) => {
      const balance = e.eod ?? e.sod!;
      const pnl = balance - balances.startingCapital;
      return `${e.date},${balance},${pnl}`;
    });

  // ── Fund pitch metrics: Sharpe ratio, peak-to-trough drawdown, monthly P&L ──
  const equityPoints = balances.entries.filter((e) => e.eod != null || e.sod != null);
  const dailyReturns: number[] = [];
  let peakBalance = balances.startingCapital;
  let peakDate = "";
  let maxDrawdownPct = 0;

  for (let i = 1; i < equityPoints.length; i++) {
    const prev = equityPoints[i - 1].eod ?? equityPoints[i - 1].sod!;
    const curr = equityPoints[i].eod ?? equityPoints[i].sod!;
    if (prev > 0) dailyReturns.push((curr - prev) / prev);
    if (curr > peakBalance) { peakBalance = curr; peakDate = equityPoints[i].date; }
    const dd = peakBalance > 0 ? (peakBalance - curr) / peakBalance * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  let sharpeRatio = 0;
  if (dailyReturns.length >= 5) {
    const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / dailyReturns.length;
    const stdDev = Math.sqrt(variance);
    sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;
  }

  // Monthly P&L from balance history
  const monthlyPnl: Record<string, { startBalance: number; endBalance: number; pnl: number; pnlPct: number }> = {};
  for (const e of equityPoints) {
    const month = e.date.slice(0, 7);
    const bal = e.eod ?? e.sod!;
    if (!monthlyPnl[month]) monthlyPnl[month] = { startBalance: bal, endBalance: bal, pnl: 0, pnlPct: 0 };
    monthlyPnl[month].endBalance = bal;
  }
  for (const data of Object.values(monthlyPnl)) {
    data.pnl = data.endBalance - data.startBalance;
    data.pnlPct = data.startBalance > 0 ? (data.pnl / data.startBalance) * 100 : 0;
  }

  // Format week date range
  const weekEnd = new Date(monday);
  weekEnd.setDate(monday.getDate() + 6);
  const weekLabel = `${monday.toISOString().slice(5, 10)} — ${weekEnd.toISOString().slice(5, 10)}`;

  // Update Performance/statistics.md
  const today = new Date().toISOString().slice(0, 10);
  const statsContent = `---
last_updated: "${today}"
updated_by: "synthesis-agent"
---

# Performance Statistics

> **SOURCE OF TRUTH**: Total P&L from Tradovate balance deltas in daily-balances.md.
> DB trade stats (win rate, counts) are reliable. DB dollar P&L totals are approximate.

## Lifetime Stats (Tradovate Balance — SOURCE OF TRUTH)
\`\`\`yaml
starting_capital: ${balances.startingCapital}
total_pnl: ${balances.totalPnl ?? "null  # Check daily-balances.md"}
last_known_balance: ${balances.latestBalance ?? "null  # Check dashboard"}
\`\`\`

## Trade Stats (from DB — counts/rates reliable, dollar amounts approximate)
\`\`\`yaml
total_trades: ${totalTrades}
win_rate: ${(winRate * 100).toFixed(1)}
profit_factor: ${profitFactor.toFixed(2)}
db_total_pnl: ${dbTotalPnl.toFixed(2)}  # APPROXIMATE — do not use for decisions
\`\`\`

## By Strategy
\`\`\`yaml
futures:
  trades: ${futuresStats.trades}
  win_rate: ${(futuresStats.winRate * 100).toFixed(1)}
  db_total_pnl: ${futuresStats.totalPnl.toFixed(2)}  # approximate

options:
  trades: ${optionsStats.trades}
  win_rate: ${(optionsStats.winRate * 100).toFixed(1)}
  db_total_pnl: ${optionsStats.totalPnl.toFixed(2)}  # approximate

stocks:
  trades: ${stockStats.trades}
  win_rate: ${(stockStats.winRate * 100).toFixed(1)}
  db_total_pnl: ${stockStats.totalPnl.toFixed(2)}  # approximate
\`\`\`

## By Instrument
\`\`\`yaml
${Object.entries(instrumentStats).sort((a, b) => b[1].trades - a[1].trades).map(([inst, s]) => `${inst}:
  trades: ${s.trades}
  win_rate: ${(s.winRate * 100).toFixed(1)}
  avg_pnl: ${s.avgPnl.toFixed(2)}
  db_total_pnl: ${s.totalPnl.toFixed(2)}`).join("\n\n")}
\`\`\`

## This Week (${weekLabel})
\`\`\`yaml
trades: ${weekStats.trades}
wins: ${weekWins}
losses: ${weekLosses}
db_pnl: ${weekStats.totalPnl.toFixed(2)}  # approximate
${bestWeekInst ? `best_instrument: ${bestWeekInst[0]} ($${bestWeekInst[1].toFixed(0)})` : "best_instrument: null"}
\`\`\`

## By Conviction/Score Level
\`\`\`yaml
${Object.entries(scoreGroups).map(([k, v]) => `conviction_${k}: { trades: ${v.trades}, win_rate: ${v.trades > 0 ? ((v.wins / v.trades) * 100).toFixed(1) : 0} }`).join("\n")}
\`\`\`

## By Time of Day
\`\`\`yaml
${Object.entries(hourBuckets).map(([k, v]) => `${k}: { trades: ${v.trades}, win_rate: ${v.trades > 0 ? ((v.wins / v.trades) * 100).toFixed(1) : 0} }`).join("\n")}
\`\`\`

## Fund Pitch Metrics
\`\`\`yaml
sharpe_ratio: ${sharpeRatio.toFixed(2)}  # annualized from ${dailyReturns.length} daily balance deltas
max_drawdown_peak_to_trough: ${maxDrawdownPct.toFixed(1)}%  # from balance history (source of truth)
peak_balance: ${peakBalance.toFixed(0)}
peak_date: ${peakDate || "n/a"}
note: "Fund pitch targets: Sharpe >1.0, max drawdown <15% peak-to-trough, 6+ months track record"
\`\`\`

## Monthly Returns
\`\`\`yaml
${Object.entries(monthlyPnl).map(([m, d]) => `${m}: { pnl: ${d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(0)}, return_pct: ${d.pnlPct >= 0 ? "+" : ""}${d.pnlPct.toFixed(1)}%, start: ${d.startBalance.toFixed(0)}, end: ${d.endBalance.toFixed(0)} }`).join("\n") || "insufficient_data: true"}
\`\`\`

## Equity Curve (from Tradovate daily balances)
\`\`\`csv
date,balance,cumulative_pnl
${equityCurveLines.length > 0 ? equityCurveLines.join("\n") : `${today},${balances.latestBalance ?? "null"},${balances.totalPnl ?? "null"}`}
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

  // Lesson: Per-instrument insights
  for (const [inst, stats] of Object.entries(instrumentStats)) {
    if (stats.trades >= 10) {
      if (stats.winRate > 0.5) {
        lessons.push(`${inst} is your best futures instrument (${(stats.winRate * 100).toFixed(0)}% WR over ${stats.trades} trades) — favor it.`);
        lessonsExtracted++;
      } else if (stats.winRate < 0.25) {
        antiPatterns.push(`${inst} has only ${(stats.winRate * 100).toFixed(0)}% win rate over ${stats.trades} trades — reduce size or avoid.`);
        antiPatternsFound++;
      }
    }
  }

  // Update active lessons (only if we have enough data)
  // IMPORTANT: Preserve manually-curated sections. Only update the "## Synthesis Insights" section.
  // Manual lessons (L001-L006) and anti-patterns (AP001-AP006) from engine-sync are the baseline.
  // Synthesis appends data-driven insights below them — never overwrites the manual entries.
  if (totalTrades >= 10 && (lessonsExtracted > 0 || antiPatternsFound > 0)) {
    // Read existing lessons file to preserve manual content
    let existingLessons = "";
    try {
      existingLessons = (await vaultRead("Lessons/active-lessons.md")) ?? "";
    } catch { /* file may not exist yet */ }

    // If file has manual content (engine-sync), preserve it and append synthesis section
    const hasManualContent = existingLessons.includes("updated_by: \"engine-sync\"") || existingLessons.includes("updated_by: \"manual\"");

    if (hasManualContent) {
      // Strip any existing synthesis section and append fresh one
      const synthHeader = "## Synthesis Data Insights";
      const manualPart = existingLessons.includes(synthHeader)
        ? existingLessons.slice(0, existingLessons.indexOf(synthHeader)).trimEnd()
        : existingLessons.trimEnd();

      const synthSection = `

${synthHeader}
> Auto-generated from ${totalTrades} trades (excl. May 13). Updated ${today}.

${lessons.length > 0 ? lessons.map((l, i) => `- **DATA-L${i + 1}**: ${l}`).join("\n") : "_No new data-driven lessons._"}

${antiPatterns.length > 0 ? antiPatterns.map((ap, i) => `- **DATA-AP${i + 1}**: ${ap}`).join("\n") : "_No new data-driven anti-patterns._"}
`;
      await vaultWrite("Lessons/active-lessons.md", manualPart + synthSection, "synthesis-agent");
    } else {
      // No manual content — synthesis owns the file (backward compatible)
      const lessonsContent = `---
last_updated: "${today}"
updated_by: "synthesis-agent"
total_lessons: ${lessonsExtracted + antiPatternsFound}
---

# Active Lessons

> Auto-generated by synthesis agent from ${totalTrades} closed trades (excl. May 13).
> Trading agents MUST read this file before every session.

## Lessons (Ranked by Impact)

${lessons.length > 0 ? lessons.map((l, i) => `### L${String(i + 1).padStart(3, "0")} — ${l.split(" — ")[0] || "Pattern"}\n- **LESSON**: ${l}\n- **Confidence**: ${totalTrades >= 50 ? "HIGH" : totalTrades >= 20 ? "MEDIUM" : "LOW"} (${totalTrades} trade sample)\n- **Date Added**: ${today}\n`).join("\n") : "_Insufficient data for lessons. Need more trades._\n"}

## Anti-Patterns (Avoid These)

${antiPatterns.length > 0 ? antiPatterns.map((ap, i) => `### AP${String(i + 1).padStart(3, "0")}\n- **PATTERN**: ${ap}\n- **Confidence**: ${totalTrades >= 50 ? "HIGH" : totalTrades >= 20 ? "MEDIUM" : "LOW"}\n- **Date Added**: ${today}\n`).join("\n") : "_No anti-patterns identified yet._\n"}
`;
      await vaultWrite("Lessons/active-lessons.md", lessonsContent, "synthesis-agent");
    }

    // Anti-patterns file: same logic — preserve manual, append synthesis
    if (antiPatterns.length > 0) {
      let existingAP = "";
      try {
        existingAP = (await vaultRead("Rules/anti-patterns.md")) ?? "";
      } catch { /* file may not exist */ }

      const hasManualAP = existingAP.includes("updated_by: \"engine-sync\"") || existingAP.includes("updated_by: \"manual\"");

      if (hasManualAP) {
        const synthAPHeader = "## Synthesis-Detected Patterns";
        const manualAPPart = existingAP.includes(synthAPHeader)
          ? existingAP.slice(0, existingAP.indexOf(synthAPHeader)).trimEnd()
          : existingAP.trimEnd();

        const synthAPSection = `

${synthAPHeader}
> Auto-detected from ${totalTrades} trades (excl. May 13). Updated ${today}.

${antiPatterns.map((ap, i) => `- **DATA-AP${i + 1}**: ${ap}`).join("\n")}
`;
        await vaultWrite("Rules/anti-patterns.md", manualAPPart + synthAPSection, "synthesis-agent");
      } else {
        const antiPatternsContent = `---
last_updated: "${today}"
updated_by: "synthesis-agent"
total_patterns: ${antiPatternsFound}
---

# Anti-Patterns Database

> Auto-generated by synthesis agent from ${totalTrades} closed trades (excl. May 13).
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
  }

  // Update strategy files with per-instrument performance
  try {
    const futuresStrategy = await vaultRead("Strategies/futures-scalping.md");
    if (futuresStrategy && Object.keys(instrumentStats).length > 0) {
      const perfTable = Object.entries(instrumentStats)
        .sort((a, b) => b[1].trades - a[1].trades)
        .map(([inst, s]) => `| ${inst} | ${s.trades} | ${(s.winRate * 100).toFixed(1)}% | ${s.avgPnl.toFixed(2)} | ${s.totalPnl.toFixed(2)} |`)
        .join("\n");
      const futuresLessons = [...lessons, ...antiPatterns].filter((l) =>
        l.toLowerCase().includes("futures") || Object.keys(instrumentStats).some((inst) => l.includes(inst)),
      );

      let updated = futuresStrategy;
      const lessonsText = futuresLessons.length > 0
        ? futuresLessons.map((l, i) => `${i + 1}. ${l}`).join("\n") + `\n\n_Last updated: ${today}_`
        : `_No instrument-specific lessons yet (need more data)._`;
      updated = updated.replace(
        /## Lessons Learned\n[\s\S]*?(?=\n## |$)/,
        `## Lessons Learned\n${lessonsText}\n\n`,
      );
      updated = updated.replace(
        /## Performance by (?:Setup Type|Instrument)\n[\s\S]*?(?=\n## |$)/,
        `## Performance by Instrument\n| Instrument | Trades | Win Rate | Avg P&L | Total P&L |\n|------------|--------|----------|---------|----------|\n${perfTable}\n\n_Last updated: ${today} — DB P&L values are approximate_\n\n`,
      );
      if (updated !== futuresStrategy) {
        await vaultWrite("Strategies/futures-scalping.md", updated, "synthesis-agent");
      }
    }
  } catch { /* strategy update optional */ }

  // Emit synthesis completed event
  emitEventSafe("synthesis.completed", "synthesis-agent", {
    totalTrades,
    winRate,
    lessonsExtracted,
    antiPatternsFound,
    message: `Synthesis: ${totalTrades} trades, ${(winRate * 100).toFixed(0)}% WR, PF ${profitFactor.toFixed(2)}`,
  });

  return { totalTrades, winRate, profitFactor, lessonsExtracted, antiPatternsFound };
}

// ============ J.A.R.V.I.S. — OBSIDIAN INTELLIGENCE SYSTEM ============
// Generates Brain/JARVIS.md (dashboard) and Brain/JARVIS-daily-brief.md (pre-session)
// Called by agents after key events: trade entry/exit, premarket, synthesis, regime change

interface JARVISState {
  // Vault docs
  regime: string | null;
  volatility: string | null;
  macro: string | null;
  cryptoRegime: string | null;
  activeLessons: string | null;
  antiPatterns: string | null;
  riskRules: string | null;
  futuresStrategy: string | null;
  statistics: string | null;
  dailyBalances: string | null;
  // DB state
  agentHeartbeats: Record<string, string>;
  todayTrades: { action: string; symbol: string; qty: number; pnl: number | null; reason: string | null; createdAt: Date }[];
  recentJournals: string[];
}

async function gatherJARVISState(): Promise<JARVISState> {
  const [vaultDocs, configs, todayTrades, journals] = await Promise.all([
    vaultReadMultiple([
      "Brain/market-regime.md",
      "Brain/volatility-environment.md",
      "Brain/macro-outlook.md",
      "Brain/crypto-regime.md",
      "Lessons/active-lessons.md",
      "Rules/anti-patterns.md",
      "Rules/risk-management.md",
      "Strategies/futures-scalping.md",
      "Performance/statistics.md",
      "Performance/daily-balances.md",
    ]),
    prisma.agentConfig.findMany(),
    prisma.autoTradeLog.findMany({
      where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.vaultDocument.findMany({
      where: { path: { startsWith: "Journal/" }, NOT: { path: { contains: "_template" } } },
      orderBy: { updatedAt: "desc" },
      take: 3,
    }),
  ]);

  const configMap: Record<string, string> = {};
  for (const c of configs) configMap[c.key] = c.value;

  return {
    regime: vaultDocs["Brain/market-regime.md"] ?? null,
    volatility: vaultDocs["Brain/volatility-environment.md"] ?? null,
    macro: vaultDocs["Brain/macro-outlook.md"] ?? null,
    cryptoRegime: vaultDocs["Brain/crypto-regime.md"] ?? null,
    activeLessons: vaultDocs["Lessons/active-lessons.md"] ?? null,
    antiPatterns: vaultDocs["Rules/anti-patterns.md"] ?? null,
    riskRules: vaultDocs["Rules/risk-management.md"] ?? null,
    futuresStrategy: vaultDocs["Strategies/futures-scalping.md"] ?? null,
    statistics: vaultDocs["Performance/statistics.md"] ?? null,
    dailyBalances: vaultDocs["Performance/daily-balances.md"] ?? null,
    agentHeartbeats: configMap,
    todayTrades: todayTrades.map((t) => ({
      action: t.action,
      symbol: t.symbol,
      qty: t.qty || 0,
      pnl: t.pnl,
      reason: t.reason,
      createdAt: t.createdAt,
    })),
    recentJournals: journals.map((j) => j.content),
  };
}

// Helper: extract field from vault markdown
function jExtract(content: string | null, pattern: RegExp): string {
  if (!content) return "Unknown";
  const m = content.match(pattern);
  return m ? m[1].trim() : "Unknown";
}

// Helper: time ago from ISO string or JSON heartbeat
function jTimeAgo(raw: string | undefined): string {
  if (!raw) return "Never";
  let ts: number;
  try {
    const parsed = JSON.parse(raw);
    ts = new Date(parsed.timestamp).getTime();
  } catch {
    ts = new Date(raw).getTime();
  }
  if (isNaN(ts)) return "Unknown";
  const mins = (Date.now() - ts) / 60000;
  if (mins < 1) return "Just now";
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  if (mins < 1440) return `${(mins / 60).toFixed(0)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function jAgentHealth(raw: string | undefined, mode: string): { icon: string; status: string } {
  if (mode === "disabled" || mode === "placeholder") return { icon: "🔴", status: "OFF" };
  if (!raw) return { icon: "🔴", status: "OFFLINE" };
  let ts: number;
  try {
    const parsed = JSON.parse(raw);
    ts = new Date(parsed.timestamp).getTime();
  } catch {
    ts = new Date(raw).getTime();
  }
  if (isNaN(ts)) return { icon: "🔴", status: "OFFLINE" };
  const mins = (Date.now() - ts) / 60000;
  if (mins < 15) return { icon: "🟢", status: "ONLINE" };
  if (mins < 60) return { icon: "🟡", status: "STALE" };
  return { icon: "🔴", status: "OFFLINE" };
}

function jProgressBar(pct: number, width = 10): string {
  const filled = Math.round(Math.max(0, Math.min(1, pct)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// Helper: extract heartbeat detail from JSON
function jHeartbeatDetail(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const p = JSON.parse(raw);
    const parts: string[] = [];
    if (p.tickCount != null) parts.push(`${p.tickCount} ticks`);
    if (p.positions != null) parts.push(`${p.positions} pos`);
    if (p.dailyTrades != null) parts.push(`${p.dailyTrades} trades`);
    return parts.join(", ");
  } catch {
    return "";
  }
}

export async function updateJARVIS(triggeredBy: string): Promise<void> {
  const s = await gatherJARVISState();
  const now = new Date();
  const isoNow = now.toISOString();

  // Parse regime
  const regime = jExtract(s.regime, /\*\*Current\*\*:\s*`?(\w+)`?/);
  const trend = jExtract(s.regime, /\*\*Trend\*\*:\s*(.+)/);
  const vix = jExtract(s.regime, /VIX\*\*:\s*([\d.]+)/);
  const volRegime = jExtract(s.volatility, /\*\*Current\*\*:\s*`?(\w+)`?/);
  const cryptoRegime = jExtract(s.cryptoRegime, /\*\*Current\*\*:\s*`?(\w+)`?/);
  const regimeUpdated = jExtract(s.regime, /last_updated:\s*"?([^"\n]+)"?/);

  // Regime callout type
  const regimeCallout = regime === "BULL" || regime.includes("TREND") ? "success"
    : regime === "BEAR" ? "danger"
    : regime === "CHOPPY" ? "warning"
    : "info";

  // Today's P&L from trades — separated by mode (action prefix is the reliable tag)
  const closedTrades = s.todayTrades.filter((t) => t.pnl != null && !t.action.includes("skip"));
  const liveTrades = closedTrades.filter((t) => t.action.startsWith("live_"));
  const demoTrades = closedTrades.filter((t) => !t.action.startsWith("live_"));
  const livePnl = liveTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const demoPnl = demoTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const liveWins = liveTrades.filter((t) => (t.pnl || 0) > 0).length;
  const liveLosses = liveTrades.filter((t) => (t.pnl || 0) <= 0).length;
  const demoWins = demoTrades.filter((t) => (t.pnl || 0) > 0).length;
  const demoLosses = demoTrades.filter((t) => (t.pnl || 0) <= 0).length;
  const todayTotal = closedTrades.length;
  const liveTotal = liveWins + liveLosses;
  const demoTotal = demoWins + demoLosses;
  const liveWinRate = liveTotal > 0 ? liveWins / liveTotal : 0;
  const demoWinRate = demoTotal > 0 ? demoWins / demoTotal : 0;

  // Equity from daily balances
  const balanceMatch = s.dailyBalances?.match(/last_known_balance:\s*([\d.]+)/);
  const liveBalance = balanceMatch ? parseFloat(balanceMatch[1]) : null;

  // Drawdown state
  const drawdownRaw = s.agentHeartbeats.drawdown_state || s.agentHeartbeats.drawdown_state_live;
  let drawdownMode = "NORMAL";
  try {
    if (drawdownRaw) drawdownMode = JSON.parse(drawdownRaw).mode || "NORMAL";
  } catch {}

  // Agent fleet
  const hb = s.agentHeartbeats;
  const agents = [
    { name: "Futures (Live)", hbKey: "futures_engine_heartbeat_live", mode: "live" },
    { name: "Futures (Demo)", hbKey: "futures_engine_heartbeat_demo", mode: "demo" },
    { name: "Crypto", hbKey: "crypto_last_run", mode: hb.crypto_enabled || "disabled" },
    { name: "Stocks", hbKey: "stocks_last_run", mode: hb.stocks_enabled || "placeholder" },
    { name: "Watchdog", hbKey: "watchdog_last_run", mode: "auto" },
    { name: "Regime Scan", hbKey: "regime_transition_last_run", mode: "auto" },
    { name: "Premarket", hbKey: "premarket_last_run", mode: "auto" },
    { name: "Synthesis", hbKey: "synthesis_last_run", mode: "auto" },
    { name: "Orchestrator", hbKey: "orchestrator_last_run", mode: "auto" },
    { name: "Events", hbKey: "event_catalyst_last_run", mode: "auto" },
    { name: "Review", hbKey: "review_last_run", mode: "auto" },
  ];

  const fleetRows = agents.map((a) => {
    const { icon, status } = jAgentHealth(hb[a.hbKey], a.mode);
    const detail = jHeartbeatDetail(hb[a.hbKey]);
    return `| ${icon} ${a.name} | ${status} | ${jTimeAgo(hb[a.hbKey])} | ${a.mode} | ${detail} |`;
  });
  const aliveCount = agents.filter((a) => jAgentHealth(hb[a.hbKey], a.mode).status === "ONLINE").length;
  const enabledCount = agents.filter((a) => a.mode !== "disabled" && a.mode !== "placeholder").length;

  // Alerts
  const alerts: string[] = [];
  const regimeAge = regimeUpdated !== "Unknown" ? (Date.now() - new Date(regimeUpdated).getTime()) / 3600000 : 999;
  if (regimeAge > 12) alerts.push(`🟡 Regime data ${regimeAge > 24 ? Math.floor(regimeAge / 24) + "d" : Math.floor(regimeAge) + "h"} stale — update needed`);
  if (regime === "CHOPPY") alerts.push("🟡 Choppy market — A+ setups only for live");
  if (drawdownMode !== "NORMAL") alerts.push(`🔴 Drawdown protocol: ${drawdownMode}`);
  const staleAgents = agents.filter((a) => a.mode !== "disabled" && a.mode !== "placeholder" && jAgentHealth(hb[a.hbKey], a.mode).status !== "ONLINE");
  if (staleAgents.length > 0) alerts.push(`🟡 ${staleAgents.length} agent(s) stale/offline: ${staleAgents.map((a) => a.name).join(", ")}`);

  // Lessons (top 5)
  const lessonLines = s.activeLessons
    ?.split("\n")
    .filter((l) => l.match(/^\d+\.\s|^-\s\*\*L\d|^###\s*L\d/))
    .slice(0, 5)
    .map((l) => l.replace(/^[-\d.]+\s*/, "").replace(/^###\s*/, "").trim()) || [];

  // Anti-patterns
  const apLines = s.antiPatterns
    ?.split("\n")
    .filter((l) => l.match(/^\*\*AP\d|^###\s*AP\d|^-\s\*\*AP/))
    .slice(0, 5)
    .map((l) => l.replace(/^###\s*/, "").replace(/^-\s*/, "").trim()) || [];

  // Active positions from today's trades (entries without matching exits)
  const openEntries = s.todayTrades.filter((t) => t.pnl == null && !t.action.includes("skip"));

  const content = `---
aliases: [JARVIS, Command Center, Dashboard]
last_updated: "${isoNow}"
updated_by: "jarvis-system"
triggered_by: "${triggeredBy}"
tags: [jarvis, dashboard, system]
cssclasses: [jarvis]
---

# J.A.R.V.I.S.
> *Just A Rather Very Intelligent System — Trading Intelligence v2*

---

> [!regime] ${regime} REGIME — ${volRegime} Volatility
> **Trend** ${trend} · **VIX** ${vix} · **Crypto** ${cryptoRegime}
> *Updated ${jTimeAgo(regimeUpdated !== "Unknown" ? regimeUpdated : undefined)} by research-agent*

> [!trade] LIVE P&L: ${livePnl >= 0 ? "+" : ""}$${livePnl.toFixed(0)}
> ${liveTotal > 0 ? `${jProgressBar(liveWinRate)} **${(liveWinRate * 100).toFixed(0)}%** Win Rate · ${liveWins}W/${liveLosses}L` : "No trades today — waiting for setups"}
> ${liveBalance ? `Balance: **$${liveBalance.toFixed(0)}**` : ""}${drawdownMode !== "NORMAL" ? ` · **${drawdownMode}**` : ""}

> [!${demoPnl >= 0 ? "success" : "warning"}] DEMO P&L: ${demoPnl >= 0 ? "+" : ""}$${demoPnl.toFixed(0)}
> ${demoTotal > 0 ? `${jProgressBar(demoWinRate)} **${(demoWinRate * 100).toFixed(0)}%** Win Rate · ${demoWins}W/${demoLosses}L` : "No trades today"}

## Agent Fleet (${aliveCount}/${enabledCount} online)
| Agent | Status | Last Active | Mode | Detail |
|-------|--------|-------------|------|--------|
${fleetRows.join("\n")}

${alerts.length > 0 ? `> [!warning] ALERTS (${alerts.length})
${alerts.map((a) => `> - ${a}`).join("\n")}` : "> [!success] ALL CLEAR\n> No active alerts"}

## Active Positions
${openEntries.length > 0
    ? openEntries.map((t) => {
        const mode = t.action.startsWith("live_") ? "LIVE" : "DEMO";
        return `- \`${mode}\` **${t.symbol.replace("FUT:", "")}** ${t.action.includes("long") ? "LONG" : "SHORT"} x${t.qty} — ${(t.reason || "").slice(0, 60)}`;
      }).join("\n")
    : "*No open positions*"}

## Top Lessons
${lessonLines.length > 0 ? lessonLines.map((l, i) => `${i + 1}. ${l}`).join("\n") : "*No active lessons*"}

## Anti-Patterns Active
${apLines.length > 0 ? `> [!danger] AVOID
${apLines.map((ap) => `> - ${ap}`).join("\n")}` : "*No active anti-patterns*"}

## Quick Links
- [[market-regime|Regime]] · [[volatility-environment|Vol]] · [[macro-outlook|Macro]] · [[crypto-regime|Crypto]]
- [[futures-scalping|Futures Strategy]] · [[crypto-day-trading|Crypto Strategy]]
- [[risk-management|Risk Rules]] · [[active-lessons|All Lessons]] · [[anti-patterns|Anti-Patterns]]
- [[statistics|Performance]] · [[daily-balances|Equity Curve]]
- [[orchestrator|Event Bus]] · [[orchestrator-agent|Orchestrator Config]]

## System Architecture
\`\`\`mermaid
graph TD
    J[🧠 JARVIS] --> B[Brain]
    J --> AF[Agent Fleet]
    J --> ORC[⚡ Orchestrator]
    B --> MR[Market Regime]
    B --> VE[Volatility]
    B --> MO[Macro Outlook]
    AF --> FD[Futures Demo 24/7]
    AF --> FL[Futures Live RTH]
    AF --> CR[Crypto 24/7]
    AF --> RE[Research]
    AF --> SY[Synthesis]
    FD --> EB[Event Bus]
    FL --> EB
    CR --> EB
    EB --> ORC
    ORC --> SC[Session Context]
    SC --> AF
    FD --> JN[Journal]
    FL --> JN
    CR --> JN
    JN --> SY
    SY --> LS[Lessons]
    SY --> ST[Statistics]
    LS --> AF
\`\`\`

## Live Engine Feed
![[JARVIS-live-feed#REAL-TIME ENGINE ACTIVITY]]

---
*Auto-updated by JARVIS · Triggered by: ${triggeredBy} · ${now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" })}*
`;

  await vaultWrite("Brain/JARVIS.md", content, "jarvis-system");
}

export async function generateDailyBrief(): Promise<void> {
  const s = await gatherJARVISState();
  const now = new Date();
  const isoNow = now.toISOString();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

  // Parse all the vault fields
  const regime = jExtract(s.regime, /\*\*Current\*\*:\s*`?(\w+)`?/);
  const vix = jExtract(s.regime, /VIX\*\*:\s*([\d.]+)/);
  const volRegime = jExtract(s.volatility, /\*\*Current\*\*:\s*`?(\w+)`?/);
  const cryptoRegime = jExtract(s.cryptoRegime, /\*\*Current\*\*:\s*`?(\w+)`?/);
  const macroSummary = jExtract(s.macro, /## Summary\n([\s\S]*?)(?=\n##|$)/);
  const macroBias = jExtract(s.macro, /## Bias:\s*(\w+)/);
  const tradingRules = s.macro?.match(/^- .+$/gm)?.slice(0, 5) || [];

  // Regime-specific playbook for futures
  const regimePlaybooks: Record<string, { setups: string; sizing: string; note: string }> = {
    BULL: { setups: "Trend continuation + breakout preferred", sizing: "Full size, 2-3 contracts", note: "Trade with the trend. Buy pullbacks." },
    BEAR: { setups: "Short breakdowns + mean reversion longs at extremes", sizing: "Reduced size, 1-2 contracts", note: "Short the rallies. Tighter stops." },
    CHOPPY: { setups: "A+ setups only or sit out", sizing: "1 contract max, wider stops", note: "Wait for breakout/breakdown to shift regime" },
    TRENDING: { setups: "Trend continuation + breakout", sizing: "Full size", note: "Follow the trend direction" },
  };
  const playbook = regimePlaybooks[regime] || regimePlaybooks.CHOPPY!;

  // Risk rules extract
  const maxRisk = jExtract(s.riskRules, /max_risk_per_trade_pct:\s*([\d.]+)/);
  const dailyLoss = jExtract(s.riskRules, /max_daily_loss_pct:\s*([\d.]+)/);
  const confThreshold = jExtract(s.riskRules, /confidence_threshold:\s*(\d+)/);
  const convictionGate = jExtract(s.riskRules, /conviction_gate:\s*"?([^"\n]+)"?/);
  const instruments = jExtract(s.riskRules, /instruments:\s*\[([^\]]+)\]/);
  const maxContracts = jExtract(s.riskRules, /max_contracts_per_trade:\s*(\d+)/);

  // Equity
  const balanceMatch = s.dailyBalances?.match(/last_known_balance:\s*([\d.]+)/);
  const liveBalance = balanceMatch ? parseFloat(balanceMatch[1]) : 1000;
  const riskDollar = (parseFloat(maxRisk) / 100 * liveBalance) || 80;
  const dailyLossDollar = (parseFloat(dailyLoss) / 100 * liveBalance) || 150;

  // Lessons
  const lessonLines = s.activeLessons
    ?.split("\n")
    .filter((l) => l.match(/^\d+\.\s|^-\s\*\*L\d|^###\s*L\d|^\*\*LESSON/))
    .slice(0, 6)
    .map((l) => l.replace(/^[-\d.]+\s*/, "").replace(/^###\s*/, "").replace(/^\*\*LESSON\*\*:\s*/, "").trim()) || [];

  // Anti-patterns
  const apEntries: string[] = [];
  if (s.antiPatterns) {
    const blocks = s.antiPatterns.split(/###\s*AP\d+/).filter((b) => b.trim());
    for (const block of blocks.slice(0, 5)) {
      const nameMatch = block.match(/—\s*(.+)/);
      const patternMatch = block.match(/\*\*(?:PATTERN|Pattern)\*\*:\s*(.+)/);
      const label = nameMatch?.[1] || patternMatch?.[1] || block.split("\n")[0]?.trim();
      if (label) apEntries.push(label.slice(0, 80));
    }
  }

  // Yesterday's review from most recent journal
  let yesterdayReview = "*No recent journal entries*";
  if (s.recentJournals.length > 0) {
    const journal = s.recentJournals[0];
    const tradeCount = (journal.match(/### Trade/g) || []).length;
    const pnlMatches = journal.match(/pnl_dollars:\s*([+-]?\d+(?:\.\d+)?)/g) || [];
    const totalPnl = pnlMatches.reduce((sum, m) => sum + parseFloat(m.replace("pnl_dollars: ", "")), 0);
    const dateMatch = journal.match(/date:\s*"?(\d{4}-\d{2}-\d{2})"?/);
    const wins = pnlMatches.filter((m) => parseFloat(m.replace("pnl_dollars: ", "")) > 0).length;
    const losses = pnlMatches.filter((m) => parseFloat(m.replace("pnl_dollars: ", "")) <= 0).length;
    yesterdayReview = `${dateMatch?.[1] || "Recent"}: ${tradeCount} trades, ${wins}W/${losses}L, net ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(0)} (DB approx)`;
  }

  // Crypto playbook
  const cryptoPlaybooks: Record<string, string> = {
    CRYPTO_BULL: "100% size, momentum + trend continuation",
    CRYPTO_BEAR: "50% size, mean reversion only, tight stops",
    CRYPTO_CHOPPY: "75% size, mean reversion + range plays",
    CRYPTO_EUPHORIA: "50% size, fade extremes, tight stops",
    CRYPTO_FEAR: "75% size, mean reversion + DCA, wide stops",
  };
  const cryptoPlay = cryptoPlaybooks[cryptoRegime] || cryptoPlaybooks.CRYPTO_CHOPPY || "Standard parameters";

  const content = `---
date: "${now.toISOString().slice(0, 10)}"
generated_by: "jarvis-premarket"
generated_at: "${isoNow}"
tags: [jarvis, daily-brief]
---

# JARVIS Daily Brief — ${dateStr}

> [!info] MARKET ENVIRONMENT
> **Regime:** ${regime} · **VIX:** ${vix} (${volRegime}) · **Crypto:** ${cryptoRegime}
> ${macroSummary !== "Unknown" ? macroSummary.slice(0, 150) : "No macro summary available"}

## Risk Rules Snapshot
> [!danger] HARD LIMITS
> - Max risk/trade: ${maxRisk !== "Unknown" ? (parseFloat(maxRisk) * 100).toFixed(0) : "8"}% ($${riskDollar.toFixed(0)}) · Daily loss limit: ${dailyLoss !== "Unknown" ? (parseFloat(dailyLoss) * 100).toFixed(0) : "15"}% ($${dailyLossDollar.toFixed(0)})
> - Live instruments: ${instruments !== "Unknown" ? instruments : "MES, MNQ"} ONLY · Max contracts: ${maxContracts}
> - Confidence: ≥${confThreshold !== "Unknown" ? confThreshold : "80"}% · Conviction: ${convictionGate !== "Unknown" ? convictionGate : "A+/A only"}

## Today's Playbook

### Futures (Live $${liveBalance.toFixed(0)})
> [!${regime === "BULL" ? "success" : regime === "CHOPPY" ? "warning" : "danger"}] ${regime} REGIME → ${regime === "CHOPPY" ? "Conservative" : regime === "BULL" ? "Aggressive" : "Defensive"} Mode
> - **Preferred setups:** ${playbook.setups}
> - **Sizing:** ${playbook.sizing}
> - **Session focus:** 9:45-11:30 + 2:00-3:30 ET
> - **Note:** ${playbook.note}

### Futures (Demo $50K — Professional Track Record)
> [!tip] 1% Risk — Same as Live (Fundable Track Record)
> - 55% confidence gate, all setup types active (trend continuation disabled)
> - Max 10 contracts; actual = 1% risk ÷ stop distance (~1-2 contracts typical)
> - ES/NQ/GC — full-size for realistic track record

### Crypto (Alpaca)
> - **Regime:** ${cryptoRegime} → ${cryptoPlay}
> - Max 3 concurrent, 6 trades/day

## Lessons to Apply Today
${lessonLines.length > 0 ? lessonLines.map((l, i) => `${i + 1}. ${l}`).join("\n") : "*No active lessons — check Lessons/active-lessons.md*"}

## Anti-Patterns — DO NOT
${apEntries.length > 0 ? apEntries.map((ap) => `- ❌ ${ap}`).join("\n") : "*No active anti-patterns*"}

## Macro Context
${macroSummary !== "Unknown" ? `> ${macroSummary.slice(0, 300)}` : "> No macro data available"}
${macroBias !== "Unknown" ? `> **Bias:** ${macroBias}` : ""}
${tradingRules.length > 0 ? `\n**Trading Rules:**\n${tradingRules.join("\n")}` : ""}

## Yesterday's Review
> ${yesterdayReview}

---
*Generated by JARVIS premarket synthesis · Valid for ${now.toISOString().slice(0, 10)} session*
`;

  await vaultWrite("Brain/JARVIS-daily-brief.md", content, "jarvis-premarket");
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
