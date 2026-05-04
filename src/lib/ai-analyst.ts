import Anthropic from "@anthropic-ai/sdk";
import { getCompanyProfile, getKeyStats, getEarnings, getAnalystRecommendations } from "./yahoo";
import { getSnapshot, getNews, getBars } from "./alpaca";
import { prisma } from "./db";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

interface AnalysisResult {
  score: number; // -100 to 100
  signal: string; // strong_buy, buy, hold, sell, strong_sell
  summary: string;
  thesis: string;
  risks: string[];
  catalysts: string[];
  priceTarget: number | null;
  confidence: number;
  keyMetrics: Record<string, string | number | null>;
  tradeIdea?: {
    action: string;
    entryPrice: number | null;
    targetPrice: number | null;
    stopLoss: number | null;
    reasoning: string;
    timeframe: string;
    riskReward: number | null;
  };
}

export async function analyzeStock(symbol: string): Promise<AnalysisResult> {
  // Gather all data in parallel
  const [profile, stats, earnings, analysts, news, bars] = await Promise.all([
    getCompanyProfile(symbol).catch(() => null),
    getKeyStats(symbol).catch(() => null),
    getEarnings(symbol).catch(() => null),
    getAnalystRecommendations(symbol).catch(() => []),
    getNews([symbol], 5).catch(() => []),
    getBars(symbol, "1Day", undefined, undefined).catch(() => []),
  ]);

  let snapshot = null;
  try {
    snapshot = await getSnapshot(symbol);
  } catch {
    // snapshot may not be available
  }

  const currentPrice = snapshot?.latestTrade?.p || snapshot?.latestQuote?.ap || 0;

  // Calculate technical indicators from bars
  const closePrices = bars.map((b) => b.c);
  const sma20 = closePrices.length >= 20
    ? closePrices.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;
  const sma50 = closePrices.length >= 50
    ? closePrices.slice(-50).reduce((a, b) => a + b, 0) / 50
    : null;
  const sma200 = closePrices.length >= 200
    ? closePrices.slice(-200).reduce((a, b) => a + b, 0) / 200
    : null;

  // RSI calculation
  let rsi = null;
  if (closePrices.length >= 15) {
    const changes = [];
    for (let i = closePrices.length - 15; i < closePrices.length; i++) {
      changes.push(closePrices[i] - closePrices[i - 1]);
    }
    const gains = changes.filter((c) => c > 0);
    const losses = changes.filter((c) => c < 0).map((c) => Math.abs(c));
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / 14 : 0;
    if (avgLoss > 0) {
      const rs = avgGain / avgLoss;
      rsi = 100 - 100 / (1 + rs);
    } else {
      rsi = 100;
    }
  }

  // Price change calculations
  const priceChange1d = bars.length >= 2
    ? ((bars[bars.length - 1].c - bars[bars.length - 2].c) / bars[bars.length - 2].c) * 100
    : null;
  const priceChange1w = bars.length >= 5
    ? ((bars[bars.length - 1].c - bars[bars.length - 5].c) / bars[bars.length - 5].c) * 100
    : null;
  const priceChange1m = bars.length >= 21
    ? ((bars[bars.length - 1].c - bars[bars.length - 21].c) / bars[bars.length - 21].c) * 100
    : null;
  const priceChange3m = bars.length >= 63
    ? ((bars[bars.length - 1].c - bars[bars.length - 63].c) / bars[bars.length - 63].c) * 100
    : null;

  // Build the analysis prompt
  const prompt = buildAnalysisPrompt({
    symbol,
    profile,
    stats,
    earnings,
    analysts,
    news,
    currentPrice,
    technicals: { sma20, sma50, sma200, rsi, priceChange1d, priceChange1w, priceChange1m, priceChange3m },
  });

  // Call Claude for analysis
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Parse the structured response
  const analysis = parseAnalysisResponse(text, currentPrice);

  // Store in database
  await prisma.researchReport.create({
    data: {
      symbol: symbol.toUpperCase(),
      name: profile?.name || symbol,
      sector: profile?.sector || "",
      score: analysis.score,
      signal: analysis.signal,
      summary: analysis.summary,
      thesis: analysis.thesis,
      keyMetrics: JSON.stringify(analysis.keyMetrics),
      risks: JSON.stringify(analysis.risks),
      catalysts: JSON.stringify(analysis.catalysts),
      priceTarget: analysis.priceTarget,
      currentPrice,
      confidence: analysis.confidence,
    },
  });

  // Store trade idea if generated
  if (analysis.tradeIdea && analysis.tradeIdea.action !== "hold") {
    await prisma.tradeIdea.create({
      data: {
        symbol: symbol.toUpperCase(),
        action: analysis.tradeIdea.action,
        entryPrice: analysis.tradeIdea.entryPrice,
        targetPrice: analysis.tradeIdea.targetPrice,
        stopLoss: analysis.tradeIdea.stopLoss,
        reasoning: analysis.tradeIdea.reasoning,
        timeframe: analysis.tradeIdea.timeframe,
        riskReward: analysis.tradeIdea.riskReward,
      },
    });
  }

  return analysis;
}

