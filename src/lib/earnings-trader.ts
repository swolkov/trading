import { getEarningsCalendar } from "./finnhub";
import { getSnapshot, placeOrder, getOptionsChain, getOptionsSnapshots } from "./alpaca";
import { getHistoricalBars } from "./yahoo";
import { analyzeVolatility } from "./options-intelligence";
import { prisma } from "./db";

// ============ EARNINGS REACTION TRADING ============
// Strategy: Trade the REACTION to earnings, not the event itself
// - Avoids IV crush (which kills options bought before earnings)
// - Trades confirmed momentum after the results are known
// - Big beat + gap up = buy calls (ride momentum)
// - Big miss + gap down = buy puts (ride momentum)

const EARNINGS_RULES = {
  MIN_SURPRISE_PCT: 5,          // Minimum EPS surprise % to trigger a trade
  BIG_SURPRISE_PCT: 15,         // Big surprise = larger position
  MIN_GAP_PCT: 2,               // Stock must gap at least 2% to confirm direction
  MAX_POSITION_PCT: 0.015,      // 1.5% of portfolio per earnings play
  PROFIT_TARGET_PCT: 0.50,      // Take profit at +50% (quick momentum trades)
  STOP_LOSS_PCT: 0.30,          // Cut at -30%
  HOLD_DAYS_MAX: 3,             // Close within 3 days — this is a momentum play
  PREFERRED_DTE_MIN: 5,         // At least 5 DTE
  PREFERRED_DTE_MAX: 14,        // No more than 2 weeks out
};

export interface EarningsPlay {
  symbol: string;
  epsActual: number;
  epsEstimate: number;
  surprisePct: number;
  gapPct: number;
  direction: "bullish" | "bearish";
  action: string;
  contractSymbol: string | null;
  qty: number;
  premium: number | null;
  reasoning: string;
  orderId: string | null;
  success: boolean;
}

