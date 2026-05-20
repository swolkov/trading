// ============ CRYPTO TRADING AGENT ============
// 24/7 crypto day trading via Alpaca. Follows the same vault protocol as futures-agent.
// Scans BTC/USD, ETH/USD, SOL/USD for setups, AI-confirms, places orders, logs everything.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";
import {
  getCryptoPositions,
  getCryptoSnapshot,
  placeCryptoOrder,
  getPositions,
  DEFAULT_CRYPTO_SYMBOLS,
  type Position,
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
import {
  detectCryptoRegime,
  scanCryptoSetups,
  updateCryptoRegimeVault,
  getFearAndGreed,
  type CryptoSetup,
  type CryptoRegime,
} from "./crypto-research";

// ── Config ──

interface CryptoConfig {
  enabled: boolean;
  mode: TradingMode; // "paper" | "live" — controls which Alpaca account orders go to
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  maxPositions: number;
  maxTradesPerDay: number;
  confidenceThreshold: number;
  focusSymbols: string[];
  simulatedEquity: number;
}

const DEFAULTS: CryptoConfig = {
  enabled: false,
  mode: "paper" as TradingMode,
  riskPerTradePct: 3,
  dailyLossLimitPct: 10,
  maxPositions: 3,
  maxTradesPerDay: 6,
  confidenceThreshold: 75,
  focusSymbols: ["BTC/USD", "ETH/USD", "SOL/USD"],
  simulatedEquity: 1000,
};

async function loadCryptoConfig(): Promise<CryptoConfig> {
  try {
    const keys = [
      "crypto_enabled",
      "crypto_risk_per_trade_pct",
      "crypto_daily_loss_limit_pct",
      "crypto_max_positions",
      "crypto_max_trades_per_day",
      "crypto_confidence_threshold",
      "crypto_focus_symbols",
      "crypto_simulated_equity",
    ];
    const configs = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
    const cfg: Record<string, string> = {};
    for (const c of configs) cfg[c.key] = c.value;

    return {
      enabled: cfg.crypto_enabled === "paper" || cfg.crypto_enabled === "live",
      mode: (cfg.crypto_enabled === "live" ? "live" : "paper") as TradingMode,
      riskPerTradePct: parseFloat(cfg.crypto_risk_per_trade_pct) || DEFAULTS.riskPerTradePct,
      dailyLossLimitPct: parseFloat(cfg.crypto_daily_loss_limit_pct) || DEFAULTS.dailyLossLimitPct,
      maxPositions: parseInt(cfg.crypto_max_positions) || DEFAULTS.maxPositions,
      maxTradesPerDay: parseInt(cfg.crypto_max_trades_per_day) || DEFAULTS.maxTradesPerDay,
      confidenceThreshold: parseFloat(cfg.crypto_confidence_threshold) || DEFAULTS.confidenceThreshold,
      focusSymbols: cfg.crypto_focus_symbols
        ? cfg.crypto_focus_symbols.split(",").map((s) => s.trim())
        : DEFAULTS.focusSymbols,
      simulatedEquity: parseFloat(cfg.crypto_simulated_equity) || DEFAULTS.simulatedEquity,
    };
  } catch {
    return DEFAULTS;
  }
}

// ── Result Types ──

export interface CryptoTradeResult {
  symbol: string;
  action: string;
  qty: string;
  price: number;
  orderId?: string;
  pnl?: number;
  reason: string;
}

// ── AI Confirmation ──

async function aiConfirmSetup(
  setup: CryptoSetup,
  regime: CryptoRegime,
  vaultContext: string,
  equity: number,
): Promise<{ agree: boolean; conviction: string; reasoning: string }> {
  const anthropic = new Anthropic();

  const prompt = `You are an elite crypto day trader managing a $${equity} account.
CRITICAL: Only A+ and A setups execute. B and C are KILLED immediately.

${setup.symbol} setup:
Price: $${setup.price.toFixed(2)} | RSI: ${setup.indicators.rsi?.toFixed(1) || "N/A"} | ATR: ${setup.indicators.atr.toFixed(2)}
EMA 9: ${setup.indicators.ema9.toFixed(2)} | EMA 21: ${setup.indicators.ema21.toFixed(2)}
Volume Ratio: ${setup.indicators.volumeRatio.toFixed(1)}x avg
Setup: ${setup.type} — ${setup.direction} — ${setup.reasoning}
Stop: $${setup.stopPrice.toFixed(2)} | Target: $${setup.targetPrice.toFixed(2)} | R:R: ${setup.riskReward.toFixed(1)}
Regime: ${regime}

${vaultContext}

A+ = textbook, high conviction, multiple confluences. A = solid edge, clear R:R. B = marginal. C = no edge.
Reply ONLY with JSON: {"agree": true/false, "conviction": "A+"|"A"|"B"|"C", "reasoning": "one sentence"}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
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
    console.error("[crypto-agent] AI confirmation error:", err);
    return { agree: false, conviction: "C", reasoning: "AI error — defaulting to skip" };
  }
}

// ── Main Agent ──

export async function runCryptoAgent(): Promise<{
  trades: CryptoTradeResult[];
  managed: number;
  details: string[];
}> {
  const config = await loadCryptoConfig();
  const trades: CryptoTradeResult[] = [];
  const details: string[] = [];

  if (!config.enabled) {
    return { trades, managed: 0, details: ["Crypto agent disabled"] };
  }

  // DEMO: Use Alpaca paper account's actual equity for aggressive learning
  // LIVE: Stay conservative with simulated $1K equity
  if (config.mode === "paper") {
    try {
      const { getAccount } = await import("./alpaca");
      const account = await getAccount(config.mode);
      const actualEquity = parseFloat(account.equity);
      if (actualEquity > 0) {
        config.simulatedEquity = actualEquity;
        config.maxPositions = 6;
        config.maxTradesPerDay = 15;
        config.riskPerTradePct = 5;
        config.confidenceThreshold = 65;
      }
    } catch { /* fall back to defaults */ }
  }

  details.push(`[crypto-agent] Starting scan. Mode: ${config.mode.toUpperCase()}, Equity: $${config.simulatedEquity.toLocaleString()}, Symbols: ${config.focusSymbols.join(", ")}`);

  // ── 1. Load vault context ──
  const context = await loadAgentContext("crypto-agent", "crypto-day-trading.md");
  const cryptoRegimeText = await vaultRead("Brain/crypto-regime.md");

  // Build vault context string for AI
  const vaultContext = [
    context.marketRegime ? `MARKET REGIME:\n${context.marketRegime.slice(0, 300)}` : "",
    cryptoRegimeText ? `CRYPTO REGIME:\n${cryptoRegimeText.slice(0, 300)}` : "",
    context.activeLessons ? `ACTIVE LESSONS:\n${context.activeLessons.slice(0, 300)}` : "",
    context.antiPatterns ? `ANTI-PATTERNS:\n${context.antiPatterns.slice(0, 200)}` : "",
    context.strategy ? `STRATEGY:\n${context.strategy.slice(0, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // ── 2. Detect crypto regime ──
  const regimeResult = await detectCryptoRegime();
  details.push(`[crypto-agent] Regime: ${regimeResult.regime} | ${regimeResult.details}`);

  // Update vault brain
  try {
    await updateCryptoRegimeVault(regimeResult);
  } catch (err) {
    console.error("[crypto-agent] Failed to update vault regime:", err);
  }

  // ── 3. Check existing positions ──
  let cryptoPositions: Position[] = [];
  try {
    cryptoPositions = await getCryptoPositions(config.mode);
  } catch (err) {
    details.push(`[crypto-agent] Failed to fetch positions: ${err}`);
    return { trades, managed: 0, details };
  }
  details.push(`[crypto-agent] Open crypto positions: ${cryptoPositions.length}`);

  // ── 4. Check daily trade count ──
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTrades = await prisma.autoTradeLog.count({
    where: {
      symbol: { startsWith: "CRY:" },
      createdAt: { gte: todayStart },
      action: { in: ["crypto_long", "crypto_short"] },
    },
  });

  if (todayTrades >= config.maxTradesPerDay) {
    details.push(`[crypto-agent] Max trades reached (${todayTrades}/${config.maxTradesPerDay}). Skipping scan.`);
    return { trades, managed: cryptoPositions.length, details };
  }

  // ── 5. Check daily P&L limit ──
  const todayPnl = await prisma.autoTradeLog.aggregate({
    where: {
      symbol: { startsWith: "CRY:" },
      createdAt: { gte: todayStart },
      pnl: { not: null },
    },
    _sum: { pnl: true },
  });
  const dailyPnl = todayPnl._sum.pnl || 0;
  const dailyLimit = config.simulatedEquity * (config.dailyLossLimitPct / 100);

  if (dailyPnl < -dailyLimit) {
    details.push(`[crypto-agent] Daily loss limit hit ($${dailyPnl.toFixed(2)} / -$${dailyLimit.toFixed(2)}). Stopping.`);
    return { trades, managed: cryptoPositions.length, details };
  }

  // ── 6. Scan for setups ──
  if (cryptoPositions.length >= config.maxPositions) {
    details.push(`[crypto-agent] Max positions reached (${cryptoPositions.length}/${config.maxPositions}). Managing only.`);
  } else {
    // Only scan symbols we don't already hold
    const heldSymbols = cryptoPositions.map((p) => p.symbol);
    const scanSymbols = config.focusSymbols.filter((s) => !heldSymbols.includes(s));

    const setups = await scanCryptoSetups(scanSymbols, regimeResult.regime);
    details.push(`[crypto-agent] Found ${setups.length} setups across ${scanSymbols.length} symbols`);

    // ── 7. AI confirm and execute top setups ──
    for (const setup of setups) {
      if (cryptoPositions.length >= config.maxPositions) break;
      if (todayTrades + trades.length >= config.maxTradesPerDay) break;

      // Apply regime-based confidence adjustment
      let adjustedConfidence = setup.confidence;
      if (regimeResult.regime === "CRYPTO_BEAR") adjustedConfidence -= 10;
      if (regimeResult.regime === "CRYPTO_EUPHORIA") adjustedConfidence -= 5;

      if (adjustedConfidence < config.confidenceThreshold) {
        await logDecision("crypto-agent", "SKIP", `CRY:${setup.symbol}`, `Below threshold: ${adjustedConfidence} < ${config.confidenceThreshold}. ${setup.reasoning}`, Math.round(adjustedConfidence / 20));
        details.push(`[crypto-agent] SKIP ${setup.symbol}: confidence ${adjustedConfidence} < ${config.confidenceThreshold}`);
        continue;
      }

      // AI confirmation
      const ai = await aiConfirmSetup(setup, regimeResult.regime, vaultContext, config.simulatedEquity);

      // Apply conviction adjustments
      if (!ai.agree) adjustedConfidence -= 30;
      if (ai.conviction === "C") adjustedConfidence -= 25;
      else if (ai.conviction === "B") adjustedConfidence -= 15;
      else if (ai.conviction === "A") adjustedConfidence += 20;
      else if (ai.conviction === "A+") adjustedConfidence += 30;

      if (adjustedConfidence < config.confidenceThreshold || ai.conviction === "B" || ai.conviction === "C") {
        await logDecision("crypto-agent", "SKIP", `CRY:${setup.symbol}`, `AI: ${ai.conviction} — ${ai.reasoning}. Final confidence: ${adjustedConfidence}`, Math.round(adjustedConfidence / 20));
        details.push(`[crypto-agent] AI KILLED ${setup.symbol}: ${ai.conviction} — ${ai.reasoning}`);
        continue;
      }

      // ── 8. Calculate position size ──
      const riskDollars = config.simulatedEquity * (config.riskPerTradePct / 100);
      const riskPerUnit = Math.abs(setup.price - setup.stopPrice);
      if (riskPerUnit <= 0) continue;

      // For crypto, we can use notional (dollar amount) instead of qty
      const notionalSize = riskDollars / (riskPerUnit / setup.price);
      const qty = (notionalSize / setup.price).toFixed(6);

      details.push(`[crypto-agent] EXECUTING ${setup.symbol} ${setup.direction}: ${qty} @ $${setup.price.toFixed(2)} | AI: ${ai.conviction} | Conf: ${adjustedConfidence}`);

      // ── 9. Place order ──
      try {
        const order = await placeCryptoOrder({
          symbol: setup.symbol,
          qty,
          side: setup.direction === "long" ? "buy" : "sell",
          type: "market",
        }, config.mode);

        const orderId = order.id;
        const tradeId = `${new Date().toISOString().slice(0, 10)}-CRY-${orderId.slice(-4)}`;

        // Log to DB
        await prisma.autoTradeLog.create({
          data: {
            symbol: `CRY:${setup.symbol}`,
            action: `crypto_${setup.direction}`,
            qty: parseFloat(qty),
            price: setup.price,
            reason: `[CRYPTO ${setup.symbol}] ${setup.type}: ${setup.reasoning}. AI: ${ai.conviction} — ${ai.reasoning}. Stop: $${setup.stopPrice.toFixed(2)}, Target: $${setup.targetPrice.toFixed(2)}`,
            aiScore: Math.round(adjustedConfidence),
            aiSignal: setup.direction,
            orderId: orderId,
          },
        });

        // Log to vault journal
        await logTradeToJournal(
          {
            tradeId,
            timestamp: new Date().toISOString(),
            instrument: `CRY:${setup.symbol}`,
            direction: setup.direction === "long" ? "LONG" : "SHORT",
            strategy: "crypto-day-trading",
            setupType: setup.type,
            contracts: parseFloat(qty),
            entryPrice: setup.price,
            stopPrice: setup.stopPrice,
            targetPrice: setup.targetPrice,
            conviction: Math.round(adjustedConfidence / 20),
          },
          "crypto-agent",
        );

        // Log decision
        await logDecision(
          "crypto-agent",
          "ENTRY",
          `CRY:${setup.symbol}`,
          `${setup.type}: ${setup.reasoning}. AI: ${ai.conviction}. R:R ${setup.riskReward.toFixed(1)}, Risk $${riskDollars.toFixed(0)}`,
          Math.round(adjustedConfidence / 20),
        );

        trades.push({
          symbol: setup.symbol,
          action: `crypto_${setup.direction}`,
          qty,
          price: setup.price,
          orderId,
          reason: `${setup.type} — AI: ${ai.conviction}`,
        });
      } catch (err) {
        details.push(`[crypto-agent] Order failed for ${setup.symbol}: ${err}`);
        await logDecision("crypto-agent", "SKIP", `CRY:${setup.symbol}`, `Order failed: ${err}`, 1);
      }
    }
  }

  // ── 10. Manage existing positions ──
  for (const pos of cryptoPositions) {
    try {
      const snap = await getCryptoSnapshot(pos.symbol);
      if (!snap) continue;

      const currentPrice = snap.latestTrade.p;
      const entryPrice = parseFloat(pos.avg_entry_price);
      const qty = parseFloat(pos.qty);
      const unrealizedPnl = parseFloat(pos.unrealized_pl);
      const direction = pos.side === "long" ? "long" : "short";

      // Find the opening trade for stop/target
      const openingLog = await prisma.autoTradeLog.findFirst({
        where: {
          symbol: `CRY:${pos.symbol}`,
          action: { in: ["crypto_long", "crypto_short"] },
          orderId: { not: null },
        },
        orderBy: { createdAt: "desc" },
      });

      // Parse stop/target from reason
      let stopPrice: number | null = null;
      let targetPrice: number | null = null;
      if (openingLog?.reason) {
        const stopMatch = openingLog.reason.match(/Stop:\s*\$?([\d,.]+)/);
        const targetMatch = openingLog.reason.match(/Target:\s*\$?([\d,.]+)/);
        if (stopMatch) stopPrice = parseFloat(stopMatch[1].replace(",", ""));
        if (targetMatch) targetPrice = parseFloat(targetMatch[1].replace(",", ""));
      }

      // Check if position needs to be closed
      let shouldClose = false;
      let closeReason = "";

      if (stopPrice && direction === "long" && currentPrice <= stopPrice) {
        shouldClose = true;
        closeReason = "Stop loss hit";
      } else if (stopPrice && direction === "short" && currentPrice >= stopPrice) {
        shouldClose = true;
        closeReason = "Stop loss hit";
      } else if (targetPrice && direction === "long" && currentPrice >= targetPrice) {
        shouldClose = true;
        closeReason = "Target reached";
      } else if (targetPrice && direction === "short" && currentPrice <= targetPrice) {
        shouldClose = true;
        closeReason = "Target reached";
      }

      if (shouldClose) {
        details.push(`[crypto-agent] CLOSING ${pos.symbol}: ${closeReason} @ $${currentPrice.toFixed(2)} P&L: $${unrealizedPnl.toFixed(2)}`);

        try {
          const closeOrder = await placeCryptoOrder({
            symbol: pos.symbol,
            qty: Math.abs(qty).toFixed(6),
            side: direction === "long" ? "sell" : "buy",
            type: "market",
          }, config.mode);

          const exitId = `${closeReason === "Target reached" ? "TP" : "SL"}-${Date.now().toString(36)}`;

          await logTradeToJournal(
            {
              tradeId: exitId,
              timestamp: new Date().toISOString(),
              instrument: `CRY:${pos.symbol}`,
              direction: direction === "long" ? "LONG" : "SHORT",
              strategy: "crypto-day-trading",
              setupType: closeReason === "Target reached" ? "take_profit" : "stop_loss",
              contracts: Math.abs(qty),
              entryPrice,
              stopPrice: stopPrice || 0,
              targetPrice: targetPrice || 0,
              exitPrice: currentPrice,
              pnlDollars: unrealizedPnl,
              conviction: 0,
              exitReason: closeReason,
            },
            "crypto-agent",
          );

          await prisma.autoTradeLog.create({
            data: {
              symbol: `CRY:${pos.symbol}`,
              action: closeReason === "Target reached" ? "take_profit" : "stop_loss",
              qty: Math.abs(qty),
              price: currentPrice,
              pnl: unrealizedPnl,
              reason: `[CRYPTO ${pos.symbol}] ${closeReason} — Entry: $${entryPrice.toFixed(2)}, Exit: $${currentPrice.toFixed(2)}`,
              orderId: closeOrder.id,
            },
          });

          trades.push({
            symbol: pos.symbol,
            action: closeReason === "Target reached" ? "take_profit" : "stop_loss",
            qty: Math.abs(qty).toFixed(6),
            price: currentPrice,
            orderId: closeOrder.id,
            pnl: unrealizedPnl,
            reason: closeReason,
          });
        } catch (err) {
          details.push(`[crypto-agent] Failed to close ${pos.symbol}: ${err}`);
        }
      }
    } catch (err) {
      details.push(`[crypto-agent] Error managing ${pos.symbol}: ${err}`);
    }
  }

  // ── 11. Log observation if any trades ──
  if (trades.length > 0) {
    const tradesSummary = trades.map((t) => `${t.action} ${t.symbol} @ $${t.price.toFixed(2)}${t.pnl ? ` P&L: $${t.pnl.toFixed(2)}` : ""}`).join("; ");
    await logObservation("crypto-agent", `Session: ${trades.length} actions. Regime: ${regimeResult.regime}. ${tradesSummary}`);
  }

  details.push(`[crypto-agent] Done. ${trades.length} trades, ${cryptoPositions.length} managed.`);
  return { trades, managed: cryptoPositions.length, details };
}