function buildAnalysisPrompt(data: {
  symbol: string;
  profile: Awaited<ReturnType<typeof getCompanyProfile>>;
  stats: Awaited<ReturnType<typeof getKeyStats>>;
  earnings: Awaited<ReturnType<typeof getEarnings>>;
  analysts: Awaited<ReturnType<typeof getAnalystRecommendations>>;
  news: Awaited<ReturnType<typeof getNews>>;
  currentPrice: number;
  technicals: {
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    rsi: number | null;
    priceChange1d: number | null;
    priceChange1w: number | null;
    priceChange1m: number | null;
    priceChange3m: number | null;
  };
}): string {
  const { symbol, profile, stats, earnings, analysts, news, currentPrice, technicals } = data;

  const newsText = news.map((n) => `- ${n.headline} (${n.source}, ${new Date(n.created_at).toLocaleDateString()})`).join("\n");

  const earningsText = earnings?.quarterly?.map((q) =>
    `Q: ${q.date} | Actual: $${q.actual?.toFixed(2) || 'N/A'} | Est: $${q.estimate?.toFixed(2) || 'N/A'} | Surprise: ${q.surprisePercent != null ? (q.surprisePercent * 100).toFixed(1) + '%' : 'N/A'}`
  ).join("\n") || "No earnings data";

  const analystText = analysts?.[0]
    ? `Strong Buy: ${analysts[0].strongBuy}, Buy: ${analysts[0].buy}, Hold: ${analysts[0].hold}, Sell: ${analysts[0].sell}, Strong Sell: ${analysts[0].strongSell}`
    : "No analyst data";

  return `You are an elite Wall Street equity research analyst and quantitative trader. Analyze this stock with the goal of finding profitable trading opportunities. Be brutally honest — if it's a bad investment, say so. If it's a great opportunity, explain why with conviction.

## Stock: ${symbol} — ${profile?.name || 'Unknown'}
Sector: ${profile?.sector || 'N/A'} | Industry: ${profile?.industry || 'N/A'}
Current Price: $${currentPrice.toFixed(2)}

## Fundamental Data
- Market Cap: $${profile?.marketCap ? (profile.marketCap / 1e9).toFixed(2) + 'B' : 'N/A'}
- P/E (TTM): ${stats?.pe?.toFixed(2) || 'N/A'} | Forward P/E: ${stats?.forwardPe?.toFixed(2) || 'N/A'}
- PEG Ratio: ${stats?.peg?.toFixed(2) || 'N/A'}
- EPS (TTM): $${stats?.eps?.toFixed(2) || 'N/A'} | Forward EPS: $${stats?.forwardEps?.toFixed(2) || 'N/A'}
- Revenue: $${stats?.revenue ? (Number(stats.revenue) / 1e9).toFixed(2) + 'B' : 'N/A'}
- Revenue Growth: ${stats?.revenueGrowth ? (Number(stats.revenueGrowth) * 100).toFixed(1) + '%' : 'N/A'}
- Gross Margin: ${stats?.grossMargin ? (Number(stats.grossMargin) * 100).toFixed(1) + '%' : 'N/A'}
- Operating Margin: ${stats?.operatingMargin ? (Number(stats.operatingMargin) * 100).toFixed(1) + '%' : 'N/A'}
- Profit Margin: ${stats?.profitMargin ? (Number(stats.profitMargin) * 100).toFixed(1) + '%' : 'N/A'}
- ROE: ${stats?.returnOnEquity ? (Number(stats.returnOnEquity) * 100).toFixed(1) + '%' : 'N/A'}
- Debt/Equity: ${stats?.debtToEquity?.toFixed(2) || 'N/A'}
- Current Ratio: ${stats?.currentRatio?.toFixed(2) || 'N/A'}
- Free Cash Flow: $${stats?.freeCashFlow ? (Number(stats.freeCashFlow) / 1e9).toFixed(2) + 'B' : 'N/A'}
- Beta: ${stats?.beta?.toFixed(2) || 'N/A'}
- Short Interest: ${stats?.shortPercentOfFloat ? (Number(stats.shortPercentOfFloat) * 100).toFixed(1) + '%' : 'N/A'}
- Dividend Yield: ${stats?.dividendYield ? (Number(stats.dividendYield) * 100).toFixed(2) + '%' : 'None'}

## Analyst Consensus
${analystText}
- Mean Price Target: $${stats?.targetMeanPrice || 'N/A'}
- Low Target: $${stats?.targetLowPrice || 'N/A'} | High Target: $${stats?.targetHighPrice || 'N/A'}
- Recommendation: ${stats?.recommendationKey || 'N/A'} (${stats?.numberOfAnalysts || 0} analysts)

## Technical Indicators
- Price: $${currentPrice.toFixed(2)}
- 20-day SMA: ${technicals.sma20 ? '$' + technicals.sma20.toFixed(2) : 'N/A'} (${technicals.sma20 ? (currentPrice > technicals.sma20 ? 'ABOVE' : 'BELOW') : ''})
- 50-day SMA: ${technicals.sma50 ? '$' + technicals.sma50.toFixed(2) : 'N/A'} (${technicals.sma50 ? (currentPrice > technicals.sma50 ? 'ABOVE' : 'BELOW') : ''})
- 200-day SMA: ${technicals.sma200 ? '$' + technicals.sma200.toFixed(2) : 'N/A'} (${technicals.sma200 ? (currentPrice > technicals.sma200 ? 'ABOVE' : 'BELOW') : ''})
- RSI (14): ${technicals.rsi?.toFixed(1) || 'N/A'} ${technicals.rsi ? (technicals.rsi > 70 ? '(OVERBOUGHT)' : technicals.rsi < 30 ? '(OVERSOLD)' : '(NEUTRAL)') : ''}
- 52-Week High: $${stats?.fiftyTwoWeekHigh || 'N/A'} | Low: $${stats?.fiftyTwoWeekLow || 'N/A'}
- 1D Change: ${technicals.priceChange1d?.toFixed(2) || 'N/A'}%
- 1W Change: ${technicals.priceChange1w?.toFixed(2) || 'N/A'}%
- 1M Change: ${technicals.priceChange1m?.toFixed(2) || 'N/A'}%
- 3M Change: ${technicals.priceChange3m?.toFixed(2) || 'N/A'}%

## Recent Earnings
${earningsText}

## Recent News
${newsText || 'No recent news'}

## Company Description
${profile?.description?.slice(0, 500) || 'N/A'}

---

Respond in EXACTLY this JSON format (no markdown, no code fences, just raw JSON):
{
  "score": <number from -100 to 100, where -100=strong sell, 0=hold, 100=strong buy>,
  "signal": "<strong_buy|buy|hold|sell|strong_sell>",
  "confidence": <number 0-100>,
  "summary": "<2-3 sentence executive summary of the investment case>",
  "thesis": "<detailed 3-5 paragraph analysis covering: 1) Business quality & competitive position, 2) Valuation assessment, 3) Growth trajectory, 4) Technical setup, 5) Catalyst timeline>",
  "priceTarget": <your estimated 12-month fair value price as number or null>,
  "risks": ["<risk 1>", "<risk 2>", "<risk 3>"],
  "catalysts": ["<catalyst 1>", "<catalyst 2>", "<catalyst 3>"],
  "keyMetrics": {
    "valuationGrade": "<A/B/C/D/F>",
    "growthGrade": "<A/B/C/D/F>",
    "profitabilityGrade": "<A/B/C/D/F>",
    "financialHealthGrade": "<A/B/C/D/F>",
    "technicalGrade": "<A/B/C/D/F>",
    "overallGrade": "<A/B/C/D/F>"
  },
  "tradeIdea": {
    "action": "<buy|sell|hold|options_call|options_put>",
    "entryPrice": <suggested entry price or null>,
    "targetPrice": <price target or null>,
    "stopLoss": <stop loss price or null>,
    "reasoning": "<1-2 sentence trade rationale>",
    "timeframe": "<day_trade|swing|position|long_term>",
    "riskReward": <risk/reward ratio as number or null>
  }
}`;
}

