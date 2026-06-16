// ============ STOCKS SWING TRADING AGENT ============
// RTH swing trades via Alpaca. Holds 3-10 days. PDT-aware (avoids day trades < $25K).
// Scans focus watchlist for breakout/momentum setups, AI-confirms, logs to vault.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";
import {
  getPositions,
  getAccount,
  placeOrder,
  getBars,
  getSnapshot,
  getNews,
  type Position,
  type PlaceOrderParams,
  type Bar,
} from "./alpaca";
import type { TradingMode } from "./trading-mode";
import {
  loadAgentContext,
  logTradeToJournal,
  logDecision,
  logObservation,
  vaultRead,
  type TradeEntry,
} from "./vault";

// ── Config ──

interface StocksConfig {
  enabled: boolean;
  mode: TradingMode;
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  maxPositions: number;
  maxTradesPerDay: number;
  confidenceThreshold: number;
  focusSymbols: string[];
  simulatedEquity: number;
}

const DEFAULTS: StocksConfig = {
  enabled: false,
  mode: "paper" as TradingMode,
  riskPerTradePct: 2,
  dailyLossLimitPct: 5,
  maxPositions: 5,
  maxTradesPerDay: 2,
  confidenceThreshold: 75,
  focusSymbols: ["NVDA", "AAPL", "TSLA", "META", "AMZN", "GOOGL", "MSFT", "AMD", "AVGO", "NFLX"],
  simulatedEquity: 1000,
};

async function loadStocksConfig(): Promise<StocksConfig> {
  try {
    const keys = [
      "stocks_enabled", "stocks_risk_per_trade_pct", "stocks_daily_loss_limit_pct",
      "stocks_max_positions", "stocks_max_trades_per_day", "stocks_confidence_threshold",
      "stocks_focus_symbols", "stocks_simulated_equity",
    ];
    const configs = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
    const cfg: Record<string, string> = {};
    for (const c of configs) cfg[c.key] = c.value;

    return {
      enabled: cfg.stocks_enabled === "paper" || cfg.stocks_enabled === "live",
      mode: (cfg.stocks_enabled === "live" ? "live" : "paper") as TradingMode,
      riskPerTradePct: parseFloat(cfg.stocks_risk_per_trade_pct) || DEFAULTS.riskPerTradePct,
      dailyLossLimitPct: parseFloat(cfg.stocks_daily_loss_limit_pct) || DEFAULTS.dailyLossLimitPct,
      maxPositions: parseInt(cfg.stocks_max_positions) || DEFAULTS.maxPositions,
      maxTradesPerDay: parseInt(cfg.stocks_max_trades_per_day) || DEFAULTS.maxTradesPerDay,
      confidenceThreshold: parseFloat(cfg.stocks_confidence_threshold) || DEFAULTS.confidenceThreshold,
      focusSymbols: cfg.stocks_focus_symbols
        ? cfg.stocks_focus_symbols.split(",").map((s) => s.trim())
        : DEFAULTS.focusSymbols,
      simulatedEquity: parseFloat(cfg.stocks_simulated_equity) || DEFAULTS.simulatedEquity,
    };
  } catch {
    return DEFAULTS;
  }
}

// ── Technical Indicators ──

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

// ── Setup Types ──

interface StockSetup {
  symbol: string;
  type: "breakout" | "pullback_to_ema" | "relative_strength" | "earnings_momentum";
  direction: "long";
  price: number;
  stopPrice: number;
  targetPrice: number;
  riskReward: number;
  confidence: number;
  reasoning: string;
  indicators: {
    rsi: number | null;
    atr: number;
    ema9: number;
    ema21: number;
    ema50: number;
    relativeStrength: number;
    volumeRatio: number;
  };
}

export interface StockTradeResult {
  symbol: string;
  action: string;
  qty: string;
  price: number;
  orderId?: string;
  pnl?: number;
  reason: string;
}

// ── Setup Scanner ──

