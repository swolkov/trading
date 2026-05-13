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
  // Sizing — more aggressive for directional trades
  MAX_RISK_PER_TRADE_PCT: 0.02,     // Max 2% of portfolio per options trade (~$1,840 on $92k)
  MAX_TOTAL_OPTIONS_PCT: 0.25,       // Max 25% of portfolio in options
  MAX_OPTIONS_POSITIONS: 10,         // Max 10 options positions

  // Strike selection
  BULLISH_DELTA_TARGET: 0.35,        // Slightly OTM calls — good leverage
  BEARISH_DELTA_TARGET: -0.35,       // Slightly OTM puts
  SAFE_DELTA_TARGET: 0.50,           // ATM for safer trades

  // Expiry selection by timeframe
  DTE_RANGES: {
    day_trade: { min: 0, max: 2 },
    weekly: { min: 3, max: 10 },
    swing: { min: 14, max: 45 },
    position: { min: 30, max: 90 },
    leaps: { min: 180, max: 730 },
  },

  // Default expiry selection — 14-30 DTE sweet spot
  MIN_DTE: 14,                        // NEVER buy < 14 DTE (theta kills you)
  IDEAL_MIN_DTE: 14,                 // Sweet spot starts at 14 days
  IDEAL_MAX_DTE: 30,                 // Sweet spot ends at 30 days
  MAX_DTE: 45,                       // Never buy > 45 days (capital inefficient)

  // Exit rules — take money fast, cut losers faster
  PROFIT_TARGET_PCT: 0.50,           // Take full profit at +50% (was 75% — too greedy)
  PARTIAL_PROFIT_PCT: 0.25,          // Scale out 50% at +25% (was 40% — too late)
  BREAKEVEN_TRIGGER_PCT: 0.20,       // Activate breakeven stop at +20% (protect ALL winners)
  STOP_LOSS_PCT: 0.25,               // Cut FAST at -25% (don't hope, cut)
  CLOSE_BEFORE_EXPIRY_DAYS: 7,       // Close if < 7 days to expiry (don't let theta crush you)

  // IV awareness — most large-cap stocks run 30-60% IV in choppy markets
  HIGH_IV_THRESHOLD: 0.75,           // IV > 75% = truly expensive, skip unless high conviction
  LOW_IV_THRESHOLD: 0.30,            // IV < 30% = cheap, ideal time to buy options
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
  aiConfidence: number,
  conviction?: "high" | "moderate" | "gamble"
): Promise<{
  contract: OptionsContract | null;
  snapshot: OptionsSnapshot | null;
  reasoning: string;
}> {
  try {
    const type = direction === "bullish" ? "call" : "put";
    const now = new Date();

    // Conviction-based DTE selection:
    // HIGH conviction (score ±60+, conf 85%+): allow 7-21 DTE for aggressive plays
    // GAMBLE (gap stocks, momentum): 7-14 DTE, small position, big potential
    // MODERATE/default: 14-45 DTE for swing trades
    const isAggressive = conviction === "high" || conviction === "gamble";
    const minDTE = isAggressive ? 7 : OPTIONS_RULES.IDEAL_MIN_DTE;
    const maxDTE = conviction === "gamble" ? 21 : OPTIONS_RULES.MAX_DTE;

    const minExpDate = new Date(now.getTime() + minDTE * 24 * 60 * 60 * 1000);
    const maxExpDate = new Date(now.getTime() + maxDTE * 24 * 60 * 60 * 1000);
    const minExpStr = minExpDate.toISOString().split("T")[0];
    const maxExpStr = maxExpDate.toISOString().split("T")[0];

    const contracts = await getOptionsChain(symbol, undefined, type, minExpStr, maxExpStr);
    if (contracts.length === 0) {
      return { contract: null, snapshot: null, reasoning: `No ${type} contracts available (${minDTE}-${maxDTE} DTE)` };
    }

    // Separate into ideal and acceptable pools
    const idealMinDTE = isAggressive ? 7 : OPTIONS_RULES.IDEAL_MIN_DTE;
    const idealMaxDTE = conviction === "gamble" ? 14 : OPTIONS_RULES.IDEAL_MAX_DTE;
    const idealContracts = contracts.filter((c) => {
      const expDate = new Date(c.expiration_date);
      const dte = Math.floor((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return dte >= idealMinDTE && dte <= idealMaxDTE;
    });

    const candidatePool = idealContracts.length > 0 ? idealContracts : contracts;

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

    // Try top 5 closest strikes to find one with good liquidity
    const topCandidates = candidatePool.slice(0, 5);
    if (topCandidates.length === 0) {
      return { contract: null, snapshot: null, reasoning: "No suitable strike found" };
    }

    for (const candidate of topCandidates) {
      // Try to get snapshot for IV and greeks
      let snapshot: OptionsSnapshot | null = null;
      try {
        const snapshots = await getOptionsSnapshots([candidate.symbol]);
        snapshot = snapshots[candidate.symbol] || null;
      } catch {
        // snapshots not always available — proceed without
      }

      // IV check — skip if IV is extreme (>75%) and conviction is low
      if (snapshot?.impliedVolatility && snapshot.impliedVolatility > OPTIONS_RULES.HIGH_IV_THRESHOLD) {
        if (aiConfidence < 80) {
          continue; // try next strike
        }
      }

      // LIQUIDITY CHECK — bid-ask spread must be < 15%
      if (snapshot?.latestQuote) {
        const bid = snapshot.latestQuote.bp;
        const ask = snapshot.latestQuote.ap;
        if (bid > 0 && ask > 0) {
          const spread = ask - bid;
          const spreadPct = spread / ((bid + ask) / 2);
          if (spreadPct > 0.15) {
            continue; // try next strike
          }
        }
      }

      const strike = parseFloat(candidate.strike_price);
      const dte = Math.floor((new Date(candidate.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      const ivText = snapshot?.impliedVolatility ? `${(snapshot.impliedVolatility * 100).toFixed(0)}%` : "N/A";
      const deltaText = snapshot?.greeks?.delta ? snapshot.greeks.delta.toFixed(3) : "N/A";

      return {
        contract: candidate,
        snapshot,
        reasoning: `${type.toUpperCase()} $${strike.toFixed(2)} exp ${candidate.expiration_date} (${dte} DTE, IV: ${ivText}, Delta: ${deltaText})`,
      };
    }

    // All candidates failed liquidity/IV checks
    return { contract: null, snapshot: null, reasoning: `All ${topCandidates.length} strikes failed liquidity or IV checks` };
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

  // Apply per-trade max from config
  let perTradeLimit = maxRisk;
  try {
    const ptConfig = await prisma.agentConfig.findUnique({ where: { key: "per_trade_max" } });
    if (ptConfig?.value) perTradeLimit = Math.min(maxRisk, parseFloat(ptConfig.value));
  } catch { /* use default */ }

  const maxQty = Math.floor(perTradeLimit / costPerContract);
  const qty = Math.max(1, Math.min(maxQty, 5)); // 1-5 contracts

  // Final cost check
  const totalCost = costPerContract * qty;
  if (totalCost > perTradeLimit * 1.1) {
    return {
      symbol, contractSymbol: contract.symbol, type, strike,
      expiry: contract.expiration_date, qty: 0, premium: estimatedPremium,
      reasoning: `Trade too expensive: $${totalCost.toFixed(0)} exceeds per-trade limit $${perTradeLimit.toFixed(0)}`,
      orderId: null, success: false,
    };
  }

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

    const dte = Math.floor((new Date(contract.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const targetPremium = (estimatedPremium * (1 + OPTIONS_RULES.PROFIT_TARGET_PCT)).toFixed(2);
    const stopPremium = (estimatedPremium * (1 - OPTIONS_RULES.STOP_LOSS_PCT)).toFixed(2);

    return {
      symbol,
      contractSymbol: contract.symbol,
      type,
      strike,
      expiry: contract.expiration_date,
      qty,
      premium: estimatedPremium,
      reasoning: `Bought ${qty}x ${contract.symbol} @ ~$${estimatedPremium.toFixed(2)} ($${(costPerContract * qty).toFixed(2)} total risk). PLAN: Take profit at $${targetPremium} (+${(OPTIONS_RULES.PROFIT_TARGET_PCT * 100).toFixed(0)}%), stop at $${stopPremium} (-${(OPTIONS_RULES.STOP_LOSS_PCT * 100).toFixed(0)}%), ${dte} DTE. Close by ${contract.expiration_date} if OTM.`,
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

// Execute a straddle (buy call + put at same strike — bet on big move either way)
export async function executeStraddle(
  symbol: string,
  equity: number,
  aiScore: number,
  reasoning: string
): Promise<{ success: boolean; details: string }> {
  try {
    const now = new Date();
    const minExp = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const maxExp = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const contracts = await getOptionsChain(symbol, undefined, undefined, minExp, maxExp);

    // Get current price
    let currentPrice = 0;
    try {
      const snap = await getSnapshot(symbol);
      currentPrice = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
    } catch { return { success: false, details: "Could not get price" }; }

    // Find ATM call and put, 14-30 DTE
    const atmCalls = contracts.filter((c) => {
      const dte = Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return c.type === "call" && dte >= 14 && dte <= 30 &&
        Math.abs(parseFloat(c.strike_price) - currentPrice) / currentPrice < 0.02;
    });
    const atmPuts = contracts.filter((c) => {
      const dte = Math.floor((new Date(c.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return c.type === "put" && dte >= 14 && dte <= 30 &&
        Math.abs(parseFloat(c.strike_price) - currentPrice) / currentPrice < 0.02;
    });

    if (atmCalls.length === 0 || atmPuts.length === 0) {
      return { success: false, details: "No suitable ATM contracts for straddle" };
    }

    // Match same strike and expiry
    const call = atmCalls[0];
    const matchingPut = atmPuts.find((p) => p.strike_price === call.strike_price && p.expiration_date === call.expiration_date);
    if (!matchingPut) {
      return { success: false, details: "No matching put for straddle" };
    }

    const maxRisk = equity * OPTIONS_RULES.MAX_RISK_PER_TRADE_PCT;
    const qty = Math.max(1, Math.min(3, Math.floor(maxRisk / (currentPrice * 0.04 * 100)))); // rough sizing

    // Buy call
    const callOrder = await placeOrder({ symbol: call.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" });
    // Buy put
    const putOrder = await placeOrder({ symbol: matchingPut.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" });

    const strike = parseFloat(call.strike_price);
    const details = `STRADDLE: Bought ${qty}x ${call.symbol} + ${qty}x ${matchingPut.symbol} @ $${strike.toFixed(2)} exp ${call.expiration_date}. Betting on big move either direction.`;

    await prisma.autoTradeLog.create({
      data: { symbol: call.symbol, action: "buy_straddle_call", qty, price: null, reason: `[STRADDLE] ${reasoning}`, aiScore, aiSignal: "straddle", orderId: callOrder.id },
    });
    await prisma.autoTradeLog.create({
      data: { symbol: matchingPut.symbol, action: "buy_straddle_put", qty, price: null, reason: `[STRADDLE] ${reasoning}`, aiScore, aiSignal: "straddle", orderId: putOrder.id },
    });

    return { success: true, details };
  } catch (err) {
    return { success: false, details: `Straddle error: ${err}` };
  }
}

// Execute a vertical spread (bull call spread or bear put spread — defined risk)
export async function executeSpread(
  symbol: string,
  direction: "bull_call" | "bear_put",
  equity: number,
  aiScore: number,
  reasoning: string
): Promise<{ success: boolean; details: string }> {
  try {
    const type = direction === "bull_call" ? "call" : "put";
    const now = new Date();
    const minExp = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const maxExp = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const contracts = await getOptionsChain(symbol, undefined, type as "call" | "put", minExp, maxExp);

    let currentPrice = 0;
    try {
      const snap = await getSnapshot(symbol);
      currentPrice = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
    } catch { return { success: false, details: "Could not get price" }; }

    // All contracts already 14-30 DTE from API filter
    const validContracts = contracts
      .sort((a, b) => parseFloat(a.strike_price) - parseFloat(b.strike_price));

    if (validContracts.length < 2) {
      return { success: false, details: "Not enough contracts for spread" };
    }

    // Pick two strikes for the spread
    let buyContract: typeof validContracts[0];
    let sellContract: typeof validContracts[0];

    if (direction === "bull_call") {
      // Buy lower strike call, sell higher strike call
      const nearATM = validContracts.filter((c) => {
        const s = parseFloat(c.strike_price);
        return s >= currentPrice * 0.98 && s <= currentPrice * 1.02;
      });
      if (nearATM.length === 0) return { success: false, details: "No ATM strikes" };
      buyContract = nearATM[0];
      const higherStrikes = validContracts.filter((c) =>
        parseFloat(c.strike_price) > parseFloat(buyContract.strike_price) &&
        c.expiration_date === buyContract.expiration_date
      );
      if (higherStrikes.length === 0) return { success: false, details: "No higher strike for spread" };
      sellContract = higherStrikes[0]; // next strike up
    } else {
      // Buy higher strike put, sell lower strike put
      const nearATM = validContracts.filter((c) => {
        const s = parseFloat(c.strike_price);
        return s >= currentPrice * 0.98 && s <= currentPrice * 1.02;
      });
      if (nearATM.length === 0) return { success: false, details: "No ATM strikes" };
      buyContract = nearATM[nearATM.length - 1];
      const lowerStrikes = validContracts.filter((c) =>
        parseFloat(c.strike_price) < parseFloat(buyContract.strike_price) &&
        c.expiration_date === buyContract.expiration_date
      );
      if (lowerStrikes.length === 0) return { success: false, details: "No lower strike for spread" };
      sellContract = lowerStrikes[lowerStrikes.length - 1]; // next strike down
    }

    const qty = Math.max(1, Math.min(3, Math.floor((equity * OPTIONS_RULES.MAX_RISK_PER_TRADE_PCT) / (currentPrice * 0.02 * 100))));

    // Execute both legs
    const buyOrder = await placeOrder({ symbol: buyContract.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" });
    const sellOrder = await placeOrder({ symbol: sellContract.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });

    const buyStrike = parseFloat(buyContract.strike_price);
    const sellStrike = parseFloat(sellContract.strike_price);
    const details = `${direction.toUpperCase()} SPREAD: Buy $${buyStrike.toFixed(2)} / Sell $${sellStrike.toFixed(2)} ${type} x${qty} exp ${buyContract.expiration_date}. Defined risk trade.`;

    await prisma.autoTradeLog.create({
      data: { symbol: buyContract.symbol, action: `spread_buy_${type}`, qty, price: null, reason: `[SPREAD] ${reasoning}`, aiScore, aiSignal: direction, orderId: buyOrder.id },
    });
    await prisma.autoTradeLog.create({
      data: { symbol: sellContract.symbol, action: `spread_sell_${type}`, qty, price: null, reason: `[SPREAD] ${reasoning}`, aiScore, aiSignal: direction, orderId: sellOrder.id },
    });

    return { success: true, details };
  } catch (err) {
    return { success: false, details: `Spread error: ${err}` };
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

    // Track if we already took partial profit
    const hasOptPartial = await prisma.autoTradeLog.count({
      where: { symbol: pos.symbol, action: "partial_profit" },
    });

    // Track if this position ever reached the breakeven trigger (persisted via DB flag)
    const hasReachedBreakeven = await prisma.autoTradeLog.count({
      where: { symbol: pos.symbol, action: "breakeven_activated" },
    });

    // ── TAKE PROFIT: full exit at target ──
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

    // ── SCALE OUT: sell 50% at +25% to lock in real profit ──
    if (pnlPct >= OPTIONS_RULES.PARTIAL_PROFIT_PCT && hasOptPartial === 0 && qty >= 2) {
      const sellQty = Math.max(1, Math.floor(qty / 2));
      try {
        const order = await placeOrder({ symbol: pos.symbol, qty: String(sellQty), side: "sell", type: "market", time_in_force: "day" });
        await prisma.autoTradeLog.create({
          data: {
            symbol: pos.symbol,
            action: "partial_profit",
            qty: sellQty,
            price: parseFloat(pos.current_price),
            reason: `Options scale-out: sold ${sellQty}/${qty} at +${(pnlPct * 100).toFixed(1)}%. Locked in $${(parseFloat(pos.unrealized_pl) * (sellQty / qty)).toFixed(0)}. Remainder trails.`,
            pnl: parseFloat(pos.unrealized_pl) * (sellQty / qty),
            orderId: order.id,
          },
        });
        actions.push({ action: "partial_profit", symbol: pos.symbol, reason: `Sold ${sellQty}/${qty} at +${(pnlPct * 100).toFixed(1)}%` });
      } catch { /* ignore */ }
      continue;
    }

    // ── BREAKEVEN ACTIVATION: mark position as protected at +20% ──
    if (pnlPct >= OPTIONS_RULES.BREAKEVEN_TRIGGER_PCT && hasReachedBreakeven === 0) {
      try {
        await prisma.autoTradeLog.create({
          data: {
            symbol: pos.symbol,
            action: "breakeven_activated",
            qty,
            price: parseFloat(pos.current_price),
            reason: `Options breakeven activated at +${(pnlPct * 100).toFixed(1)}% — will close if returns to 0%`,
            pnl: null,
            orderId: null,
          },
        });
        actions.push({ action: "breakeven_activated", symbol: pos.symbol, reason: `+${(pnlPct * 100).toFixed(1)}% — breakeven protection on` });
      } catch { /* ignore */ }
      continue;
    }

    // ── BREAKEVEN STOP: position was up 20%+ and came back to 0% ──
    if ((hasReachedBreakeven > 0 || hasOptPartial > 0) && pnlPct <= 0.02) {
      try {
        const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
        await prisma.autoTradeLog.create({
          data: {
            symbol: pos.symbol,
            action: "breakeven_stop",
            qty,
            price: parseFloat(pos.current_price),
            reason: `Options breakeven stop: was up ${hasOptPartial > 0 ? "(partial taken)" : "20%+"}, now at ${(pnlPct * 100).toFixed(1)}%. Protecting capital.`,
            pnl: parseFloat(pos.unrealized_pl),
            orderId: order.id,
          },
        });
        actions.push({ action: "breakeven_stop", symbol: pos.symbol, reason: `${(pnlPct * 100).toFixed(1)}% — breakeven triggered` });
      } catch { /* ignore */ }
      continue;
    }

    // DEAD MONEY: options held > 7 days with < 10% movement and DTE burning
    if (dte <= 21 && dte > OPTIONS_RULES.CLOSE_BEFORE_EXPIRY_DAYS && Math.abs(pnlPct) < 0.10) {
      // Check how long we've held this
      const optBuy = await prisma.autoTradeLog.findFirst({
        where: { symbol: pos.symbol, action: { in: ["buy_call", "buy_put", "quick_call", "quick_put"] } },
        orderBy: { createdAt: "desc" },
      });
      const optHoldDays = optBuy ? (Date.now() - new Date(optBuy.createdAt).getTime()) / (1000 * 60 * 60 * 24) : 0;

      if (optHoldDays > 7) {
        try {
          const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
          await prisma.autoTradeLog.create({
            data: {
              symbol: pos.symbol,
              action: "dead_money",
              qty,
              price: parseFloat(pos.current_price),
              reason: `Options dead money: held ${optHoldDays.toFixed(0)} days, only ${(pnlPct * 100).toFixed(1)}% move, ${dte} DTE remaining. Theta eating premium.`,
              pnl: parseFloat(pos.unrealized_pl),
              orderId: order.id,
            },
          });
          actions.push({ action: "dead_money", symbol: pos.symbol, reason: `${optHoldDays.toFixed(0)}d hold, ${(pnlPct * 100).toFixed(1)}%, ${dte} DTE` });
        } catch { /* ignore */ }
        continue;
      }
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

    // ROLL FORWARD — if profitable (20%+) and near expiry (<=7 DTE), roll to later expiration
    if (pnlPct >= 0.20 && dte <= 7) {
      try {
        // Parse underlying symbol and option type from OCC symbol (e.g., TSLA260522P00385000)
        const occMatch = pos.symbol.match(/^([A-Z]+)\d{6}([CP])(\d{8})$/);
        if (occMatch) {
          const underlying = occMatch[1];
          const optType: "call" | "put" = occMatch[2] === "C" ? "call" : "put";
          const strike = parseInt(occMatch[3]) / 1000;

          // Find same-strike contract 14-30 DTE out
          const rollMinDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
          const rollMaxDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
          const rollCandidates = await getOptionsChain(underlying, undefined, optType, rollMinDate, rollMaxDate);

          const sameStrike = rollCandidates.find((c) => Math.abs(parseFloat(c.strike_price) - strike) < 0.5);

          if (sameStrike) {
            // Sell current, buy new
            const sellOrder = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
            const buyOrder = await placeOrder({ symbol: sameStrike.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" });

            await prisma.autoTradeLog.create({
              data: {
                symbol: pos.symbol,
                action: "roll_forward",
                qty,
                price: parseFloat(pos.current_price),
                reason: `Rolled ${pos.symbol} → ${sameStrike.symbol} (${dte} DTE → ${sameStrike.expiration_date}, +${(pnlPct * 100).toFixed(1)}% profit locked, continuing thesis)`,
                pnl: parseFloat(pos.unrealized_pl),
                orderId: sellOrder.id,
              },
            });
            actions.push({ action: "roll_forward", symbol: pos.symbol, reason: `→ ${sameStrike.symbol}, +${(pnlPct * 100).toFixed(1)}%` });
            continue;
          }
        }
      } catch { /* roll failed, fall through to other checks */ }
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
