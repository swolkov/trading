import {
  getOptionsChain,
  getOptionsSnapshots,
  getSnapshot,
  placeOrder,
  type OptionsContract,
  type OptionsSnapshot,
} from "./alpaca";
import { prisma } from "./db";

// ============ OPTIONS TRADING RULES ============
const OPTIONS_RULES = {
  // Sizing
  MAX_RISK_PER_TRADE_PCT: 0.015,    // Max 1.5% of portfolio per options trade
  MAX_TOTAL_OPTIONS_PCT: 0.10,       // Max 10% of portfolio in options
  MAX_OPTIONS_POSITIONS: 6,          // Max 6 options positions at once

  // Strike selection
  BULLISH_DELTA_TARGET: 0.35,        // Slightly OTM calls — good leverage
  BEARISH_DELTA_TARGET: -0.35,       // Slightly OTM puts
  SAFE_DELTA_TARGET: 0.50,           // ATM for safer trades

  // Expiry selection
  MIN_DTE: 7,                        // Never buy < 7 days to expiry
  IDEAL_MIN_DTE: 14,                 // Prefer 14+ days
  IDEAL_MAX_DTE: 45,                 // Prefer < 45 days
  MAX_DTE: 60,                       // Never buy > 60 days

  // Exit rules
  PROFIT_TARGET_PCT: 0.75,           // Take profit at +75%
  STOP_LOSS_PCT: 0.40,               // Cut at -40%
  CLOSE_BEFORE_EXPIRY_DAYS: 5,       // Close if < 5 days to expiry and OTM

  // IV awareness
  HIGH_IV_THRESHOLD: 0.50,           // IV > 50% = expensive, be cautious
  LOW_IV_THRESHOLD: 0.25,            // IV < 25% = cheap, good to buy
};

export interface OptionsTradeResult {
  symbol: string;
  contractSymbol: string;
  type: "call" | "put";
  strike: number;
  expiry: string;
  qty: number;
  premium: number | null;
  reasoning: string;
  orderId: string | null;
  success: boolean;
}

