import {
  getAccount,
  getPositions,
  getMarketClock,
  getTopMovers,
  getMostActives,
  getSnapshot,
  placeOrder,
  getQuote,
} from "./alpaca";
import { analyzeStock } from "./ai-analyst";
import { prisma } from "./db";

// ============ RISK MANAGEMENT RULES ============
const RULES = {
  MAX_POSITIONS: 10,           // Never hold more than 10 stocks
  MAX_POSITION_PCT: 0.05,     // Max 5% of portfolio in one stock
  MIN_SCORE_TO_BUY: 55,       // Only buy if AI score > 55
  MIN_CONFIDENCE: 60,         // Only buy if AI confidence > 60%
  STOP_LOSS_PCT: 0.07,        // Sell if down 7% from entry
  TAKE_PROFIT_PCT: 0.15,      // Sell if up 15% from entry
  MIN_CASH_RESERVE_PCT: 0.20, // Always keep 20% in cash
  MAX_DAILY_TRADES: 5,        // Max 5 trades per day
  COOLDOWN_HOURS: 24,         // Don't re-analyze a stock within 24h
};

interface AgentResult {
  runType: string;
  stocksScanned: number;
  tradesPlaced: number;
  positionsManaged: number;
  errors: number;
  summary: string;
  details: string[];
}

// ============ MAIN AGENT LOOP ============