export async function scanEarningsReactions(equity: number): Promise<EarningsPlay[]> {
  const results: EarningsPlay[] = [];

  try {
    // Get earnings from yesterday and today
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(today.getTime() - 48 * 60 * 60 * 1000);

    const earnings = await getEarningsCalendar(
      twoDaysAgo.toISOString().split("T")[0],
      today.toISOString().split("T")[0]
    );

    if (earnings.length === 0) return results;

    // Filter to stocks that have REPORTED (have actual EPS)
    const reported = earnings.filter((e) =>
      e.epsActual != null &&
      e.epsEstimate != null &&
      e.epsEstimate !== 0
    );

    for (const earning of reported.slice(0, 10)) {
      const symbol = earning.symbol;
      const surprisePct = ((earning.epsActual! - earning.epsEstimate!) / Math.abs(earning.epsEstimate!)) * 100;

      // Skip if surprise is too small
      if (Math.abs(surprisePct) < EARNINGS_RULES.MIN_SURPRISE_PCT) continue;

      // Check if we already traded this earnings reaction
      const existingTrade = await prisma.autoTradeLog.findFirst({
        where: {
          symbol: { contains: symbol },
          reason: { contains: "EARNINGS" },
          createdAt: { gte: yesterday },
        },
      });
      if (existingTrade) continue;

      // Get current price and check the gap
      let currentPrice: number;
      let previousClose: number;
      try {
        const snap = await getSnapshot(symbol);
        currentPrice = snap.latestTrade?.p || snap.latestQuote?.ap || 0;

        // Get previous close from historical bars
        const bars = await getHistoricalBars(symbol, 10);
        if (bars.length < 2) continue;

        // Previous close is the bar before earnings day
        previousClose = bars[bars.length - 2]?.c || 0;
      } catch {
        continue;
      }

      if (currentPrice <= 0 || previousClose <= 0) continue;

      const gapPct = ((currentPrice - previousClose) / previousClose) * 100;

      // Confirm direction: surprise and gap must agree
      const isBullish = surprisePct > 0 && gapPct > EARNINGS_RULES.MIN_GAP_PCT;
      const isBearish = surprisePct < 0 && gapPct < -EARNINGS_RULES.MIN_GAP_PCT;

      if (!isBullish && !isBearish) continue;

      const direction = isBullish ? "bullish" : "bearish";
      const optionType = isBullish ? "call" : "put";

      // Find the right options contract
      try {
        const contracts = await getOptionsChain(symbol, undefined, optionType as "call" | "put");
        const now = new Date();

        // Filter contracts: slightly OTM, 5-14 DTE
        const targetStrike = isBullish
          ? currentPrice * 1.02 // 2% OTM call
          : currentPrice * 0.98; // 2% OTM put

        const validContracts = contracts.filter((c) => {
          const expDate = new Date(c.expiration_date);
          const dte = Math.floor((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          const strikeDiff = Math.abs(parseFloat(c.strike_price) - targetStrike);
          return dte >= EARNINGS_RULES.PREFERRED_DTE_MIN &&
                 dte <= EARNINGS_RULES.PREFERRED_DTE_MAX &&
                 strikeDiff <= currentPrice * 0.03;
        });

        if (validContracts.length === 0) {
          results.push({
            symbol,
            epsActual: earning.epsActual!,
            epsEstimate: earning.epsEstimate!,
            surprisePct,
            gapPct,
            direction,
            action: "skip",
            contractSymbol: null,
            qty: 0,
            premium: null,
            reasoning: `No suitable ${optionType} contracts found (need 5-14 DTE)`,
            orderId: null,
            success: false,
          });
          continue;
        }

        // Pick closest to target strike
        validContracts.sort((a, b) =>
          Math.abs(parseFloat(a.strike_price) - targetStrike) -
          Math.abs(parseFloat(b.strike_price) - targetStrike)
        );
        const contract = validContracts[0];

        // Get premium estimate
        let premium = currentPrice * 0.02;
        try {
          const snaps = await getOptionsSnapshots([contract.symbol]);
          const snap = snaps[contract.symbol];
          if (snap?.latestQuote) {
            premium = (snap.latestQuote.ap + snap.latestQuote.bp) / 2;
          }
        } catch { /* use estimate */ }

        // Position sizing
        const maxRisk = equity * EARNINGS_RULES.MAX_POSITION_PCT;
        const isBigSurprise = Math.abs(surprisePct) >= EARNINGS_RULES.BIG_SURPRISE_PCT;
        const adjustedRisk = isBigSurprise ? maxRisk * 1.5 : maxRisk;
        const costPerContract = premium * 100;
        const qty = Math.max(1, Math.min(5, Math.floor(adjustedRisk / costPerContract)));

        // Place the order
        const order = await placeOrder({
          symbol: contract.symbol,
          qty: String(qty),
          side: "buy",
          type: "market",
          time_in_force: "day",
        });

        const strike = parseFloat(contract.strike_price);
        const reasoning = `[EARNINGS PLAY] ${symbol} ${isBullish ? "BEAT" : "MISSED"} by ${Math.abs(surprisePct).toFixed(1)}% (actual: $${earning.epsActual!.toFixed(2)} vs est: $${earning.epsEstimate!.toFixed(2)}). Stock ${isBullish ? "gapped UP" : "gapped DOWN"} ${Math.abs(gapPct).toFixed(1)}%. Bought ${qty}x ${optionType} $${strike.toFixed(2)} exp ${contract.expiration_date}. Quick momentum play — target +50%, stop -30%, max hold 3 days.`;

        await prisma.autoTradeLog.create({
          data: {
            symbol: contract.symbol,
            action: `earnings_${optionType}`,
            qty,
            price: premium,
            reason: reasoning,
            aiScore: Math.round(Math.abs(surprisePct)),
            aiSignal: direction === "bullish" ? "buy" : "sell",
            orderId: order.id,
          },
        });

        await prisma.tradeIdea.create({
          data: {
            symbol: contract.symbol,
            action: `earnings_${optionType}`,
            entryPrice: premium,
            targetPrice: premium * (1 + EARNINGS_RULES.PROFIT_TARGET_PCT),
            stopLoss: premium * (1 - EARNINGS_RULES.STOP_LOSS_PCT),
            reasoning,
            timeframe: "day_trade",
            riskReward: EARNINGS_RULES.PROFIT_TARGET_PCT / EARNINGS_RULES.STOP_LOSS_PCT,
          },
        });

        results.push({
          symbol,
          epsActual: earning.epsActual!,
          epsEstimate: earning.epsEstimate!,
          surprisePct,
          gapPct,
          direction,
          action: `buy_${optionType}`,
          contractSymbol: contract.symbol,
          qty,
          premium,
          reasoning,
          orderId: order.id,
          success: true,
        });
      } catch (err) {
        results.push({
          symbol,
          epsActual: earning.epsActual!,
          epsEstimate: earning.epsEstimate!,
          surprisePct,
          gapPct,
          direction,
          action: "error",
          contractSymbol: null,
          qty: 0,
          premium: null,
          reasoning: `Error: ${err}`,
          orderId: null,
          success: false,
        });
      }
    }
  } catch (err) {
    console.error("[earnings-trader]", err);
  }

  return results;
}

// ============ EARNINGS PRE-POSITIONING ============
// Buy straddles 2-5 days BEFORE earnings when IV is still cheap
// Profit from the big post-earnings move in either direction

export async function prePositionEarnings(
  equity: number,
  focusSymbols: string[]
): Promise<{ symbol: string; action: string; details: string; success: boolean }[]> {
  const results: { symbol: string; action: string; details: string; success: boolean }[] = [];

  try {
    const today = new Date();
    const fiveDaysOut = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000);
    const twoDaysOut = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);

    const earnings = await getEarningsCalendar(
      twoDaysOut.toISOString().split("T")[0],
      fiveDaysOut.toISOString().split("T")[0]
    );

    if (earnings.length === 0) return results;

    const focusSet = new Set(focusSymbols.map((s) => s.toUpperCase()));
    const earningsInFocus = earnings.filter((e) => focusSet.has(e.symbol));

    let positioned = 0;
    for (const earning of earningsInFocus.slice(0, 5)) {
      if (positioned >= 2) break; // Cap at 2 pre-earnings positions per run

      const symbol = earning.symbol;

      // Skip if already pre-positioned
      const existing = await prisma.autoTradeLog.findFirst({
        where: {
          symbol: { contains: symbol },
          action: "earnings_pre_straddle",
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      });
      if (existing) continue;

      // Check IV rank — only buy if options are still cheap (IV rank < 50)
      try {
        const vol = await analyzeVolatility(symbol);
        if (vol && vol.ivRank > 50) {
          results.push({
            symbol,
            action: "skip",
            details: `IV rank ${vol.ivRank}/100 — too expensive to pre-position (need < 50)`,
            success: false,
          });
          continue;
        }
      } catch {
        // No vol data, proceed with caution
      }

      // Get current price
      let currentPrice = 0;
      try {
        const snap = await getSnapshot(symbol);
        currentPrice = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
      } catch { continue; }
      if (currentPrice <= 0) continue;

      // Find ATM call and put, 14-21 DTE (survive through earnings + aftermath)
      const now = new Date();
      const minExp = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const maxExp = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      const allContracts = await getOptionsChain(symbol, undefined, undefined, minExp, maxExp);
      const atmCalls = allContracts.filter((c) =>
        c.type === "call" && Math.abs(parseFloat(c.strike_price) - currentPrice) / currentPrice < 0.02
      );
      const atmPuts = allContracts.filter((c) =>
        c.type === "put" && Math.abs(parseFloat(c.strike_price) - currentPrice) / currentPrice < 0.02
      );

      if (atmCalls.length === 0 || atmPuts.length === 0) {
        results.push({ symbol, action: "skip", details: "No ATM contracts for straddle", success: false });
        continue;
      }

      const call = atmCalls[0];
      const matchPut = atmPuts.find((p) => p.strike_price === call.strike_price && p.expiration_date === call.expiration_date);
      if (!matchPut) {
        results.push({ symbol, action: "skip", details: "No matching put for straddle", success: false });
        continue;
      }

      // Size: 1% of portfolio for pre-earnings gamble
      const maxRisk = equity * 0.01;
      const qty = Math.max(1, Math.min(2, Math.floor(maxRisk / (currentPrice * 0.04 * 100))));

      try {
        const callOrder = await placeOrder({ symbol: call.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" });
        const putOrder = await placeOrder({ symbol: matchPut.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" });

        const strike = parseFloat(call.strike_price);
        const details = `PRE-EARNINGS STRADDLE: ${symbol} reports ${earning.date}. Bought ${qty}x call + put @ $${strike.toFixed(2)} exp ${call.expiration_date}. IV rank low — options cheap before the vol spike.`;

        await prisma.autoTradeLog.create({
          data: { symbol: call.symbol, action: "earnings_pre_straddle", qty, price: null, reason: details, aiScore: null, aiSignal: "straddle", orderId: callOrder.id },
        });
        await prisma.autoTradeLog.create({
          data: { symbol: matchPut.symbol, action: "earnings_pre_straddle", qty, price: null, reason: details, aiScore: null, aiSignal: "straddle", orderId: putOrder.id },
        });

        results.push({ symbol, action: "earnings_pre_straddle", details, success: true });
        positioned++;
      } catch (err) {
        results.push({ symbol, action: "error", details: `Failed: ${err}`, success: false });
      }
    }
  } catch (err) {
    console.error("[earnings-pre-position]", err);
  }

  return results;
}