// Find the best options contract for a trade
export async function findBestContract(
  symbol: string,
  direction: "bullish" | "bearish",
  stockPrice: number,
  aiConfidence: number
): Promise<{
  contract: OptionsContract | null;
  snapshot: OptionsSnapshot | null;
  reasoning: string;
}> {
  try {
    const type = direction === "bullish" ? "call" : "put";

    // Get all contracts
    const contracts = await getOptionsChain(symbol, undefined, type);
    if (contracts.length === 0) {
      return { contract: null, snapshot: null, reasoning: "No options contracts available" };
    }

    // Filter by DTE
    const now = new Date();
    const validContracts = contracts.filter((c) => {
      const expDate = new Date(c.expiration_date);
      const dte = Math.floor((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return dte >= OPTIONS_RULES.MIN_DTE && dte <= OPTIONS_RULES.MAX_DTE;
    });

    if (validContracts.length === 0) {
      return { contract: null, snapshot: null, reasoning: "No contracts in valid DTE range (7-60 days)" };
    }

    // Prefer ideal DTE range (14-45 days)
    const idealContracts = validContracts.filter((c) => {
      const expDate = new Date(c.expiration_date);
      const dte = Math.floor((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return dte >= OPTIONS_RULES.IDEAL_MIN_DTE && dte <= OPTIONS_RULES.IDEAL_MAX_DTE;
    });

    const candidatePool = idealContracts.length > 0 ? idealContracts : validContracts;

    // Select strike based on direction and confidence
    // Higher confidence = closer to ATM (more expensive but higher probability)
    // Lower confidence = more OTM (cheaper, lottery ticket)
    let targetStrike: number;
    if (direction === "bullish") {
      // OTM call: strike above current price
      const otmPct = aiConfidence > 80 ? 0.02 : aiConfidence > 60 ? 0.04 : 0.06;
      targetStrike = stockPrice * (1 + otmPct);
    } else {
      // OTM put: strike below current price
      const otmPct = aiConfidence > 80 ? 0.02 : aiConfidence > 60 ? 0.04 : 0.06;
      targetStrike = stockPrice * (1 - otmPct);
    }

    // Find contract closest to target strike
    candidatePool.sort((a, b) =>
      Math.abs(parseFloat(a.strike_price) - targetStrike) -
      Math.abs(parseFloat(b.strike_price) - targetStrike)
    );

    // Take the best match
    const bestContract = candidatePool[0];
    if (!bestContract) {
      return { contract: null, snapshot: null, reasoning: "No suitable strike found" };
    }

    // Try to get snapshot for IV and greeks
    let snapshot: OptionsSnapshot | null = null;
    try {
      const snapshots = await getOptionsSnapshots([bestContract.symbol]);
      snapshot = snapshots[bestContract.symbol] || null;
    } catch {
      // snapshots not always available
    }

    // IV check — skip if IV is too high (expensive options)
    if (snapshot?.impliedVolatility && snapshot.impliedVolatility > OPTIONS_RULES.HIGH_IV_THRESHOLD) {
      // Still allow if AI confidence is very high
      if (aiConfidence < 80) {
        return {
          contract: null,
          snapshot,
          reasoning: `IV too high (${(snapshot.impliedVolatility * 100).toFixed(0)}% > ${OPTIONS_RULES.HIGH_IV_THRESHOLD * 100}%) — options are expensive`,
        };
      }
    }

    const strike = parseFloat(bestContract.strike_price);
    const dte = Math.floor((new Date(bestContract.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const ivText = snapshot?.impliedVolatility ? `${(snapshot.impliedVolatility * 100).toFixed(0)}%` : "N/A";
    const deltaText = snapshot?.greeks?.delta ? snapshot.greeks.delta.toFixed(3) : "N/A";

    return {
      contract: bestContract,
      snapshot,
      reasoning: `${type.toUpperCase()} $${strike.toFixed(2)} exp ${bestContract.expiration_date} (${dte} DTE, IV: ${ivText}, Delta: ${deltaText})`,
    };
  } catch (err) {
    return { contract: null, snapshot: null, reasoning: `Options error: ${err}` };
  }
}

// Execute an options trade
export async function executeOptionsTrade(
  symbol: string,
  contract: OptionsContract,
  snapshot: OptionsSnapshot | null,
  equity: number,
  aiScore: number,
  aiSignal: string,
  aiReasoning: string
): Promise<OptionsTradeResult> {
  const strike = parseFloat(contract.strike_price);
  const type = contract.type;

  // Calculate position size: max 1.5% of portfolio
  const maxRisk = equity * OPTIONS_RULES.MAX_RISK_PER_TRADE_PCT;

  // Estimate premium from snapshot or approximate
  let estimatedPremium = 0;
  if (snapshot?.latestQuote) {
    estimatedPremium = (snapshot.latestQuote.ap + snapshot.latestQuote.bp) / 2;
  } else if (snapshot?.latestTrade) {
    estimatedPremium = snapshot.latestTrade.p;
  } else {
    // Rough estimate: 2-3% of stock price for ATM options
    estimatedPremium = strike * 0.025;
  }

  if (estimatedPremium <= 0) estimatedPremium = strike * 0.02;

  // Each contract = 100 shares, so cost = premium * 100 * qty
  const costPerContract = estimatedPremium * 100;
  const maxQty = Math.floor(maxRisk / costPerContract);
  const qty = Math.max(1, Math.min(maxQty, 5)); // 1-5 contracts

  try {
    const order = await placeOrder({
      symbol: contract.symbol,
      qty: String(qty),
      side: "buy",
      type: "market",
      time_in_force: "day",
    });

    // Log the trade
    await prisma.autoTradeLog.create({
      data: {
        symbol: contract.symbol,
        action: `buy_${type}`,
        qty,
        price: estimatedPremium,
        reason: `[OPTIONS ${type.toUpperCase()}] Strike: $${strike} Exp: ${contract.expiration_date}. ${aiReasoning}`,
        aiScore,
        aiSignal,
        orderId: order.id,
      },
    });

    // Store trade idea
    await prisma.tradeIdea.create({
      data: {
        symbol: contract.symbol,
        action: `buy_${type}`,
        entryPrice: estimatedPremium,
        targetPrice: estimatedPremium * (1 + OPTIONS_RULES.PROFIT_TARGET_PCT),
        stopLoss: estimatedPremium * (1 - OPTIONS_RULES.STOP_LOSS_PCT),
        reasoning: `${type.toUpperCase()} $${strike} exp ${contract.expiration_date}. AI Score: ${aiScore}. ${aiReasoning}`,
        timeframe: "swing",
        riskReward: OPTIONS_RULES.PROFIT_TARGET_PCT / OPTIONS_RULES.STOP_LOSS_PCT,
      },
    });

    return {
      symbol,
      contractSymbol: contract.symbol,
      type,
      strike,
      expiry: contract.expiration_date,
      qty,
      premium: estimatedPremium,
      reasoning: `Bought ${qty}x ${contract.symbol} @ ~$${estimatedPremium.toFixed(2)} ($${(costPerContract * qty).toFixed(2)} total risk)`,
      orderId: order.id,
      success: true,
    };
  } catch (err) {
    return {
      symbol,
      contractSymbol: contract.symbol,
      type,
      strike,
      expiry: contract.expiration_date,
      qty,
      premium: estimatedPremium,
      reasoning: `Failed to place order: ${err}`,
      orderId: null,
      success: false,
    };
  }
}

// Manage existing options positions
export async function manageOptionsPositions(
  positions: { symbol: string; qty: string; avg_entry_price: string; current_price: string; unrealized_pl: string; unrealized_plpc: string }[]
): Promise<{ action: string; symbol: string; reason: string }[]> {
  const actions: { action: string; symbol: string; reason: string }[] = [];

  for (const pos of positions) {
    // Only manage options (symbol length > 10)
    if (pos.symbol.length <= 10) continue;

    const pnlPct = parseFloat(pos.unrealized_plpc);
    const qty = Math.abs(parseInt(pos.qty));

    // Parse expiry from options symbol (e.g., AAPL260508C00280000)
    // Format: SYMBOL + YYMMDD + C/P + Strike
    const symbolMatch = pos.symbol.match(/^([A-Z]+)(\d{6})/);
    let dte = 999;
    if (symbolMatch) {
      const dateStr = symbolMatch[2];
      const year = 2000 + parseInt(dateStr.slice(0, 2));
      const month = parseInt(dateStr.slice(2, 4)) - 1;
      const day = parseInt(dateStr.slice(4, 6));
      const expiry = new Date(year, month, day);
      dte = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    }

    // TAKE PROFIT
    if (pnlPct >= OPTIONS_RULES.PROFIT_TARGET_PCT) {
      try {
        const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
        await prisma.autoTradeLog.create({
          data: {
            symbol: pos.symbol,
            action: "take_profit",
            qty,
            price: parseFloat(pos.current_price),
            reason: `Options profit target hit: +${(pnlPct * 100).toFixed(1)}% (target: +${(OPTIONS_RULES.PROFIT_TARGET_PCT * 100).toFixed(0)}%)`,
            pnl: parseFloat(pos.unrealized_pl),
            orderId: order.id,
          },
        });
        actions.push({ action: "take_profit", symbol: pos.symbol, reason: `+${(pnlPct * 100).toFixed(1)}%` });
      } catch { /* ignore */ }
      continue;
    }

    // STOP LOSS
    if (pnlPct <= -OPTIONS_RULES.STOP_LOSS_PCT) {
      try {
        const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
        await prisma.autoTradeLog.create({
          data: {
            symbol: pos.symbol,
            action: "stop_loss",
            qty,
            price: parseFloat(pos.current_price),
            reason: `Options stop loss hit: ${(pnlPct * 100).toFixed(1)}% (limit: -${(OPTIONS_RULES.STOP_LOSS_PCT * 100).toFixed(0)}%)`,
            pnl: parseFloat(pos.unrealized_pl),
            orderId: order.id,
          },
        });
        actions.push({ action: "stop_loss", symbol: pos.symbol, reason: `${(pnlPct * 100).toFixed(1)}%` });
      } catch { /* ignore */ }
      continue;
    }

    // CLOSE BEFORE EXPIRY — if < 5 DTE and losing money, close to salvage remaining value
    if (dte <= OPTIONS_RULES.CLOSE_BEFORE_EXPIRY_DAYS && pnlPct < 0) {
      try {
        const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
        await prisma.autoTradeLog.create({
          data: {
            symbol: pos.symbol,
            action: "expiry_close",
            qty,
            price: parseFloat(pos.current_price),
            reason: `Closing before expiry: ${dte} DTE remaining, position at ${(pnlPct * 100).toFixed(1)}%`,
            pnl: parseFloat(pos.unrealized_pl),
            orderId: order.id,
          },
        });
        actions.push({ action: "expiry_close", symbol: pos.symbol, reason: `${dte} DTE, ${(pnlPct * 100).toFixed(1)}%` });
      } catch { /* ignore */ }
      continue;
    }

    actions.push({ action: "hold", symbol: pos.symbol, reason: `${(pnlPct * 100).toFixed(1)}%, ${dte} DTE` });
  }

  return actions;
}
