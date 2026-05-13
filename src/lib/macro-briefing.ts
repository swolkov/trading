import Anthropic from "@anthropic-ai/sdk";
import { getCrossAssetSignals } from "./cross-asset";
import { detectMarketRegime } from "./market-regime";
import { getNews } from "./alpaca";
import { prisma } from "./db";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

// Cache briefing for 2 hours — don't re-run on every agent cycle
let cachedBriefing: { text: string; timestamp: number } | null = null;
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

export interface MacroBriefing {
  summary: string;
  bias: "risk_on" | "risk_off" | "neutral";
  sectorFavors: string[];
  sectorAvoids: string[];
  keyRisks: string[];
  tradingRules: string[];
  keyEvents?: string[];
}

export async function generateMacroBriefing(): Promise<MacroBriefing> {
  // Return cache if fresh
  if (cachedBriefing && Date.now() - cachedBriefing.timestamp < CACHE_TTL) {
    return JSON.parse(cachedBriefing.text);
  }

  const [regime, crossAsset, marketNews] = await Promise.all([
    detectMarketRegime().catch(() => null),
    getCrossAssetSignals().catch(() => null),
    getNews(["SPY", "QQQ"], 10).catch(() => []),
  ]);

  // Get recent agent performance
  const recentTrades = await prisma.autoTradeLog.findMany({
    where: { pnl: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const wins = recentTrades.filter((t) => (t.pnl || 0) > 0).length;
  const losses = recentTrades.filter((t) => (t.pnl || 0) < 0).length;
  const totalPnl = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);

  const newsText = marketNews.map((n) => `- ${n.headline}`).join("\n");

  const prompt = `You are the HEAD MACRO STRATEGIST at a $100M trading desk. Your morning briefing sets the tone for ALL trades today.

MARKET DATA:
${regime ? `Regime: ${regime.regime.toUpperCase()} | SPY 1M: ${(regime.spy1mReturn * 100).toFixed(1)}% | Volatility: ${regime.volatility.toFixed(0)} | ${regime.recommendation}` : "Regime data unavailable"}
${crossAsset ? `Cross-asset: ${crossAsset.summary}` : ""}

RECENT MARKET NEWS:
${newsText || "No major news"}

OUR DESK PERFORMANCE (last 20 trades):
Wins: ${wins} | Losses: ${losses} | Net P&L: $${totalPnl.toFixed(0)}
${wins + losses > 0 ? `Win rate: ${((wins / (wins + losses)) * 100).toFixed(0)}%` : "No closed trades yet"}

Provide a CONCISE morning briefing in this JSON format (no markdown, raw JSON):
{
  "summary": "<3-4 sentence macro outlook for today. What's driving markets? What should we watch?>",
  "bias": "<risk_on|risk_off|neutral>",
  "sectorFavors": ["<sector1>", "<sector2>"],
  "sectorAvoids": ["<sector1>", "<sector2>"],
  "keyRisks": ["<risk1>", "<risk2>"],
  "tradingRules": ["<rule1 — specific actionable instruction for today>", "<rule2>", "<rule3>"]
}

The tradingRules should be SPECIFIC: e.g. "Sell premium on tech names — IV elevated", "Avoid financials — rate uncertainty", "Buy dips in energy — oil momentum strong". NOT generic advice.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const briefing = JSON.parse(text.trim());

    cachedBriefing = { text: JSON.stringify(briefing), timestamp: Date.now() };
    return briefing;
  } catch {
    return {
      summary: "Unable to generate macro briefing. Trade with caution.",
      bias: "neutral",
      sectorFavors: [],
      sectorAvoids: [],
      keyRisks: ["Briefing generation failed"],
      tradingRules: ["Use spreads for defined risk", "Reduce position sizes"],
    };
  }
}