async function scanStockSetups(symbols: string[]): Promise<StockSetup[]> {
  const setups: StockSetup[] = [];

  // Get SPY for relative strength comparison
  let spyBars: Bar[] = [];
  try {
    spyBars = await getBars("SPY", "1Day");
  } catch {}
  const spyCloses = spyBars.map((b) => b.c);
  const spy20dReturn = spyCloses.length >= 20
    ? (spyCloses[spyCloses.length - 1] - spyCloses[spyCloses.length - 20]) / spyCloses[spyCloses.length - 20]
    : 0;

  for (const symbol of symbols) {
    try {
      const bars = await getBars(symbol, "1Day");
      if (bars.length < 55) continue;

      const closes = bars.map((b) => b.c);
      const barData = bars.map((b) => ({ h: b.h, l: b.l, c: b.c, v: b.v }));
      const currentPrice = closes[closes.length - 1];
      const currentRsi = rsi(closes);
      const currentAtr = atr(barData);

      const ema9Arr = ema(closes, 9);
      const ema21Arr = ema(closes, 21);
      const ema50Arr = ema(closes, 50);
      const ema9 = ema9Arr[ema9Arr.length - 1];
      const ema21 = ema21Arr[ema21Arr.length - 1];
      const ema50 = ema50Arr[ema50Arr.length - 1];

      // Volume ratio (last 5 avg vs 20 avg)
      const recentVol = bars.slice(-5).reduce((s, b) => s + b.v, 0) / 5;
      const avgVol = bars.slice(-20).reduce((s, b) => s + b.v, 0) / 20;
      const volumeRatio = avgVol > 0 ? recentVol / avgVol : 1;

      // Relative strength vs SPY
      const stock20dReturn = closes.length >= 20
        ? (currentPrice - closes[closes.length - 20]) / closes[closes.length - 20]
        : 0;
      const relativeStrength = stock20dReturn - spy20dReturn;

      // 20-day high/low
      const high20 = Math.max(...closes.slice(-20));

      const indicators = { rsi: currentRsi, atr: currentAtr, ema9, ema21, ema50, relativeStrength, volumeRatio };

      // 1. Breakout: price at/above 20-day high with volume
      if (
        currentPrice >= high20 * 0.99 &&
        volumeRatio > 1.2 &&
        ema9 > ema21 &&
        ema21 > ema50
      ) {
        const stop = currentPrice - currentAtr * 2;
        const target = currentPrice + currentAtr * 5;
        const rr = (target - currentPrice) / (currentPrice - stop);
        if (rr >= 2) {
          setups.push({
            symbol, type: "breakout", direction: "long",
            price: currentPrice, stopPrice: stop, targetPrice: target, riskReward: rr,
            confidence: 60 + (volumeRatio > 1.5 ? 10 : 0) + (relativeStrength > 0.02 ? 5 : 0),
            reasoning: `Breaking 20-day high at $${high20.toFixed(2)} with ${volumeRatio.toFixed(1)}x volume. All EMAs aligned. RS: ${(relativeStrength * 100).toFixed(1)}% vs SPY.`,
            indicators,
          });
        }
      }

      // 2. Pullback to EMA 21 in uptrend
      if (
        ema9 > ema21 && ema21 > ema50 &&
        currentPrice > ema21 * 0.99 && currentPrice < ema21 * 1.015 &&
        currentRsi !== null && currentRsi > 40 && currentRsi < 60
      ) {
        const stop = ema50 - currentAtr * 0.5;
        const target = currentPrice + currentAtr * 4;
        const rr = (target - currentPrice) / (currentPrice - stop);
        if (rr >= 2) {
          setups.push({
            symbol, type: "pullback_to_ema", direction: "long",
            price: currentPrice, stopPrice: stop, targetPrice: target, riskReward: rr,
            confidence: 65 + (relativeStrength > 0.03 ? 10 : 0),
            reasoning: `Pulling back to EMA 21 ($${ema21.toFixed(2)}) in strong uptrend. RSI ${currentRsi?.toFixed(0)} neutral. RS: +${(relativeStrength * 100).toFixed(1)}% vs SPY.`,
            indicators,
          });
        }
      }

      // 3. Relative strength leader
      if (
        relativeStrength > 0.05 &&
        ema9 > ema21 &&
        currentRsi !== null && currentRsi < 70
      ) {
        const stop = currentPrice - currentAtr * 2;
        const target = currentPrice + currentAtr * 4;
        const rr = (target - currentPrice) / (currentPrice - stop);
        if (rr >= 2) {
          setups.push({
            symbol, type: "relative_strength", direction: "long",
            price: currentPrice, stopPrice: stop, targetPrice: target, riskReward: rr,
            confidence: 55 + Math.min(15, Math.round(relativeStrength * 200)),
            reasoning: `Strong relative strength: +${(relativeStrength * 100).toFixed(1)}% vs SPY over 20d. Trend intact (EMA 9 > 21). RSI ${currentRsi?.toFixed(0)} not overbought.`,
            indicators,
          });
        }
      }

    } catch (err) {
      console.error(`[stocks-agent] Error scanning ${symbol}:`, err);
    }
  }

  return setups.sort((a, b) => b.confidence - a.confidence);
}

