import Anthropic from "@anthropic-ai/sdk";
import {
  checkAuth,
  searchFuturesContract,
  getFuturesSnapshot,
  getFuturesBars,
  placeFuturesOrder,
  getIBKRPositions,
  getIBKRAccountSummary,
  FUTURES_CONTRACTS,
  type FuturesOrder,
} from "./ibkr";
import { detectMarketRegime } from "./market-regime";
import { getCrossAssetSignals } from "./cross-asset";
import { prisma } from "./db";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

// ============ FUTURES TRADING STRATEGIES ============

const FUTURES_RULES = {
  // Risk management
  MAX_CONTRACTS_PER_TRADE: 5,
  MAX_TOTAL_CONTRACTS: 10,
  MAX_LOSS_PER_TRADE: 200,       // $200 max loss per trade
  DAILY_LOSS_LIMIT: 1000,        // $1000 max daily loss
  MAX_DRAWDOWN_PCT: 5,           // 5% max drawdown from peak

  // Technical
  TREND_EMA_FAST: 9,
  TREND_EMA_SLOW: 21,
  RSI_OVERBOUGHT: 70,
  RSI_OVERSOLD: 30,
  ATR_STOP_MULTIPLIER: 1.5,
  ATR_TARGET_MULTIPLIER: 2.5,

  // Timing
  AVOID_FIRST_MINUTES: 5,        // Avoid first 5 min after open
  AVOID_LAST_MINUTES: 5,         // Avoid last 5 min before close
};

interface FuturesTradeResult {
  symbol: string;
  action: string;
  contracts: number;
  price: number;
  stopLoss: number;
  target: number;
  reasoning: string;
  orderId: string | null;
  success: boolean;
}

// ============ TECHNICAL INDICATORS ============