function parseAnalysisResponse(text: string, currentPrice: number): AnalysisResult {
  try {
    // Try to extract JSON from the response
    let jsonStr = text.trim();
    // Handle case where Claude wraps in code fences
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    const parsed = JSON.parse(jsonStr);

    return {
      score: Math.max(-100, Math.min(100, parsed.score || 0)),
      signal: parsed.signal || "hold",
      summary: parsed.summary || "",
      thesis: parsed.thesis || "",
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      catalysts: Array.isArray(parsed.catalysts) ? parsed.catalysts : [],
      priceTarget: parsed.priceTarget || null,
      confidence: Math.max(0, Math.min(100, parsed.confidence || 50)),
      keyMetrics: parsed.keyMetrics || {},
      tradeIdea: parsed.tradeIdea || null,
    };
  } catch {
    // If parsing fails, return a default
    return {
      score: 0,
      signal: "hold",
      summary: text.slice(0, 200),
      thesis: text,
      risks: [],
      catalysts: [],
      priceTarget: null,
      confidence: 30,
      keyMetrics: {},
    };
  }
}

// Chat with the AI about trading
export async function chatWithAnalyst(
  message: string,
  history: { role: string; content: string }[]
): Promise<string> {
  // Store user message
  await prisma.chatMessage.create({
    data: { role: "user", content: message },
  });

  // Get recent research for context
  const recentReports = await prisma.researchReport.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { symbol: true, signal: true, score: true, summary: true },
  });

  const activeIdeas = await prisma.tradeIdea.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const systemPrompt = `You are an elite trading analyst assistant. You have access to a research library and can discuss any stock, trading strategy, or market analysis.

Your recent research reports:
${recentReports.map((r) => `- ${r.symbol}: ${r.signal} (score: ${r.score}) — ${r.summary}`).join("\n") || "No recent reports"}

Active trade ideas:
${activeIdeas.map((t) => `- ${t.symbol}: ${t.action} @ $${t.entryPrice} → $${t.targetPrice} (${t.timeframe}) — ${t.reasoning}`).join("\n") || "No active ideas"}

Guidelines:
- Be specific with numbers, prices, and percentages
- Reference your research library when relevant
- Suggest running analysis on specific stocks when asked for recommendations
- Be direct and opinionated — traders need clear answers, not hedging
- If the user asks about a stock you haven't analyzed, suggest they run an analysis first
- Consider risk management: position sizing, stop losses, portfolio diversification`;

  const messages = [
    ...history.map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    })),
    { role: "user" as const, content: message },
  ];

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: systemPrompt,
    messages,
  });

  const assistantMessage = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Store assistant message
  await prisma.chatMessage.create({
    data: { role: "assistant", content: assistantMessage },
  });

  return assistantMessage;
}

// Scan market for opportunities
export async function scanMarket(): Promise<AnalysisResult[]> {
  // Import here to avoid circular deps
  const { getTopMovers, getMostActives } = await import("./alpaca");

  const [gainers, losers, active] = await Promise.all([
    getTopMovers("gainers"),
    getTopMovers("losers"),
    getMostActives(),
  ]);

  // Pick top candidates: biggest gainers + oversold losers + most active
  const candidates = new Set<string>();
  gainers.slice(0, 3).forEach((m) => candidates.add(m.symbol));
  losers.slice(0, 2).forEach((m) => candidates.add(m.symbol));
  active.slice(0, 3).forEach((m) => candidates.add(m.symbol));

  const results: AnalysisResult[] = [];
  for (const symbol of candidates) {
    try {
      const analysis = await analyzeStock(symbol);
      results.push(analysis);
    } catch (err) {
      console.error(`Failed to analyze ${symbol}:`, err);
    }
  }

  // Sort by absolute score (strongest signals first)
  results.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  return results;
}