export async function runTradingAgent(): Promise<AgentResult> {
  const startTime = Date.now();
  const details: string[] = [];
  let tradesPlaced = 0;
  let stocksScanned = 0;
  let positionsManaged = 0;
  let errors = 0;

  try {
    // Step 1: Check if market is open
    const clock = await getMarketClock();
    if (!clock.is_open) {
      const summary = `Market is closed. Next open: ${new Date(clock.next_open).toLocaleString()}`;
      details.push(summary);
      await logRun("full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, startTime);
      return { runType: "full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, details };
    }

    // Step 2: Get account state
    const account = await getAccount();
    const equity = parseFloat(account.equity);
    const cash = parseFloat(account.cash);
    const buyingPower = parseFloat(account.buying_power);
    const positions = await getPositions();

    details.push(`Portfolio: $${equity.toFixed(2)} equity, $${cash.toFixed(2)} cash, ${positions.length} positions`);

    // Step 3: Check daily trade count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = await prisma.autoTradeLog.count({
      where: {
        createdAt: { gte: todayStart },
        action: { in: ["buy", "sell"] },
      },
    });
    if (todayTrades >= RULES.MAX_DAILY_TRADES) {
      const summary = `Daily trade limit reached (${todayTrades}/${RULES.MAX_DAILY_TRADES})`;
      details.push(summary);
      await logRun("full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, startTime);
      return { runType: "full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, details };
    }

    // Step 4: MANAGE EXISTING POSITIONS (stop loss + take profit)
    for (const pos of positions) {
      positionsManaged++;
      const currentPrice = parseFloat(pos.current_price);
      const entryPrice = parseFloat(pos.avg_entry_price);
      const qty = parseInt(pos.qty);
      const pnlPct = (currentPrice - entryPrice) / entryPrice;

      // STOP LOSS
      if (pnlPct <= -RULES.STOP_LOSS_PCT) {
        details.push(`STOP LOSS: ${pos.symbol} down ${(pnlPct * 100).toFixed(1)}% — selling ${qty} shares`);
        try {
          const order = await placeOrder({
            symbol: pos.symbol,
            qty: String(qty),
            side: "sell",
            type: "market",
            time_in_force: "day",
          });
          await logTrade(pos.symbol, "stop_loss", qty, currentPrice, `Down ${(pnlPct * 100).toFixed(1)}% from entry`, null, null, order.id, parseFloat(pos.unrealized_pl));
          tradesPlaced++;
        } catch (err) {
          errors++;
          details.push(`  Failed to sell ${pos.symbol}: ${err}`);
        }
        continue;
      }

      // TAKE PROFIT
      if (pnlPct >= RULES.TAKE_PROFIT_PCT) {
        details.push(`TAKE PROFIT: ${pos.symbol} up ${(pnlPct * 100).toFixed(1)}% — selling ${qty} shares`);
        try {
          const order = await placeOrder({
            symbol: pos.symbol,
            qty: String(qty),
            side: "sell",
            type: "market",
            time_in_force: "day",
          });
          await logTrade(pos.symbol, "take_profit", qty, currentPrice, `Up ${(pnlPct * 100).toFixed(1)}% from entry`, null, null, order.id, parseFloat(pos.unrealized_pl));
          tradesPlaced++;
        } catch (err) {
          errors++;
          details.push(`  Failed to sell ${pos.symbol}: ${err}`);
        }
        continue;
      }

      details.push(`  ${pos.symbol}: ${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(1)}% — holding`);
    }

    // Step 5: FIND NEW OPPORTUNITIES (only if we have room)
    if (positions.length >= RULES.MAX_POSITIONS) {
      details.push(`At max positions (${positions.length}/${RULES.MAX_POSITIONS}) — not scanning for new buys`);
    } else if (cash < equity * RULES.MIN_CASH_RESERVE_PCT) {
      details.push(`Cash below reserve (${((cash / equity) * 100).toFixed(1)}% < ${RULES.MIN_CASH_RESERVE_PCT * 100}%) — not buying`);
    } else {
      // Get candidates from market movers
      const [gainers, losers, active] = await Promise.all([
        getTopMovers("gainers").catch(() => []),
        getTopMovers("losers").catch(() => []),
        getMostActives().catch(() => []),
      ]);

      // Build candidate list (exclude already held)
      const heldSymbols = new Set(positions.map((p) => p.symbol));
      const candidates = new Set<string>();
      // Top gainers with momentum
      gainers.slice(0, 5).forEach((m) => {
        if (!heldSymbols.has(m.symbol) && m.price > 5) candidates.add(m.symbol);
      });
      // Oversold losers (potential bounces)
      losers.slice(0, 3).forEach((m) => {
        if (!heldSymbols.has(m.symbol) && m.price > 5) candidates.add(m.symbol);
      });
      // Most active (high liquidity)
      active.slice(0, 3).forEach((m) => {
        if (!heldSymbols.has(m.symbol) && m.price > 5) candidates.add(m.symbol);
      });

      details.push(`Found ${candidates.size} candidates to analyze`);

      // Check cooldown — skip recently analyzed stocks
      const cooldownTime = new Date(Date.now() - RULES.COOLDOWN_HOURS * 60 * 60 * 1000);
      const recentReports = await prisma.researchReport.findMany({
        where: { createdAt: { gte: cooldownTime } },
        select: { symbol: true },
      });
      const recentSymbols = new Set(recentReports.map((r) => r.symbol));

      // Analyze and potentially buy
      for (const symbol of candidates) {
        if (tradesPlaced + todayTrades >= RULES.MAX_DAILY_TRADES) break;
        if (positions.length + tradesPlaced >= RULES.MAX_POSITIONS) break;

        stocksScanned++;

        if (recentSymbols.has(symbol)) {
          details.push(`  ${symbol}: skipped (analyzed within ${RULES.COOLDOWN_HOURS}h)`);
          continue;
        }

        try {
          details.push(`  Analyzing ${symbol}...`);
          const analysis = await analyzeStock(symbol);
          details.push(`  ${symbol}: score=${analysis.score}, signal=${analysis.signal}, confidence=${analysis.confidence}%`);

          // Check if it meets our buy criteria
          if (
            analysis.score >= RULES.MIN_SCORE_TO_BUY &&
            analysis.confidence >= RULES.MIN_CONFIDENCE &&
            (analysis.signal === "buy" || analysis.signal === "strong_buy")
          ) {
            // Calculate position size
            const maxPositionValue = equity * RULES.MAX_POSITION_PCT;
            const availableCash = cash - equity * RULES.MIN_CASH_RESERVE_PCT;

            if (availableCash <= 0) {
              details.push(`  ${symbol}: SKIP — not enough cash after reserve`);
              await logTrade(symbol, "skip", 0, null, "Insufficient cash after reserve", analysis.score, analysis.signal);
              continue;
            }

            const positionValue = Math.min(maxPositionValue, availableCash);

            // Get current price
            let price: number;
            try {
              const snap = await getSnapshot(symbol);
              price = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
            } catch {
              const quote = await getQuote(symbol);
              price = quote.ap || 0;
            }

            if (price <= 0) {
              details.push(`  ${symbol}: SKIP — couldn't get price`);
              continue;
            }

            const qty = Math.floor(positionValue / price);
            if (qty <= 0) {
              details.push(`  ${symbol}: SKIP — position too small`);
              continue;
            }

            details.push(`  BUY ${symbol}: ${qty} shares @ ~$${price.toFixed(2)} ($${(qty * price).toFixed(2)})`);

            const order = await placeOrder({
              symbol,
              qty: String(qty),
              side: "buy",
              type: "market",
              time_in_force: "day",
            });

            await logTrade(
              symbol,
              "buy",
              qty,
              price,
              `AI Score: ${analysis.score}, Signal: ${analysis.signal}, Confidence: ${analysis.confidence}%. ${analysis.summary}`,
              analysis.score,
              analysis.signal,
              order.id
            );
            tradesPlaced++;
          } else {
            const reason = `Score ${analysis.score} (need ${RULES.MIN_SCORE_TO_BUY}), Confidence ${analysis.confidence}% (need ${RULES.MIN_CONFIDENCE}%), Signal: ${analysis.signal}`;
            details.push(`  ${symbol}: SKIP — ${reason}`);
            await logTrade(symbol, "skip", 0, null, reason, analysis.score, analysis.signal);
          }
        } catch (err) {
          errors++;
          details.push(`  ${symbol}: ERROR — ${err}`);
        }
      }
    }

    const summary = `Scanned ${stocksScanned} stocks, placed ${tradesPlaced} trades, managed ${positionsManaged} positions, ${errors} errors`;
    details.push(`\n${summary}`);

    await logRun("full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, startTime);

    return { runType: "full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, details };
  } catch (err) {
    const summary = `Agent error: ${err}`;
    details.push(summary);
    errors++;
    await logRun("full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, startTime);
    return { runType: "full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, details };
  }
}

// ============ HELPERS ============

async function logTrade(
  symbol: string,
  action: string,
  qty: number,
  price: number | null,
  reason: string,
  aiScore?: number | null,
  aiSignal?: string | null,
  orderId?: string,
  pnl?: number
) {
  await prisma.autoTradeLog.create({
    data: {
      symbol,
      action,
      qty,
      price,
      reason,
      aiScore: aiScore ?? null,
      aiSignal: aiSignal ?? null,
      orderId: orderId ?? null,
      pnl: pnl ?? null,
    },
  });
}

async function logRun(
  runType: string,
  stocksScanned: number,
  tradesPlaced: number,
  positionsManaged: number,
  errors: number,
  summary: string,
  startTime: number
) {
  await prisma.agentRun.create({
    data: {
      runType,
      stocksScanned,
      tradesPlaced,
      positionsManaged,
      errors,
      summary,
      durationMs: Date.now() - startTime,
    },
  });
}