// ── AI Confirmation ──

async function aiConfirmSetup(
  setup: StockSetup,
  vaultContext: string,
  equity: number,
): Promise<{ agree: boolean; conviction: string; reasoning: string }> {
  const anthropic = new Anthropic();

  const prompt = `You are a disciplined swing trader managing a $${equity} stock account on Alpaca.
CRITICAL: Only A+ and A setups execute. B and C are KILLED. Swing holds 3-10 days.

${setup.symbol} setup:
Price: $${setup.price.toFixed(2)} | RSI: ${setup.indicators.rsi?.toFixed(1) || "N/A"} | ATR: $${setup.indicators.atr.toFixed(2)}
EMA 9: $${setup.indicators.ema9.toFixed(2)} | EMA 21: $${setup.indicators.ema21.toFixed(2)} | EMA 50: $${setup.indicators.ema50.toFixed(2)}
Relative Strength vs SPY: ${(setup.indicators.relativeStrength * 100).toFixed(1)}% | Volume: ${setup.indicators.volumeRatio.toFixed(1)}x avg
Setup: ${setup.type} — ${setup.direction} — ${setup.reasoning}
Stop: $${setup.stopPrice.toFixed(2)} | Target: $${setup.targetPrice.toFixed(2)} | R:R: ${setup.riskReward.toFixed(1)}

${vaultContext}

A+ = textbook swing setup, multiple timeframe confluence. A = solid edge, clean chart. B = marginal. C = no edge.
Reply ONLY with JSON: {"agree": true/false, "conviction": "A+"|"A"|"B"|"C", "reasoning": "one sentence"}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let jsonText = text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonText = jsonMatch[1].trim();

    return JSON.parse(jsonText);
  } catch (err) {
    console.error("[stocks-agent] AI error:", err);
    return { agree: false, conviction: "C", reasoning: "AI error — skipping" };
  }
}

// ── Main Agent ──

export async function runStocksAgent(): Promise<{
  trades: StockTradeResult[];
  managed: number;
  details: string[];
}> {
  const config = await loadStocksConfig();
  const trades: StockTradeResult[] = [];
  const details: string[] = [];

  if (!config.enabled) {
    return { trades, managed: 0, details: ["Stocks agent disabled"] };
  }

  // Paper sizing basis: if alpaca_account_size is set (the $1K paper test), size off THAT so paper
  // mirrors a real small account. Otherwise fall back to the paper shell's real equity (legacy demo).
  if (config.mode === "paper") {
    try {
      const account = await getAccount(config.mode);
      const actualEquity = parseFloat(account.equity);
      const sizeCfg = await prisma.agentConfig.findUnique({ where: { key: "alpaca_account_size" } });
      const simSize = sizeCfg ? parseFloat(sizeCfg.value) : 0;
      const baseEquity = simSize > 0 ? simSize : actualEquity;
      if (baseEquity > 0) {
        config.simulatedEquity = baseEquity;
        config.maxPositions = simSize > 0 ? 4 : 10;       // tighter on a small shared pool
        config.maxTradesPerDay = simSize > 0 ? 4 : 8;
        config.riskPerTradePct = simSize > 0 ? 2 : 5;
        config.confidenceThreshold = 65;
      }
    } catch { /* fall back to defaults */ }
  }

  details.push(`[stocks-agent] Starting. Mode: ${config.mode.toUpperCase()}, Equity: $${config.simulatedEquity.toLocaleString()}, Watchlist: ${config.focusSymbols.length} symbols`);

  // ── 1. Check market hours ──
  try {
    const clock = await (await fetch(`${process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets"}/v2/clock`, {
      headers: {
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY || "",
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET || "",
      },
    })).json();
    if (!clock.is_open) {
      details.push("[stocks-agent] Market closed. Skipping scan.");
      return { trades, managed: 0, details };
    }
  } catch {
    details.push("[stocks-agent] Could not check market hours. Proceeding.");
  }

  // ── 2. Load vault context ──
  const context = await loadAgentContext("stocks-agent", "stock-swing.md");
  const vaultContext = [
    context.marketRegime ? `MARKET REGIME:\n${context.marketRegime.slice(0, 300)}` : "",
    context.activeLessons ? `ACTIVE LESSONS:\n${context.activeLessons.slice(0, 300)}` : "",
    context.antiPatterns ? `ANTI-PATTERNS:\n${context.antiPatterns.slice(0, 200)}` : "",
    context.strategy ? `STRATEGY:\n${context.strategy.slice(0, 300)}` : "",
  ].filter(Boolean).join("\n\n");

  // ── 3. Get existing stock positions ──
  let stockPositions: Position[] = [];
  let poolUsed = 0;
  try {
    const allPositions = await getPositions(config.mode);
    stockPositions = allPositions.filter((p) => p.asset_class === "us_equity");
    // Capital deployed across the SHARED Alpaca account (stocks + crypto + options) — caps the pool.
    poolUsed = allPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || "0")), 0);
  } catch (err) {
    details.push(`[stocks-agent] Failed to fetch positions: ${err}`);
    return { trades, managed: 0, details };
  }
  details.push(`[stocks-agent] Open stock positions: ${stockPositions.length}`);

  // ── 4. Check daily limits ──
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTrades = await prisma.autoTradeLog.count({
    where: {
      symbol: { startsWith: "STK:" },
      createdAt: { gte: todayStart },
      action: { startsWith: "stock_" },
    },
  });

  if (todayTrades >= config.maxTradesPerDay) {
    details.push(`[stocks-agent] Max trades reached (${todayTrades}/${config.maxTradesPerDay}).`);
    return { trades, managed: stockPositions.length, details };
  }

  // ── 5. PDT check — avoid day trades if < $25K ──
  let pdtSafe = true;
  try {
    const account = await getAccount(config.mode);
    const accountEquity = parseFloat(account.equity);
    if (accountEquity < 25000 && account.daytrade_count >= 3) {
      pdtSafe = false;
      details.push(`[stocks-agent] PDT warning: ${account.daytrade_count}/3 day trades used. Swing-only mode.`);
    }
  } catch {}

  // ── 6. Scan for setups ──
  if (stockPositions.length >= config.maxPositions) {
    details.push(`[stocks-agent] Max positions reached (${stockPositions.length}/${config.maxPositions}). Managing only.`);
  } else {
    const heldSymbols = stockPositions.map((p) => p.symbol);
    const scanSymbols = config.focusSymbols.filter((s) => !heldSymbols.includes(s));

    const setups = await scanStockSetups(scanSymbols);
    details.push(`[stocks-agent] Found ${setups.length} setups across ${scanSymbols.length} symbols`);

    // ── 7. AI confirm and execute ──
    for (const setup of setups) {
      if (stockPositions.length + trades.length >= config.maxPositions) break;
      if (todayTrades + trades.length >= config.maxTradesPerDay) break;

      let adjustedConfidence = setup.confidence;

      if (adjustedConfidence < config.confidenceThreshold) {
        await logDecision("stocks-agent", "SKIP", `STK:${setup.symbol}`, `Below threshold: ${adjustedConfidence} < ${config.confidenceThreshold}`, Math.round(adjustedConfidence / 20));
        continue;
      }

      const ai = await aiConfirmSetup(setup, vaultContext, config.simulatedEquity);

      if (!ai.agree) adjustedConfidence -= 30;
      if (ai.conviction === "C") adjustedConfidence -= 25;
      else if (ai.conviction === "B") adjustedConfidence -= 15;
      else if (ai.conviction === "A") adjustedConfidence += 20;
      else if (ai.conviction === "A+") adjustedConfidence += 30;

      if (adjustedConfidence < config.confidenceThreshold || ai.conviction === "B" || ai.conviction === "C") {
        await logDecision("stocks-agent", "SKIP", `STK:${setup.symbol}`, `AI: ${ai.conviction} — ${ai.reasoning}. Final: ${adjustedConfidence}`, Math.round(adjustedConfidence / 20));
        details.push(`[stocks-agent] KILLED ${setup.symbol}: ${ai.conviction}`);
        continue;
      }

      // Position sizing — dollar-based + fractional so a small ($1K) account takes a real slice
      // instead of being forced into ≥1 whole share of a pricey stock, and never exceeds the pool.
      const riskDollars = config.simulatedEquity * (config.riskPerTradePct / 100);
      const riskPerShare = Math.abs(setup.price - setup.stopPrice);
      if (riskPerShare <= 0) continue;
      const maxPerTrade = config.simulatedEquity * 0.25;            // ≤25% of the book per name
      const poolRemaining = Math.max(0, config.simulatedEquity - poolUsed);
      const notional = Math.min(riskDollars / (riskPerShare / setup.price), maxPerTrade, poolRemaining);
      if (notional < 5) {
        details.push(`[stocks-agent] SKIP ${setup.symbol}: ${poolRemaining < 5 ? "shared pool full" : "size too small"} ($${notional.toFixed(0)})`);
        continue;
      }
      const wholeShares = Math.floor(notional / setup.price);
      const useFractional = wholeShares < 1;                        // can't afford a whole share → notional order
      const shares = useFractional ? +(notional / setup.price).toFixed(6) : wholeShares;
      const orderNotional = useFractional ? notional : wholeShares * setup.price;

      details.push(`[stocks-agent] EXECUTING ${setup.symbol}: ${useFractional ? `$${notional.toFixed(0)} notional (~${shares} sh)` : `${wholeShares} sh`} @ $${setup.price.toFixed(2)} | AI: ${ai.conviction} | Conf: ${adjustedConfidence}`);

      try {
        const order = await placeOrder({
          symbol: setup.symbol,
          ...(useFractional ? { notional: notional.toFixed(2) } : { qty: String(wholeShares) }),
          side: "buy",
          type: "market",
          time_in_force: "day",
        }, config.mode);
        poolUsed += orderNotional;

        const orderId = order.id;
        const tradeId = `${new Date().toISOString().slice(0, 10)}-STK-${orderId.slice(-4)}`;

        await prisma.autoTradeLog.create({
          data: {
            symbol: `STK:${setup.symbol}`,
            action: `stock_${setup.direction}`,
            qty: shares,
            price: setup.price,
            reason: `[STOCK ${setup.symbol}] ${setup.type}: ${setup.reasoning}. AI: ${ai.conviction}. Stop: $${setup.stopPrice.toFixed(2)}, Target: $${setup.targetPrice.toFixed(2)}`,
            aiScore: Math.round(adjustedConfidence),
            aiSignal: setup.direction,
            orderId,
          },
        });

        await logTradeToJournal({
          tradeId,
          timestamp: new Date().toISOString(),
          instrument: `STK:${setup.symbol}`,
          direction: "LONG",
          strategy: "stock-swing",
          setupType: setup.type,
          contracts: shares,
          entryPrice: setup.price,
          stopPrice: setup.stopPrice,
          targetPrice: setup.targetPrice,
          conviction: Math.round(adjustedConfidence / 20),
        }, "stocks-agent");

        await logDecision("stocks-agent", "ENTRY", `STK:${setup.symbol}`,
          `${setup.type}: ${setup.reasoning}. AI: ${ai.conviction}. R:R ${setup.riskReward.toFixed(1)}`,
          Math.round(adjustedConfidence / 20));

        trades.push({
          symbol: setup.symbol, action: `stock_${setup.direction}`,
          qty: String(shares), price: setup.price, orderId,
          reason: `${setup.type} — AI: ${ai.conviction}`,
        });
      } catch (err) {
        details.push(`[stocks-agent] Order failed: ${err}`);
      }
    }
  }

  // ── 8. Manage existing positions ──
  for (const pos of stockPositions) {
    try {
      const currentPrice = parseFloat(pos.current_price);
      const entryPrice = parseFloat(pos.avg_entry_price);
      const qty = parseFloat(pos.qty);
      const unrealizedPnl = parseFloat(pos.unrealized_pl);

      const openingLog = await prisma.autoTradeLog.findFirst({
        where: { symbol: `STK:${pos.symbol}`, action: { startsWith: "stock_" }, orderId: { not: null } },
        orderBy: { createdAt: "desc" },
      });

      let stopPrice: number | null = null;
      let targetPrice: number | null = null;
      if (openingLog?.reason) {
        const stopMatch = openingLog.reason.match(/Stop:\s*\$?([\d,.]+)/);
        const targetMatch = openingLog.reason.match(/Target:\s*\$?([\d,.]+)/);
        if (stopMatch) stopPrice = parseFloat(stopMatch[1].replace(",", ""));
        if (targetMatch) targetPrice = parseFloat(targetMatch[1].replace(",", ""));
      }

      let shouldClose = false;
      let closeReason = "";

      if (stopPrice && currentPrice <= stopPrice) {
        shouldClose = true;
        closeReason = "Stop loss hit";
      } else if (targetPrice && currentPrice >= targetPrice) {
        shouldClose = true;
        closeReason = "Target reached";
      }

      // PDT check: only close if it won't trigger a day trade, OR if it's a stop loss
      if (shouldClose && !pdtSafe && closeReason !== "Stop loss hit") {
        const openDate = openingLog?.createdAt;
        if (openDate) {
          const holdDays = (Date.now() - new Date(openDate).getTime()) / (1000 * 60 * 60 * 24);
          if (holdDays < 1) {
            details.push(`[stocks-agent] SKIP close ${pos.symbol}: PDT risk (held < 1 day). Will close tomorrow.`);
            shouldClose = false;
          }
        }
      }

      if (shouldClose) {
        details.push(`[stocks-agent] CLOSING ${pos.symbol}: ${closeReason} @ $${currentPrice.toFixed(2)} P&L: $${unrealizedPnl.toFixed(2)}`);

        try {
          const closeOrder = await placeOrder({
            symbol: pos.symbol,
            qty: String(Math.abs(qty)),
            side: "sell",
            type: "market",
            time_in_force: "day",
          }, config.mode);

          await logTradeToJournal({
            tradeId: `${closeReason === "Target reached" ? "TP" : "SL"}-${Date.now().toString(36)}`,
            timestamp: new Date().toISOString(),
            instrument: `STK:${pos.symbol}`,
            direction: "LONG",
            strategy: "stock-swing",
            setupType: closeReason === "Target reached" ? "take_profit" : "stop_loss",
            contracts: Math.abs(qty),
            entryPrice,
            stopPrice: stopPrice || 0,
            targetPrice: targetPrice || 0,
            exitPrice: currentPrice,
            pnlDollars: unrealizedPnl,
            conviction: 0,
            exitReason: closeReason,
          }, "stocks-agent");

          await prisma.autoTradeLog.create({
            data: {
              symbol: `STK:${pos.symbol}`,
              action: closeReason === "Target reached" ? "take_profit" : "stop_loss",
              qty: Math.abs(qty),
              price: currentPrice,
              pnl: unrealizedPnl,
              reason: `[STOCK ${pos.symbol}] ${closeReason}`,
              orderId: closeOrder.id,
            },
          });

          trades.push({
            symbol: pos.symbol, action: closeReason === "Target reached" ? "take_profit" : "stop_loss",
            qty: String(Math.abs(qty)), price: currentPrice, orderId: closeOrder.id,
            pnl: unrealizedPnl, reason: closeReason,
          });
        } catch (err) {
          details.push(`[stocks-agent] Close failed: ${err}`);
        }
      }
    } catch (err) {
      details.push(`[stocks-agent] Error managing ${pos.symbol}: ${err}`);
    }
  }

  if (trades.length > 0) {
    const summary = trades.map((t) => `${t.action} ${t.symbol} @ $${t.price.toFixed(2)}${t.pnl ? ` P&L: $${t.pnl.toFixed(2)}` : ""}`).join("; ");
    await logObservation("stocks-agent", `Session: ${trades.length} actions. ${summary}`);
  }

  details.push(`[stocks-agent] Done. ${trades.length} trades, ${stockPositions.length} managed.`);
  return { trades, managed: stockPositions.length, details };
}