function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map((c) => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(bars: { h: number; l: number; c: number }[], period: number = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function vwap(bars: { h: number; l: number; c: number; v: number }[]): number {
  let cumPV = 0;
  let cumV = 0;
  for (const bar of bars) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    cumPV += typical * bar.v;
    cumV += bar.v;
  }
  return cumV > 0 ? cumPV / cumV : 0;
}

// ============ MAIN FUTURES AGENT ============

export async function runFuturesAgent(): Promise<{
  trades: FuturesTradeResult[];
  managed: number;
  details: string[];
}> {
  const details: string[] = [];
  const trades: FuturesTradeResult[] = [];
  let managed = 0;

  // Check IBKR connection
  const auth = await checkAuth();
  if (!auth.authenticated) {
    details.push("IBKR not authenticated — cannot trade futures");
    return { trades, managed, details };
  }

  // Get market regime and macro context
  let regime = "choppy";
  try {
    const r = await detectMarketRegime();
    regime = r.regime;
    details.push(`REGIME: ${r.regime.toUpperCase()} — ${r.recommendation}`);
  } catch {
    details.push("REGIME: Unknown — using conservative defaults");
  }

  let macroContext = "";
  try {
    const signals = await getCrossAssetSignals();
    macroContext = signals.summary;
    details.push(`MACRO: ${macroContext}`);
  } catch { /* ignore */ }

  // Get account state
  let equity = 0;
  try {
    const summary = await getIBKRAccountSummary();
    equity = parseFloat(summary?.netliquidation?.amount || summary?.equity || "0");
    details.push(`IBKR Account: $${equity.toFixed(2)}`);
  } catch (err) {
    details.push(`Account error: ${err}`);
    return { trades, managed, details };
  }

  // Get existing futures positions
  const positions = await getIBKRPositions();
  const futuresPositions = positions.filter((p) => p.assetClass === "FUT");
  details.push(`Futures positions: ${futuresPositions.length}`);

  // ============ MANAGE EXISTING POSITIONS ============
  for (const pos of futuresPositions) {
    managed++;
    const unrealizedPnl = parseFloat(pos.unrealizedPnl || "0");
    const avgPrice = parseFloat(pos.avgCost || pos.avgPrice || "0");
    const mktPrice = parseFloat(pos.mktPrice || "0");
    const qty = parseInt(pos.position || pos.pos || "0");

    // Simple stop: close if down more than max loss per trade
    if (unrealizedPnl < -FUTURES_RULES.MAX_LOSS_PER_TRADE) {
      details.push(`  ${pos.contractDesc || pos.symbol}: STOP LOSS — down $${Math.abs(unrealizedPnl).toFixed(2)}`);
      try {
        await placeFuturesOrder({
          conid: pos.conid,
          side: qty > 0 ? "SELL" : "BUY",
          quantity: Math.abs(qty),
          orderType: "MKT",
          tif: "IOC",
        });
      } catch (err) {
        details.push(`    Failed to close: ${err}`);
      }
      continue;
    }

    details.push(`  ${pos.contractDesc || pos.symbol}: ${qty > 0 ? "LONG" : "SHORT"} ${Math.abs(qty)}x @ $${avgPrice.toFixed(2)} | P&L: $${unrealizedPnl.toFixed(2)}`);
  }

  // ============ SCAN FOR NEW FUTURES TRADES ============
  if (futuresPositions.length >= FUTURES_RULES.MAX_TOTAL_CONTRACTS / 2) {
    details.push("At position limit — not scanning for new trades");
    return { trades, managed, details };
  }

  const symbols = ["MES", "MNQ", "MYM", "M2K"];

  for (const symbol of symbols) {
    const contractInfo = FUTURES_CONTRACTS[symbol];
    details.push(`\nAnalyzing ${symbol} (${contractInfo.name})...`);

    // Find the front-month contract
    const contract = await searchFuturesContract(symbol);
    if (!contract) {
      details.push(`  Could not find contract for ${symbol}`);
      continue;
    }

    // Get price data
    let snapshot;
    let bars5min;
    try {
      snapshot = await getFuturesSnapshot(contract.conid);
      bars5min = await getFuturesBars(contract.conid, "1d", "5min");
    } catch (err) {
      details.push(`  Data error: ${err}`);
      continue;
    }

    if (!snapshot.last || bars5min.length < 30) {
      details.push(`  Insufficient data`);
      continue;
    }

    const closes = bars5min.map((b) => b.c);
    const currentPrice = snapshot.last;

    // Calculate indicators
    const emaFast = ema(closes, FUTURES_RULES.TREND_EMA_FAST);
    const emaSlow = ema(closes, FUTURES_RULES.TREND_EMA_SLOW);
    const currentRSI = rsi(closes);
    const currentATR = atr(bars5min);
    const currentVWAP = vwap(bars5min);

    const fastEMA = emaFast[emaFast.length - 1];
    const slowEMA = emaSlow[emaSlow.length - 1];
    const prevFastEMA = emaFast[emaFast.length - 2];
    const prevSlowEMA = emaSlow[emaSlow.length - 2];

    // Trend detection
    const isBullishCross = prevFastEMA <= prevSlowEMA && fastEMA > slowEMA;
    const isBearishCross = prevFastEMA >= prevSlowEMA && fastEMA < slowEMA;
    const isUptrend = fastEMA > slowEMA;
    const isDowntrend = fastEMA < slowEMA;
    const aboveVWAP = currentPrice > currentVWAP;

    details.push(`  Price: $${currentPrice.toFixed(2)} | EMA9: ${fastEMA.toFixed(2)} | EMA21: ${slowEMA.toFixed(2)} | RSI: ${currentRSI?.toFixed(0) || "N/A"} | ATR: ${currentATR.toFixed(2)} | VWAP: ${currentVWAP.toFixed(2)}`);

    // AI analysis for context
    let aiSignal = "hold";
    let aiReasoning = "";
    try {
      const prompt = `You are a futures scalp trader. Analyze this setup for ${symbol} (${contractInfo.name}):

Price: $${currentPrice.toFixed(2)}
EMA 9: ${fastEMA.toFixed(2)} (${isUptrend ? "ABOVE" : "BELOW"} EMA 21)
EMA 21: ${slowEMA.toFixed(2)}
RSI: ${currentRSI?.toFixed(0) || "N/A"}
ATR (5min): ${currentATR.toFixed(2)}
VWAP: ${currentVWAP.toFixed(2)} (price ${aboveVWAP ? "ABOVE" : "BELOW"})
EMA crossover: ${isBullishCross ? "BULLISH CROSS just occurred" : isBearishCross ? "BEARISH CROSS just occurred" : "No recent cross"}
Market regime: ${regime.toUpperCase()}
Macro: ${macroContext}

Respond with ONLY a JSON object (no markdown):
{"signal": "long|short|hold", "confidence": 0-100, "reasoning": "one sentence", "stopPoints": <ATR multiplier for stop 1-3>, "targetPoints": <ATR multiplier for target 1-4>}`;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const parsed = JSON.parse(text.trim());
      aiSignal = parsed.signal || "hold";
      aiReasoning = parsed.reasoning || "";

      details.push(`  AI: ${aiSignal.toUpperCase()} (${parsed.confidence}%) — ${aiReasoning}`);
    } catch {
      // Fall back to pure technical signals
      if (isBullishCross && aboveVWAP) aiSignal = "long";
      else if (isBearishCross && !aboveVWAP) aiSignal = "short";
      details.push(`  AI unavailable — using technicals: ${aiSignal}`);
    }

    if (aiSignal === "hold") {
      details.push(`  No trade — holding`);
      continue;
    }

    // Position sizing: risk $200 max per trade
    const stopDistance = currentATR * FUTURES_RULES.ATR_STOP_MULTIPLIER;
    const targetDistance = currentATR * FUTURES_RULES.ATR_TARGET_MULTIPLIER;
    const riskPerContract = stopDistance * contractInfo.multiplier;
    const contracts = Math.max(1, Math.min(
      FUTURES_RULES.MAX_CONTRACTS_PER_TRADE,
      Math.floor(FUTURES_RULES.MAX_LOSS_PER_TRADE / riskPerContract)
    ));

    const side = aiSignal === "long" ? "BUY" as const : "SELL" as const;
    const stopLoss = aiSignal === "long" ? currentPrice - stopDistance : currentPrice + stopDistance;
    const target = aiSignal === "long" ? currentPrice + targetDistance : currentPrice - targetDistance;

    details.push(`  TRADE: ${side} ${contracts}x ${symbol} @ $${currentPrice.toFixed(2)} | Stop: $${stopLoss.toFixed(2)} | Target: $${target.toFixed(2)} | Risk: $${(riskPerContract * contracts).toFixed(2)}`);

    try {
      const order = await placeFuturesOrder({
        conid: contract.conid,
        side,
        quantity: contracts,
        orderType: "MKT",
        tif: "DAY",
      });

      await prisma.autoTradeLog.create({
        data: {
          symbol: `FUT:${symbol}`,
          action: `futures_${aiSignal}`,
          qty: contracts,
          price: currentPrice,
          reason: `[FUTURES ${symbol}] ${aiSignal.toUpperCase()} ${contracts}x @ $${currentPrice.toFixed(2)}. Stop: $${stopLoss.toFixed(2)}, Target: $${target.toFixed(2)}. ${aiReasoning}`,
          aiScore: null,
          aiSignal,
          orderId: order.orderId,
        },
      });

      trades.push({
        symbol,
        action: aiSignal,
        contracts,
        price: currentPrice,
        stopLoss,
        target,
        reasoning: aiReasoning,
        orderId: order.orderId,
        success: true,
      });
    } catch (err) {
      details.push(`  Order failed: ${err}`);
      trades.push({
        symbol,
        action: aiSignal,
        contracts,
        price: currentPrice,
        stopLoss,
        target,
        reasoning: `Failed: ${err}`,
        orderId: null,
        success: false,
      });
    }
  }

  return { trades, managed, details };
}
