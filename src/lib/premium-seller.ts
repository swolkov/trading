import {
  getOptionsChain,
  getOptionsSnapshots,
  getSnapshot,
  placeOrder,
  getBars,
  type OptionsContract,
} from "./alpaca";
import { getHistoricalBars } from "./yahoo";
import { prisma } from "./db";

// ============ PREMIUM SELLING STRATEGIES ============
// In choppy markets, SELL premium — time decay works FOR you.
// These strategies profit when stocks do NOTHING (which is most of the time).

const PREMIUM_RULES = {
  // Strike selection — sell at ~30 delta (~70% probability of profit)
  SHORT_DELTA_TARGET: 0.30,

  // Spread width — SCALES with account size
  // $5k account = $2.50 wide, $50k = $5 wide, $100k+ = $10 wide
  SPREAD_WIDTH_MIN: 2.50,
  SPREAD_WIDTH_MAX: 10.00,

  // DTE
  MIN_DTE: 14,
  IDEAL_DTE: 30,
  MAX_DTE: 45,

  // Exit rules
  TAKE_PROFIT_PCT: 0.50,        // Close at 50% of max profit (don't get greedy)
  STOP_LOSS_MULTIPLIER: 2.0,    // Close if loss = 2x the credit received
  CLOSE_AT_DTE: 7,              // Close if < 7 DTE regardless

  // Sizing — everything scales with equity
  MAX_RISK_PER_TRADE: 0.02,     // 2% of portfolio per trade (scales automatically)
  MAX_PREMIUM_POSITIONS: 6,     // Max 6 premium-selling positions
};

export interface PremiumTradeResult {
  symbol: string;
  strategy: string;
  shortStrike: number;
  longStrike: number;
  credit: number;
  maxRisk: number;
  qty: number;
  dte: number;
  details: string;
  success: boolean;
}

// ============ SELL IRON CONDOR ON INDEX (SPY/QQQ) ============
// Best strategy in choppy markets — profit if index stays in a range

// Dynamic spread width based on account size
function getSpreadWidth(equity: number): number {
  // $5k = $2.50, $25k = $5, $50k = $7.50, $100k+ = $10
  const width = Math.max(
    PREMIUM_RULES.SPREAD_WIDTH_MIN,
    Math.min(PREMIUM_RULES.SPREAD_WIDTH_MAX, equity / 10000)
  );
  // Round to nearest $2.50
  return Math.round(width / 2.5) * 2.5;
}

// Dynamic contract count based on account size and risk
function getContractCount(equity: number, maxRiskPerContract: number): number {
  const maxTotalRisk = equity * PREMIUM_RULES.MAX_RISK_PER_TRADE;
  return Math.max(1, Math.min(5, Math.floor(maxTotalRisk / maxRiskPerContract)));
}

