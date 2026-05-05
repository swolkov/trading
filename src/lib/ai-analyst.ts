import Anthropic from "@anthropic-ai/sdk";
import { getCompanyProfile, getKeyStats, getEarnings, getAnalystRecommendations } from "./yahoo";
import { getSnapshot, getNews, getBars } from "./alpaca";
import { getInsiderTransactions, getSocialSentiment, getUpgradesDowngrades, getEarningsCalendar } from "./finnhub";
import { analyzeVolatility } from "./options-intelligence";
import { generateLearningInsights } from "./learning-engine";
import { getMarketKnowledgeBase } from "./market-knowledge";
import { runAdversarialAnalysis } from "./adversarial-analysis";
import { getTradeLessons } from "./trade-reviewer";
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
  optionsPlay?: {
    strategy: string; // buy_call, buy_put, sell_covered_call, bull_call_spread, bear_put_spread
    strike: number | null;
    expiry: string; // e.g. "2-4 weeks"
    reasoning: string;
    maxRisk: number | null; // max $ to risk on this play
    targetReturn: string; // e.g. "50-100%"
    confidence: number;
  };
}

export async function analyzeStock(symbol: string): Promise<AnalysisResult> {
  // Gather all data in parallel (Yahoo + Alpaca + Finnhub)
  const [profile, stats, earnings, analysts, news, bars, insiderTrades, sentiment, upgrades, earningsCal, volatility] = await Promise.all([
    getCompanyProfile(symbol).catch(() => null),
    getKeyStats(symbol).catch(() => null),
    getEarnings(symbol).catch(() => null),
    getAnalystRecommendations(symbol).catch(() => []),
    getNews([symbol], 5).catch(() => []),
    getBars(symbol, "1Day", undefined, undefined).catch(() => []),
    getInsiderTransactions(symbol).catch(() => []),
    getSocialSentiment(symbol).catch(() => null),
    getUpgradesDowngrades(symbol).catch(() => []),
    getEarningsCalendar().catch(() => []),
    analyzeVolatility(symbol).catch(() => null),
  ] as const);

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

  // Get past performance data for self-learning
  const pastTrades = await prisma.autoTradeLog.findMany({
    where: { action: { in: ["buy", "sell", "stop_loss", "take_profit", "trailing_stop", "thesis_change"] } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const pastReports = await prisma.researchReport.findMany({
    where: { symbol: symbol.toUpperCase() },
    orderBy: { createdAt: "desc" },
    take: 3,
  });

  // Generate comprehensive learning insights
  const learningInsights = await generateLearningInsights().catch(() => null);

  // Get market regime for explicit AI guidance
  // Get accumulated trade lessons
  const tradeLessons = await getTradeLessons().catch(() => "");

  let regimeContext = "";
  try {
    const { detectMarketRegime } = await import("./market-regime");
    const regimeData = await detectMarketRegime();
    regimeContext = `CURRENT MARKET REGIME: ${regimeData.regime.toUpperCase()}. ${regimeData.recommendation} SPY 1M: ${(regimeData.spy1mReturn * 100).toFixed(1)}%, Vol: ${regimeData.volatility.toFixed(0)}%. ${regimeData.regime === "bull" ? "FAVOR CALLS." : regimeData.regime === "bear" ? "FAVOR PUTS." : "TRADE LESS, use spreads."}`;
  } catch { /* ignore */ }

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
    pastTrades,
    pastReports,
    insiderTrades,
    sentiment,
    upgrades,
    earningsCal: earningsCal.filter((e) => e.symbol === symbol),
    volatility,
    learningInsights: learningInsights?.aiSummary || null,
    regimeContext,
    tradeLessons,
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

  // Run adversarial analysis to validate/challenge the initial recommendation
  try {
    const debate = await runAdversarialAnalysis(symbol, analysis, currentPrice);

    // If the adversarial analysis strongly disagrees, override the score
    if (
      (analysis.signal.includes("buy") && debate.verdict.includes("bearish") && debate.confidence > 70) ||
      (analysis.signal.includes("sell") && debate.verdict.includes("bullish") && debate.confidence > 70)
    ) {
      // The debate found the initial analysis is wrong — reduce confidence
      analysis.confidence = Math.max(20, analysis.confidence - 30);
      analysis.risks.push(`ADVERSARIAL: ${debate.killShot}`);
      analysis.thesis += `\n\n[ADVERSARIAL REVIEW] The bear case challenges this thesis: ${debate.bearCase}. Kill shot: ${debate.killShot}. Confidence reduced.`;
    }

    // Add blind spots to risks regardless
    for (const blindSpot of debate.blindSpots) {
      if (!analysis.risks.includes(blindSpot)) {
        analysis.risks.push(blindSpot);
      }
    }
  } catch {
    // adversarial analysis optional
  }

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
  pastTrades: { symbol: string; action: string; price: number | null; pnl: number | null; aiScore: number | null; reason: string; createdAt: Date }[];
  pastReports: { score: number; signal: string; summary: string; currentPrice: number | null; createdAt: Date }[];
  insiderTrades: { name: string; change: number; transactionDate: string; transactionCode: string; transactionPrice: number }[];
  sentiment: { redditMentions: number; twitterMentions: number; score: number } | null;
  upgrades: { company: string; fromGrade: string; toGrade: string; action: string; time: string }[];
  earningsCal: { date: string; epsEstimate: number | null; hour: string }[];
  volatility: { ivRank: number; currentIV: number | null; historicalVolatility20: number; ivVsHv: string; recommendation: string } | null;
  learningInsights: string | null;
  regimeContext: string;
  tradeLessons: string;
}): string {
  const { symbol, profile, stats, earnings, analysts, news, currentPrice, technicals, pastTrades, pastReports, insiderTrades, sentiment, upgrades, earningsCal, volatility, regimeContext, tradeLessons } = data;

  const newsText = news.map((n) => `- ${n.headline} (${n.source}, ${new Date(n.created_at).toLocaleDateString()})`).join("\n");

  const earningsText = earnings?.quarterly?.map((q) =>
    `Q: ${q.date} | Actual: $${q.actual?.toFixed(2) || 'N/A'} | Est: $${q.estimate?.toFixed(2) || 'N/A'} | Surprise: ${q.surprisePercent != null ? (q.surprisePercent * 100).toFixed(1) + '%' : 'N/A'}`
  ).join("\n") || "No earnings data";

  const analystText = analysts?.[0]
    ? `Strong Buy: ${analysts[0].strongBuy}, Buy: ${analysts[0].buy}, Hold: ${analysts[0].hold}, Sell: ${analysts[0].sell}, Strong Sell: ${analysts[0].strongSell}`
    : "No analyst data";

  // Build performance context from learning engine
  // Inject trade lessons
  const lessonsContext = tradeLessons || "";

  const performanceContext = data.learningInsights
    ? `\n## AI PERFORMANCE REVIEW — LEARN FROM THIS
${data.learningInsights}
${pastReports.length > 0 ? `\n## Previous Analysis of ${symbol}\n${pastReports.map((r) => `- Score: ${r.score}, Signal: ${r.signal}, Price at time: $${r.currentPrice?.toFixed(2) || '?'} (${new Date(r.createdAt).toLocaleDateString()}) — ${r.summary.slice(0, 100)}`).join('\n')}\nConsider how the stock has moved since our last analysis. Were we right or wrong? Adjust accordingly.` : ''}`
    : '';

  const marketKnowledge = getMarketKnowledgeBase();

  return `You are an elite Wall Street equity research analyst, quantitative trader, and OPTIONS STRATEGIST managing a $100,000 paper trading portfolio. You have 30 years of market experience encoded in your knowledge base below. Your goal is to maximize returns through smart options trades. Be brutally honest — if it's a bad investment, say so. If it's a great opportunity, explain why with conviction.

${marketKnowledge}

${regimeContext}
${lessonsContext}

CRITICAL RULES:
- You MUST recommend an options play for EVERY stock you analyze (calls if bullish, puts if bearish, or explain why no options play exists)
- For options: prefer 2-6 week expirations, slightly out-of-the-money strikes for leverage, in-the-money for safety
- Consider volatility: high IV = sell premium (covered calls), low IV = buy options
- NEVER recommend options on illiquid stocks (need tight bid-ask spreads)
- Learn from past performance data below — adjust your confidence based on what's working
${performanceContext}

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

## Options Volatility Analysis (CRITICAL FOR OPTIONS TRADING)
${volatility
  ? `- IV Rank: ${volatility.ivRank}/100 (${volatility.ivRank < 25 ? 'LOW — OPTIONS ARE CHEAP, GOOD TO BUY' : volatility.ivRank < 50 ? 'MODERATE-LOW — OK to buy' : volatility.ivRank < 75 ? 'MODERATE-HIGH — expensive, consider spreads' : 'HIGH — DO NOT buy naked options, sell premium instead'})
- Current IV: ${volatility.currentIV ? (volatility.currentIV * 100).toFixed(1) + '%' : 'N/A'}
- Historical Vol (20-day): ${(volatility.historicalVolatility20 * 100).toFixed(1)}%
- IV vs HV: ${volatility.ivVsHv.toUpperCase()}
- ${volatility.recommendation}

USE THIS FOR YOUR OPTIONS RECOMMENDATION:
- IV Rank < 25: BUY options (calls/puts) — they are cheap
- IV Rank 25-50: Buy options OK with conviction
- IV Rank 50-75: Use SPREADS instead of naked options to reduce cost
- IV Rank > 75: SELL premium (covered calls) or AVOID options entirely`
  : 'No volatility data available — be cautious with options recommendations'}

## Insider Trading (VERY IMPORTANT — smart money signal)
${insiderTrades.length > 0
  ? insiderTrades.slice(0, 8).map((t) => `- ${t.name}: ${t.transactionCode === 'P' ? 'BOUGHT' : 'SOLD'} ${Math.abs(t.change).toLocaleString()} shares @ $${t.transactionPrice.toFixed(2)} on ${t.transactionDate}`).join('\n')
  : 'No recent insider transactions'}
${insiderTrades.length > 0
  ? `NET INSIDER ACTIVITY: ${insiderTrades.reduce((sum, t) => sum + t.change, 0) > 0 ? 'NET BUYING (BULLISH)' : 'NET SELLING (BEARISH)'}`
  : ''}

## Social Sentiment
${sentiment
  ? `Reddit mentions: ${sentiment.redditMentions} | Twitter mentions: ${sentiment.twitterMentions} | Sentiment score: ${sentiment.score.toFixed(2)} (${sentiment.score > 0.2 ? 'BULLISH' : sentiment.score < -0.2 ? 'BEARISH' : 'NEUTRAL'})`
  : 'No social sentiment data'}

## Recent Analyst Upgrades/Downgrades
${upgrades.length > 0
  ? upgrades.slice(0, 5).map((u) => `- ${u.company}: ${u.action.toUpperCase()} from ${u.fromGrade} to ${u.toGrade} (${new Date(u.time).toLocaleDateString()})`).join('\n')
  : 'No recent upgrades/downgrades'}

## Upcoming Earnings
${earningsCal.length > 0
  ? earningsCal.map((e) => `- Reports: ${e.date} ${e.hour === 'bmo' ? '(Before Market Open)' : e.hour === 'amc' ? '(After Market Close)' : ''} | EPS Est: $${e.epsEstimate?.toFixed(2) || 'N/A'}`).join('\n')
  : 'No upcoming earnings scheduled'}
${earningsCal.length > 0 ? 'WARNING: Consider earnings risk when recommending trades. Options plays around earnings can be very profitable OR very risky.' : ''}

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
  },
  "optionsPlay": {
    "strategy": "<buy_call|buy_put|sell_covered_call|bull_call_spread|bear_put_spread|none>",
    "strike": <recommended strike price as number or null>,
    "expiry": "<recommended expiry timeframe, e.g. '2 weeks', '1 month', '45 days'>",
    "reasoning": "<why this options strategy — consider IV, catalysts, risk/reward>",
    "maxRisk": <maximum dollars to risk on this options trade or null>,
    "targetReturn": "<expected return range, e.g. '50-100%', '30-50%'>",
    "confidence": <0-100 confidence in the options play specifically>
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
      optionsPlay: parsed.optionsPlay || null,
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