export async function sellIronCondor(
  symbol: string, // "SPY" or "QQQ"
  equity: number
): Promise<PremiumTradeResult> {
  try {
    const snap = await getSnapshot(symbol);
    const price = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
    if (price <= 0) return fail(symbol, "iron_condor", "Could not get price");

    // Calculate range — sell puts below support, calls above resistance
    // Use recent ATR to determine the range
    let bars: { t: string; o: number; h: number; l: number; c: number; v: number }[] = [];
    try { bars = await getBars(symbol, "1Day"); } catch { bars = []; }
    if (bars.length < 20) { try { bars = await getHistoricalBars(symbol, 60); } catch { bars = []; } }
    if (bars.length < 20) return fail(symbol, "iron_condor", "Insufficient history");

    const atr14 = calculateATR(bars.slice(-15));
    const rangeLow = price - atr14 * 2;  // 2 ATR below = ~95% probability
    const rangeHigh = price + atr14 * 2;  // 2 ATR above

    const now = new Date();
    const minExp = new Date(now.getTime() + PREMIUM_RULES.MIN_DTE * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const maxExp = new Date(now.getTime() + PREMIUM_RULES.MAX_DTE * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // Get all contracts in our DTE range
    const allContracts = await getOptionsChain(symbol, undefined, undefined, minExp, maxExp);
    if (allContracts.length === 0) return fail(symbol, "iron_condor", "No contracts available");

    const puts = allContracts.filter((c) => c.type === "put");
    const calls = allContracts.filter((c) => c.type === "call");

    // Find the best expiration (closest to 30 DTE)
    const expirations = [...new Set(allContracts.map((c) => c.expiration_date))].sort();
    const targetDate = new Date(now.getTime() + PREMIUM_RULES.IDEAL_DTE * 24 * 60 * 60 * 1000);
    const bestExpiry = expirations.reduce((best, exp) =>
      Math.abs(new Date(exp).getTime() - targetDate.getTime()) < Math.abs(new Date(best).getTime() - targetDate.getTime()) ? exp : best
    );

    const expiryPuts = puts.filter((c) => c.expiration_date === bestExpiry);
    const expiryCalls = calls.filter((c) => c.expiration_date === bestExpiry);

    // PUT SIDE: sell put near rangeLow, buy put below it
    const shortPut = findClosestStrike(expiryPuts, rangeLow);
    const longPutStrike = parseFloat(shortPut?.strike_price || "0") - getSpreadWidth(equity);
    const longPut = findClosestStrike(expiryPuts, longPutStrike);

    // CALL SIDE: sell call near rangeHigh, buy call above it
    const shortCall = findClosestStrike(expiryCalls, rangeHigh);
    const longCallStrike = parseFloat(shortCall?.strike_price || "0") + getSpreadWidth(equity);
    const longCall = findClosestStrike(expiryCalls, longCallStrike);

    if (!shortPut || !longPut || !shortCall || !longCall) {
      return fail(symbol, "iron_condor", "Could not find all 4 legs");
    }

    // Get snapshots for premium estimation
    const syms = [shortPut.symbol, longPut.symbol, shortCall.symbol, longCall.symbol];
    let totalCredit = 0;
    try {
      const snapshots = await getOptionsSnapshots(syms);
      const spMid = getMidPrice(snapshots[shortPut.symbol]);
      const lpMid = getMidPrice(snapshots[longPut.symbol]);
      const scMid = getMidPrice(snapshots[shortCall.symbol]);
      const lcMid = getMidPrice(snapshots[longCall.symbol]);
      totalCredit = (spMid - lpMid) + (scMid - lcMid);
    } catch {
      totalCredit = price * 0.005; // rough estimate: 0.5% of stock price
    }

    if (totalCredit <= 0.10) return fail(symbol, "iron_condor", `Credit too small ($${totalCredit.toFixed(2)})`);

    // Calculate max risk and size the trade
    const spreadWidth = Math.max(
      Math.abs(parseFloat(shortPut.strike_price) - parseFloat(longPut.strike_price)),
      Math.abs(parseFloat(shortCall.strike_price) - parseFloat(longCall.strike_price))
    );
    const maxRiskPerContract = (spreadWidth - totalCredit) * 100;
    const qty = getContractCount(equity, maxRiskPerContract);

    const dte = Math.floor((new Date(bestExpiry).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    // Execute legs in safe order: BUY protective wings FIRST, then SELL short legs
    // This prevents Alpaca from rejecting sells as "uncovered" options
    const buyOrders = await Promise.all([
      placeOrder({ symbol: longPut.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" }),
      placeOrder({ symbol: longCall.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" }),
    ]);
    // Wait a moment for buys to fill before selling
    await new Promise((r) => setTimeout(r, 2000));
    const sellOrders = await Promise.all([
      placeOrder({ symbol: shortPut.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" }),
      placeOrder({ symbol: shortCall.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" }),
    ]);
    const orders = [...buyOrders, ...sellOrders];

    const spStrike = parseFloat(shortPut.strike_price);
    const lpStrike = parseFloat(longPut.strike_price);
    const scStrike = parseFloat(shortCall.strike_price);
    const lcStrike = parseFloat(longCall.strike_price);

    const details = `IRON CONDOR on ${symbol} @ $${price.toFixed(2)}: Sell $${spStrike}/$${lpStrike} puts + Sell $${scStrike}/$${lcStrike} calls x${qty}. Exp ${bestExpiry} (${dte} DTE). Credit ~$${(totalCredit * qty * 100).toFixed(0)}. Max risk $${(maxRiskPerContract * qty).toFixed(0)}. Profit if ${symbol} stays between $${spStrike.toFixed(0)}-$${scStrike.toFixed(0)}.`;

    await prisma.autoTradeLog.create({
      data: { symbol, action: "iron_condor", qty: qty * 4, price: totalCredit, reason: details, aiScore: null, aiSignal: "neutral", orderId: orders[0].id },
    });

    return {
      symbol, strategy: "iron_condor",
      shortStrike: spStrike, longStrike: scStrike,
      credit: totalCredit * qty * 100, maxRisk: maxRiskPerContract * qty,
      qty, dte, details, success: true,
    };
  } catch (err) {
    return fail(symbol, "iron_condor", `Error: ${err}`);
  }
}

// ============ SELL CREDIT SPREAD ON INDIVIDUAL STOCK ============
// Sell premium at a level the stock is unlikely to reach

export async function sellCreditSpread(
  symbol: string,
  direction: "bull_put" | "bear_call", // bull_put = bullish (sell put below), bear_call = bearish (sell call above)
  equity: number
): Promise<PremiumTradeResult> {
  try {
    const snap = await getSnapshot(symbol);
    const price = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
    if (price <= 0) return fail(symbol, "credit_spread", "Could not get price");

    let bars: { t: string; o: number; h: number; l: number; c: number; v: number }[] = [];
    try { bars = await getBars(symbol, "1Day"); } catch { bars = []; }
    if (bars.length < 20) { try { bars = await getHistoricalBars(symbol, 60); } catch { bars = []; } }
    if (bars.length < 20) return fail(symbol, "credit_spread", "Insufficient history");

    const atr14 = calculateATR(bars.slice(-15));
    const type = direction === "bull_put" ? "put" : "call";

    // Short strike: 2 ATR away from current price (~95% probability of profit)
    const shortStrikeTarget = direction === "bull_put"
      ? price - atr14 * 2   // sell put below
      : price + atr14 * 2;  // sell call above

    const now = new Date();
    const minExp = new Date(now.getTime() + PREMIUM_RULES.MIN_DTE * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const maxExp = new Date(now.getTime() + PREMIUM_RULES.MAX_DTE * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const contracts = await getOptionsChain(symbol, undefined, type as "call" | "put", minExp, maxExp);
    if (contracts.length === 0) return fail(symbol, "credit_spread", `No ${type} contracts`);

    // Find best expiry closest to 30 DTE
    const expirations = [...new Set(contracts.map((c) => c.expiration_date))].sort();
    const targetDate = new Date(now.getTime() + PREMIUM_RULES.IDEAL_DTE * 24 * 60 * 60 * 1000);
    const bestExpiry = expirations.reduce((best, exp) =>
      Math.abs(new Date(exp).getTime() - targetDate.getTime()) < Math.abs(new Date(best).getTime() - targetDate.getTime()) ? exp : best
    );
    const expiryContracts = contracts.filter((c) => c.expiration_date === bestExpiry);

    // Find short and long strikes
    const shortContract = findClosestStrike(expiryContracts, shortStrikeTarget);
    if (!shortContract) return fail(symbol, "credit_spread", "No suitable short strike");

    const spreadWidth = getSpreadWidth(equity);
    const longStrikeTarget = direction === "bull_put"
      ? parseFloat(shortContract.strike_price) - spreadWidth
      : parseFloat(shortContract.strike_price) + spreadWidth;
    const longContract = findClosestStrike(expiryContracts, longStrikeTarget);
    if (!longContract) return fail(symbol, "credit_spread", "No suitable long strike");

    // Estimate credit
    let credit = 0;
    try {
      const snapshots = await getOptionsSnapshots([shortContract.symbol, longContract.symbol]);
      const shortMid = getMidPrice(snapshots[shortContract.symbol]);
      const longMid = getMidPrice(snapshots[longContract.symbol]);
      credit = shortMid - longMid;
    } catch {
      credit = price * 0.003;
    }

    if (credit <= 0.05) return fail(symbol, "credit_spread", `Credit too small ($${credit.toFixed(2)})`);

    const actualWidth = Math.abs(parseFloat(shortContract.strike_price) - parseFloat(longContract.strike_price));
    const maxRiskPerContract = (actualWidth - credit) * 100;
    const qty = getContractCount(equity, maxRiskPerContract);

    const dte = Math.floor((new Date(bestExpiry).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    // Execute legs safely: BUY protective wing first, then SELL short leg
    const longOrder = await placeOrder({ symbol: longContract.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" });
    await new Promise((r) => setTimeout(r, 1000));
    const shortOrder = await placeOrder({ symbol: shortContract.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });

    const sStrike = parseFloat(shortContract.strike_price);
    const lStrike = parseFloat(longContract.strike_price);
    const dirText = direction === "bull_put" ? "BULL PUT" : "BEAR CALL";
    const profitCondition = direction === "bull_put" ? `stays above $${sStrike.toFixed(0)}` : `stays below $${sStrike.toFixed(0)}`;

    const details = `${dirText} CREDIT SPREAD on ${symbol}: Sell $${sStrike}/${lStrike} ${type} x${qty}. Exp ${bestExpiry} (${dte} DTE). Credit ~$${(credit * qty * 100).toFixed(0)}. Max risk $${(maxRiskPerContract * qty).toFixed(0)}. Profit if ${symbol} ${profitCondition}. ~70% probability of profit.`;

    await prisma.autoTradeLog.create({
      data: { symbol, action: `sell_${direction}`, qty: qty * 2, price: credit, reason: details, aiScore: null, aiSignal: direction, orderId: shortOrder.id },
    });

    return {
      symbol, strategy: `sell_${direction}`,
      shortStrike: sStrike, longStrike: lStrike,
      credit: credit * qty * 100, maxRisk: maxRiskPerContract * qty,
      qty, dte, details, success: true,
    };
  } catch (err) {
    return fail(symbol, "credit_spread", `Error: ${err}`);
  }
}

// ============ HELPERS ============

function calculateATR(bars: { h: number; l: number; c: number }[]): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function findClosestStrike(contracts: OptionsContract[], target: number): OptionsContract | null {
  if (contracts.length === 0) return null;
  return contracts.reduce((best, c) =>
    Math.abs(parseFloat(c.strike_price) - target) < Math.abs(parseFloat(best.strike_price) - target) ? c : best
  );
}

function getMidPrice(snapshot: { latestQuote?: { bp: number; ap: number }; latestTrade?: { p: number } } | undefined): number {
  if (!snapshot) return 0;
  if (snapshot.latestQuote && snapshot.latestQuote.bp > 0 && snapshot.latestQuote.ap > 0) {
    return (snapshot.latestQuote.bp + snapshot.latestQuote.ap) / 2;
  }
  return snapshot.latestTrade?.p || 0;
}

// ============ PREMIUM SELLING DEFENSE ============
// When a short strike is being tested (price within 1 ATR), defend the position:
// 1. Roll the tested side out in time for more credit
// 2. Close the winning side early if it's worth < 10% of original credit
// 3. Close the whole position if loss > 2x credit

export interface PremiumDefenseAction {
  symbol: string;
  action: "roll_out" | "close_winning_side" | "close_all" | "hold";
  details: string;
  success: boolean;
}

export async function defendPremiumPosition(
  position: { symbol: string; qty: string; avg_entry_price: string; current_price: string; unrealized_pl: string },
  equity: number
): Promise<PremiumDefenseAction> {
  const pnlPct = parseFloat(position.unrealized_pl) / (parseFloat(position.avg_entry_price) * parseInt(position.qty) * 100);
  const qty = Math.abs(parseInt(position.qty));

  // Parse the OCC symbol to get underlying, expiry, type, strike
  const occMatch = position.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!occMatch) {
    return { symbol: position.symbol, action: "hold", details: "Could not parse OCC symbol", success: false };
  }

  const underlying = occMatch[1];
  const dateStr = occMatch[2];
  const optType = occMatch[3] === "C" ? "call" : "put";
  const strike = parseInt(occMatch[4]) / 1000;

  const year = 2000 + parseInt(dateStr.slice(0, 2));
  const month = parseInt(dateStr.slice(2, 4)) - 1;
  const day = parseInt(dateStr.slice(4, 6));
  const expiry = new Date(year, month, day);
  const now = new Date();
  const dte = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  // Get current underlying price
  let underlyingPrice = 0;
  try {
    const snap = await getSnapshot(underlying);
    underlyingPrice = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
  } catch {
    return { symbol: position.symbol, action: "hold", details: "Could not get underlying price", success: false };
  }

  // Check if short strike is being tested
  const distanceToStrike = Math.abs(underlyingPrice - strike) / underlyingPrice;
  const isTested = distanceToStrike < 0.02; // within 2% of strike

  // CLOSE ALL: if loss > 2x the original credit (estimated from entry price)
  const entryCredit = parseFloat(position.avg_entry_price);
  const currentValue = parseFloat(position.current_price);
  if (currentValue > entryCredit * PREMIUM_RULES.STOP_LOSS_MULTIPLIER) {
    try {
      const side = parseInt(position.qty) < 0 ? "buy" : "sell"; // close short = buy, close long = sell
      const order = await placeOrder({ symbol: position.symbol, qty: String(qty), side, type: "market", time_in_force: "day" });
      await prisma.autoTradeLog.create({
        data: {
          symbol: position.symbol, action: "premium_defense_close", qty, price: currentValue,
          reason: `Premium defense: loss exceeds 2x credit ($${currentValue.toFixed(2)} vs entry $${entryCredit.toFixed(2)}). Cutting loss.`,
          pnl: parseFloat(position.unrealized_pl), orderId: order.id,
        },
      });
      return { symbol: position.symbol, action: "close_all", details: `Closed — loss exceeded 2x credit`, success: true };
    } catch (err) {
      return { symbol: position.symbol, action: "close_all", details: `Failed to close: ${err}`, success: false };
    }
  }

  // CLOSE WINNING SIDE: if position is worth < 10% of original credit (nearly max profit)
  if (currentValue < entryCredit * 0.10 && currentValue > 0) {
    try {
      const side = parseInt(position.qty) < 0 ? "buy" : "sell";
      const order = await placeOrder({ symbol: position.symbol, qty: String(qty), side, type: "market", time_in_force: "day" });
      await prisma.autoTradeLog.create({
        data: {
          symbol: position.symbol, action: "premium_take_profit", qty, price: currentValue,
          reason: `Premium near max profit: worth $${currentValue.toFixed(2)} (${((1 - currentValue / entryCredit) * 100).toFixed(0)}% of max). Closing winner.`,
          pnl: parseFloat(position.unrealized_pl), orderId: order.id,
        },
      });
      return { symbol: position.symbol, action: "close_winning_side", details: `Closed at ${((1 - currentValue / entryCredit) * 100).toFixed(0)}% max profit`, success: true };
    } catch (err) {
      return { symbol: position.symbol, action: "close_winning_side", details: `Failed: ${err}`, success: false };
    }
  }

  // ROLL OUT: if strike is being tested and DTE < 14, roll to later expiration
  if (isTested && dte < 14 && parseInt(position.qty) < 0) { // only roll short positions
    try {
      // Find same-strike contract 21-45 DTE out
      const rollMinDate = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const rollMaxDate = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const rollCandidates = await getOptionsChain(underlying, undefined, optType as "call" | "put", rollMinDate, rollMaxDate);
      const sameStrike = rollCandidates.find((c) => Math.abs(parseFloat(c.strike_price) - strike) < 1);

      if (sameStrike) {
        // Close current (buy back short), open new (sell further out)
        const buyBackOrder = await placeOrder({ symbol: position.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" });
        await new Promise((r) => setTimeout(r, 1000));
        const rollOrder = await placeOrder({ symbol: sameStrike.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });

        await prisma.autoTradeLog.create({
          data: {
            symbol: position.symbol, action: "premium_roll", qty, price: currentValue,
            reason: `Premium defense: rolled ${position.symbol} → ${sameStrike.symbol}. Strike $${strike} tested (price $${underlyingPrice.toFixed(2)}). Extended to ${sameStrike.expiration_date} for more time premium.`,
            pnl: null, orderId: buyBackOrder.id,
          },
        });

        return {
          symbol: position.symbol, action: "roll_out",
          details: `Rolled to ${sameStrike.expiration_date} — strike tested at $${underlyingPrice.toFixed(2)}`, success: true,
        };
      }
    } catch {
      // roll failed
    }
  }

  // HOLD: position is fine
  const status = isTested ? `WATCH: strike $${strike} being tested (price $${underlyingPrice.toFixed(2)})` : "OK";
  return { symbol: position.symbol, action: "hold", details: `${status}, ${dte} DTE, P&L ${(pnlPct * 100).toFixed(1)}%`, success: true };
}

function fail(symbol: string, strategy: string, details: string): PremiumTradeResult {
  return { symbol, strategy, shortStrike: 0, longStrike: 0, credit: 0, maxRisk: 0, qty: 0, dte: 0, details, success: false };
}
