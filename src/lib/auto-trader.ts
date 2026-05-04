import {
  getAccount,
  getPositions,
  getMarketClock,
  getTopMovers,
  getMostActives,
  getSnapshot,
  placeOrder,
  getQuote,
  getBars,
  getNews,
  getOptionsChain,
  type Position,
} from "./alpaca";
import { getKeyStats, getHistoricalBars } from "./yahoo";
import { detectMarketRegime, type RegimeAnalysis } from "./market-regime";
import { sendNotification } from "./notifications";
import { analyzeStock } from "./ai-analyst";
import { prisma } from "./db";

// ============ DEFAULT RULES (overridden by database config) ============
const DEFAULT_RULES = {
  MAX_POSITIONS: 10,
  MAX_PER_SECTOR: 3,
  MAX_POSITION_PCT: 0.07,
  MIN_POSITION_PCT: 0.02,
  MIN_CASH_RESERVE_PCT: 0.20,
  MIN_SCORE_TO_BUY: 55,
  MIN_CONFIDENCE: 60,
  STOP_ATR_MULTIPLIER: 2.0,
  MAX_STOP_PCT: 0.10,
  MIN_STOP_PCT: 0.03,
  TRAILING_ACTIVATION_PCT: 0.05,
  TRAILING_ATR_MULTIPLIER: 1.5,
  TAKE_PROFIT_PCT: 0.25,
  MAX_DAILY_TRADES: 6,
  COOLDOWN_HOURS: 12,
  LIMIT_ORDER_DISCOUNT: 0.001,
  EARNINGS_BLACKOUT_DAYS: 5,
  MIN_VOLUME_RATIO: 0.8,
  OPTIONS_MIN_DTE: 3,
  OPTIONS_PROFIT_TARGET: 0.50,
  OPTIONS_STOP_LOSS: 0.40,
  REEVALUATE_SCORE_DROP: 30,
};

// Load rules from database config, falling back to defaults
async function loadRules() {
  const rules = { ...DEFAULT_RULES };
  try {
    const configs = await prisma.agentConfig.findMany();
    const configMap: Record<string, string> = {};
    for (const c of configs) configMap[c.key] = c.value;

    if (configMap.max_positions) rules.MAX_POSITIONS = parseInt(configMap.max_positions);
    if (configMap.max_per_sector) rules.MAX_PER_SECTOR = parseInt(configMap.max_per_sector);
    if (configMap.max_position_pct) rules.MAX_POSITION_PCT = parseInt(configMap.max_position_pct) / 100;
    if (configMap.min_score) rules.MIN_SCORE_TO_BUY = parseInt(configMap.min_score);
    if (configMap.min_confidence) rules.MIN_CONFIDENCE = parseInt(configMap.min_confidence);
    if (configMap.stop_loss_atr) rules.STOP_ATR_MULTIPLIER = parseFloat(configMap.stop_loss_atr);
    if (configMap.take_profit_pct) rules.TAKE_PROFIT_PCT = parseInt(configMap.take_profit_pct) / 100;
    if (configMap.cash_reserve_pct) rules.MIN_CASH_RESERVE_PCT = parseInt(configMap.cash_reserve_pct) / 100;
    if (configMap.max_daily_trades) rules.MAX_DAILY_TRADES = parseInt(configMap.max_daily_trades);
    if (configMap.cooldown_hours) rules.COOLDOWN_HOURS = parseInt(configMap.cooldown_hours);
    if (configMap.options_stop_loss_pct) rules.OPTIONS_STOP_LOSS = parseInt(configMap.options_stop_loss_pct) / 100;
    if (configMap.options_profit_pct) rules.OPTIONS_PROFIT_TARGET = parseInt(configMap.options_profit_pct) / 100;
  } catch {
    // use defaults
  }
  return rules;
}

interface AgentResult {
  runType: string;
  stocksScanned: number;
  tradesPlaced: number;
  positionsManaged: number;
  errors: number;
  summary: string;
  details: string[];
}

// ============ TECHNICAL HELPERS ============

function calculateATR(bars: { h: number; l: number; c: number }[]): number {
  if (bars.length < 15) return 0;
  const trs: number[] = [];
  for (let i = bars.length - 14; i < bars.length; i++) {
    const high = bars[i].h;
    const low = bars[i].l;
    const prevClose = bars[i - 1].c;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calculateRSI(closes: number[], period: number = 14): number | null {
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

function sma(data: number[], period: number): number | null {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculatePositionSize(
  equity: number,
  score: number,
  confidence: number,
  price: number,
  regimeMultiplier: number = 1.0,
  rules: { MIN_POSITION_PCT: number; MAX_POSITION_PCT: number; MIN_SCORE_TO_BUY: number } = DEFAULT_RULES
): number {
  const baseRatio = rules.MIN_POSITION_PCT;
  const maxRatio = rules.MAX_POSITION_PCT;
  const scoreRange = 100 - rules.MIN_SCORE_TO_BUY;
  const scoreFactor = Math.min(1, (score - rules.MIN_SCORE_TO_BUY) / scoreRange);
  const confidenceFactor = Math.min(1, confidence / 100);

  let ratio = baseRatio + (maxRatio - baseRatio) * scoreFactor * confidenceFactor;
  ratio *= regimeMultiplier;
  ratio *= 0.6; // Initial entry = 60% of full size

  const positionValue = equity * ratio;
  return Math.floor(positionValue / price);
}

// Check if two stocks are in the same sector (correlation proxy)
function checkCorrelation(
  candidateSector: string,
  heldSectors: Record<string, number>,
  maxPerSector: number
): boolean {
  if (!candidateSector || candidateSector === "Unknown") return true;
  return (heldSectors[candidateSector] || 0) < maxPerSector;
}

// ============ MAIN AGENT LOOP ============

export async function runTradingAgent(): Promise<AgentResult> {
  const startTime = Date.now();
  const details: string[] = [];
  let tradesPlaced = 0;
  let stocksScanned = 0;
  let positionsManaged = 0;
  let errors = 0;

  // Load rules from database config
  const RULES = await loadRules();

  // Check if agent is enabled
  try {
    const enabledConfig = await prisma.agentConfig.findUnique({ where: { key: "enabled" } });
    if (enabledConfig?.value === "false") {
      return { runType: "full", stocksScanned: 0, tradesPlaced: 0, positionsManaged: 0, errors: 0, summary: "Agent is paused. Enable in Settings.", details: ["Agent is paused."] };
    }
  } catch { /* continue */ }

  try {
    // Step 1: Check if market is open
    const clock = await getMarketClock();
    if (!clock.is_open) {
      const summary = `Market is closed. Next open: ${new Date(clock.next_open).toLocaleString()}`;
      details.push(summary);
      await logRun("full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, startTime);
      return { runType: "full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, details };
    }

    // Step 1b: Detect market regime
    let regime: RegimeAnalysis;
    try {
      regime = await detectMarketRegime();
      details.push(`REGIME: ${regime.regime.toUpperCase()} — ${regime.recommendation}`);
    } catch {
      regime = { regime: "choppy", positionSizeMultiplier: 0.8, cashReservePct: 25 } as RegimeAnalysis;
      details.push("REGIME: Unable to detect, using conservative defaults");
    }

    // Step 2: Get account state
    const account = await getAccount();
    const equity = parseFloat(account.equity);
    const cash = parseFloat(account.cash);
    const positions = await getPositions();

    // Apply regime-adjusted cash reserve
    const effectiveCashReserve = Math.max(RULES.MIN_CASH_RESERVE_PCT, regime.cashReservePct / 100);

    details.push(`Portfolio: $${equity.toFixed(2)} equity, $${cash.toFixed(2)} cash, ${positions.length} positions (regime sizing: ${regime.positionSizeMultiplier.toFixed(1)}x)`);

    // Step 3: Check daily trade count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = await prisma.autoTradeLog.count({
      where: {
        createdAt: { gte: todayStart },
        action: { in: ["buy", "sell", "stop_loss", "take_profit", "trailing_stop", "thesis_change"] },
      },
    });

    if (todayTrades >= RULES.MAX_DAILY_TRADES) {
      const summary = `Daily trade limit reached (${todayTrades}/${RULES.MAX_DAILY_TRADES})`;
      details.push(summary);
      await logRun("full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, startTime);
      return { runType: "full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, details };
    }

    // ============ STEP 4: MANAGE EXISTING POSITIONS ============
    for (const pos of positions) {
      positionsManaged++;
      const currentPrice = parseFloat(pos.current_price);
      const entryPrice = parseFloat(pos.avg_entry_price);
      const qty = parseInt(pos.qty);
      const pnlPct = (currentPrice - entryPrice) / entryPrice;
      const isOptionsPosition = pos.symbol.length > 10; // Options symbols are longer

      // === OPTIONS MANAGEMENT ===
      if (isOptionsPosition) {
        // Options: tighter stops, watch theta decay
        if (pnlPct <= -RULES.OPTIONS_STOP_LOSS) {
          details.push(`OPTIONS STOP: ${pos.symbol} down ${(pnlPct * 100).toFixed(1)}% — cutting loss`);
          try {
            const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
            await logTrade(pos.symbol, "stop_loss", qty, currentPrice, `Options down ${(pnlPct * 100).toFixed(1)}%`, null, null, order.id, parseFloat(pos.unrealized_pl));
            tradesPlaced++;
          } catch (err) { errors++; details.push(`  Failed: ${err}`); }
          continue;
        }

        if (pnlPct >= RULES.OPTIONS_PROFIT_TARGET) {
          details.push(`OPTIONS PROFIT: ${pos.symbol} up ${(pnlPct * 100).toFixed(1)}% — taking profit`);
          try {
            const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
            await logTrade(pos.symbol, "take_profit", qty, currentPrice, `Options up ${(pnlPct * 100).toFixed(1)}%`, null, null, order.id, parseFloat(pos.unrealized_pl));
            tradesPlaced++;
          } catch (err) { errors++; details.push(`  Failed: ${err}`); }
          continue;
        }

        details.push(`  ${pos.symbol}: ${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(1)}% — holding option`);
        continue;
      }

      // === STOCK POSITION MANAGEMENT ===

      // Get ATR for dynamic stops
      let atr = 0;
      try {
        const bars = await getBars(pos.symbol, "1Day");
        atr = calculateATR(bars);
      } catch {
        atr = currentPrice * 0.02; // fallback: 2% of price
      }

      // Calculate dynamic stop loss based on ATR
      const atrStopDistance = atr * RULES.STOP_ATR_MULTIPLIER;
      const atrStopPct = atrStopDistance / entryPrice;
      const stopPct = Math.max(RULES.MIN_STOP_PCT, Math.min(RULES.MAX_STOP_PCT, atrStopPct));

      // TRAILING STOP: if position is up enough, trail the stop
      if (pnlPct >= RULES.TRAILING_ACTIVATION_PCT) {
        const trailDistance = atr * RULES.TRAILING_ATR_MULTIPLIER;
        const trailStopPrice = currentPrice - trailDistance;
        const trailFromHigh = (currentPrice - trailStopPrice) / currentPrice;

        // Check if we've pulled back significantly from a recent high
        // Simple check: if the pullback from entry exceeds the trail, it might be reversing
        const highWaterMark = entryPrice * (1 + pnlPct); // approximate
        const pullbackFromHigh = 1 - (currentPrice / highWaterMark);

        if (pullbackFromHigh > trailFromHigh && pnlPct < RULES.TRAILING_ACTIVATION_PCT * 1.5) {
          details.push(`TRAILING STOP: ${pos.symbol} trailing activated, pullback detected — selling at +${(pnlPct * 100).toFixed(1)}%`);
          try {
            const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
            await logTrade(pos.symbol, "trailing_stop", qty, currentPrice, `Trailing stop: up ${(pnlPct * 100).toFixed(1)}% with pullback`, null, null, order.id, parseFloat(pos.unrealized_pl));
            tradesPlaced++;
          } catch (err) { errors++; details.push(`  Failed: ${err}`); }
          continue;
        }
      }

      // HARD STOP LOSS (ATR-based)
      if (pnlPct <= -stopPct) {
        details.push(`STOP LOSS: ${pos.symbol} down ${(pnlPct * 100).toFixed(1)}% (ATR stop: -${(stopPct * 100).toFixed(1)}%) — selling`);
        try {
          const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
          await logTrade(pos.symbol, "stop_loss", qty, currentPrice, `ATR stop: down ${(pnlPct * 100).toFixed(1)}% (limit: -${(stopPct * 100).toFixed(1)}%)`, null, null, order.id, parseFloat(pos.unrealized_pl));
          tradesPlaced++;
        } catch (err) { errors++; details.push(`  Failed: ${err}`); }
        continue;
      }

      // HARD TAKE PROFIT
      if (pnlPct >= RULES.TAKE_PROFIT_PCT) {
        details.push(`TAKE PROFIT: ${pos.symbol} up ${(pnlPct * 100).toFixed(1)}% — selling`);
        try {
          const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
          await logTrade(pos.symbol, "take_profit", qty, currentPrice, `Up ${(pnlPct * 100).toFixed(1)}%`, null, null, order.id, parseFloat(pos.unrealized_pl));
          tradesPlaced++;
        } catch (err) { errors++; details.push(`  Failed: ${err}`); }
        continue;
      }

      // THESIS RE-EVALUATION: Check if original analysis still holds
      // Find the original analysis that triggered this buy
      const originalReport = await prisma.researchReport.findFirst({
        where: { symbol: pos.symbol },
        orderBy: { createdAt: "desc" },
      });

      if (originalReport && originalReport.score > 0) {
        // If position has been held for > 3 days, re-evaluate
        const holdDays = (Date.now() - new Date(originalReport.createdAt).getTime()) / (1000 * 60 * 60 * 24);

        if (holdDays > 3) {
          // Check for negative news
          try {
            const news = await getNews([pos.symbol], 3);
            const hasNegativeNews = news.some((n) =>
              n.headline.toLowerCase().match(/downgrade|lawsuit|recall|investigation|fraud|miss|cut|warning|loss/)
            );

            if (hasNegativeNews && pnlPct < 0) {
              details.push(`THESIS CHANGE: ${pos.symbol} negative news + underwater — re-evaluating...`);
              // Quick re-analysis: just check if the signal flipped
              try {
                const newAnalysis = await analyzeStock(pos.symbol);
                const scoreDrop = originalReport.score - newAnalysis.score;

                if (scoreDrop >= RULES.REEVALUATE_SCORE_DROP || newAnalysis.signal.includes("sell")) {
                  details.push(`  ${pos.symbol}: Score dropped ${scoreDrop} points (${originalReport.score} → ${newAnalysis.score}), signal: ${newAnalysis.signal} — SELLING`);
                  const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
                  await logTrade(pos.symbol, "thesis_change", qty, currentPrice, `Score dropped ${scoreDrop} pts. New signal: ${newAnalysis.signal}. ${newAnalysis.summary.slice(0, 100)}`, newAnalysis.score, newAnalysis.signal, order.id, parseFloat(pos.unrealized_pl));
                  tradesPlaced++;
                  continue;
                } else {
                  details.push(`  ${pos.symbol}: Re-analysis still OK (score: ${newAnalysis.score}) — holding`);
                }
              } catch {
                details.push(`  ${pos.symbol}: Re-analysis failed — holding based on original thesis`);
              }
            }
          } catch {
            // news fetch failed, skip
          }
        }
      }

      details.push(`  ${pos.symbol}: ${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(1)}% (stop: -${(stopPct * 100).toFixed(1)}%) — holding`);
    }

    // ============ STEP 5: FIND NEW OPPORTUNITIES ============

    if (positions.length >= RULES.MAX_POSITIONS) {
      details.push(`At max positions (${positions.length}/${RULES.MAX_POSITIONS}) — not scanning`);
    } else if (cash < equity * effectiveCashReserve) {
      details.push(`Cash below reserve — not buying`);
    } else {
      // Get candidates from multiple sources
      const [gainers, losers, active] = await Promise.all([
        getTopMovers("gainers").catch(() => []),
        getTopMovers("losers").catch(() => []),
        getMostActives().catch(() => []),
      ]);

      const heldSymbols = new Set(positions.map((p) => p.symbol));

      // Build sector map of held positions for diversification
      const heldSectors: Record<string, number> = {};
      for (const pos of positions) {
        try {
          const stats = await getKeyStats(pos.symbol);
          // We'd need sector from yahoo profile, but approximate from research reports
          const report = await prisma.researchReport.findFirst({
            where: { symbol: pos.symbol },
            orderBy: { createdAt: "desc" },
            select: { sector: true },
          });
          const sector = report?.sector || "Unknown";
          heldSectors[sector] = (heldSectors[sector] || 0) + 1;
        } catch {
          // skip
        }
      }

      // Load agent config for focus symbols and blacklist
      let focusSymbols: string[] = [];
      let blacklist: string[] = [];
      try {
        const focusConfig = await prisma.agentConfig.findUnique({ where: { key: "focus_symbols" } });
        const blacklistConfig = await prisma.agentConfig.findUnique({ where: { key: "blacklist" } });
        if (focusConfig?.value) focusSymbols = focusConfig.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
        if (blacklistConfig?.value) blacklist = blacklistConfig.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      } catch { /* ignore */ }

      const blacklistSet = new Set(blacklist);

      // Candidate selection: diversified sources
      const candidates = new Map<string, string>(); // symbol -> reason

      // PRIORITY: Focus symbols first (user's watchlist)
      for (const sym of focusSymbols) {
        if (!heldSymbols.has(sym) && !blacklistSet.has(sym)) {
          candidates.set(sym, "focus_watchlist");
        }
      }

      // Top gainers with momentum (but not already overextended)
      gainers.slice(0, 5).forEach((m) => {
        if (!heldSymbols.has(m.symbol) && !blacklistSet.has(m.symbol) && m.price > 5 && m.percent_change < 15) {
          candidates.set(m.symbol, "momentum_gainer");
        }
      });

      // Oversold losers (contrarian bounce plays — only if drop isn't catastrophic)
      losers.slice(0, 4).forEach((m) => {
        if (!heldSymbols.has(m.symbol) && !blacklistSet.has(m.symbol) && m.price > 10 && m.percent_change > -10) {
          candidates.set(m.symbol, "oversold_bounce");
        }
      });

      // Most active (high liquidity = easier exits)
      active.slice(0, 3).forEach((m) => {
        if (!heldSymbols.has(m.symbol) && !blacklistSet.has(m.symbol) && m.price > 5) {
          candidates.set(m.symbol, "high_volume");
        }
      });

      details.push(`Found ${candidates.size} candidates from ${gainers.length} gainers, ${losers.length} losers, ${active.length} active`);

      // Cooldown check
      const cooldownTime = new Date(Date.now() - RULES.COOLDOWN_HOURS * 60 * 60 * 1000);
      const recentReports = await prisma.researchReport.findMany({
        where: { createdAt: { gte: cooldownTime } },
        select: { symbol: true },
      });
      const recentSymbols = new Set(recentReports.map((r) => r.symbol));

      // Analyze and potentially buy
      for (const [symbol, reason] of candidates) {
        if (tradesPlaced + todayTrades >= RULES.MAX_DAILY_TRADES) break;
        if (positions.length + tradesPlaced >= RULES.MAX_POSITIONS) break;

        stocksScanned++;

        if (recentSymbols.has(symbol)) {
          details.push(`  ${symbol}: skipped (analyzed within ${RULES.COOLDOWN_HOURS}h)`);
          continue;
        }

        try {
          // === PRE-SCREENING: Quick checks before expensive AI analysis ===

          // Volume check — try Alpaca first, fallback to Yahoo Finance
          let bars: { t: string; o: number; h: number; l: number; c: number; v: number }[] = [];
          try {
            bars = await getBars(symbol, "1Day");
          } catch {
            bars = [];
          }

          // Yahoo Finance fallback if Alpaca has insufficient data
          if (bars.length < 5) {
            try {
              details.push(`  ${symbol}: Alpaca has ${bars.length} bars, trying Yahoo Finance...`);
              bars = await getHistoricalBars(symbol, 200);
            } catch {
              // ignore
            }
          }

          if (bars.length < 5) {
            details.push(`  ${symbol}: skipped (insufficient history from both sources: ${bars.length} bars)`);
            continue;
          }

          const recentVolume = bars[bars.length - 1]?.v || 0;
          const volumeWindow = Math.min(20, bars.length);
          const avgVolume = bars.slice(-volumeWindow).reduce((sum, b) => sum + b.v, 0) / volumeWindow;
          if (avgVolume > 0 && recentVolume / avgVolume < RULES.MIN_VOLUME_RATIO) {
            details.push(`  ${symbol}: skipped (low volume: ${(recentVolume / avgVolume * 100).toFixed(0)}% of avg)`);
            continue;
          }

          // RSI check — don't buy extremely overbought
          const closes = bars.map((b) => b.c);
          const rsi = calculateRSI(closes);
          if (rsi && rsi > 80) {
            details.push(`  ${symbol}: skipped (RSI ${rsi.toFixed(0)} — overbought)`);
            continue;
          }

          // Trend check — price should be above 50-day SMA (uptrend)
          const sma50 = sma(closes, 50);
          const currentClose = closes[closes.length - 1];
          if (sma50 && currentClose < sma50 * 0.97) {
            // Allow 3% below SMA for bounce plays
            if (reason !== "oversold_bounce") {
              details.push(`  ${symbol}: skipped (below 50-SMA, not in uptrend)`);
              continue;
            }
          }

          // Earnings blackout check
          try {
            const stats = await getKeyStats(symbol);
            if (stats?.earningsDate) {
              const earningsDate = new Date(stats.earningsDate);
              const daysUntilEarnings = (earningsDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
              if (daysUntilEarnings >= 0 && daysUntilEarnings <= RULES.EARNINGS_BLACKOUT_DAYS) {
                details.push(`  ${symbol}: skipped (earnings in ${daysUntilEarnings.toFixed(0)} days — blackout)`);
                continue;
              }
            }
          } catch {
            // earnings check failed, continue anyway
          }

          // === FULL AI ANALYSIS ===
          details.push(`  Analyzing ${symbol} (${reason})...`);
          const analysis = await analyzeStock(symbol);
          details.push(`  ${symbol}: score=${analysis.score}, signal=${analysis.signal}, conf=${analysis.confidence}%`);

          // Check buy criteria
          if (
            analysis.score >= RULES.MIN_SCORE_TO_BUY &&
            analysis.confidence >= RULES.MIN_CONFIDENCE &&
            (analysis.signal === "buy" || analysis.signal === "strong_buy")
          ) {
            // Sector diversification check
            const report = await prisma.researchReport.findFirst({
              where: { symbol },
              orderBy: { createdAt: "desc" },
              select: { sector: true },
            });
            const sector = report?.sector || "Unknown";
            if ((heldSectors[sector] || 0) >= RULES.MAX_PER_SECTOR) {
              details.push(`  ${symbol}: SKIP — sector limit (${sector}: ${heldSectors[sector]}/${RULES.MAX_PER_SECTOR})`);
              await logTrade(symbol, "skip", 0, null, `Sector limit: ${sector}`, analysis.score, analysis.signal);
              continue;
            }

            // Calculate position size based on conviction
            const availableCash = cash - equity * effectiveCashReserve;
            if (availableCash <= 0) {
              details.push(`  ${symbol}: SKIP — cash below reserve`);
              continue;
            }

            let price: number;
            try {
              const snap = await getSnapshot(symbol);
              price = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
            } catch {
              const quote = await getQuote(symbol);
              price = quote.ap || 0;
            }

            if (price <= 0) continue;

            const qty = calculatePositionSize(equity, analysis.score, analysis.confidence, price, regime.positionSizeMultiplier, RULES);
            if (qty <= 0) {
              details.push(`  ${symbol}: SKIP — position too small`);
              continue;
            }

            const positionValue = qty * price;
            if (positionValue > availableCash) {
              details.push(`  ${symbol}: SKIP — exceeds available cash`);
              continue;
            }

            // Place limit order slightly below ask for better fill
            const limitPrice = (price * (1 - RULES.LIMIT_ORDER_DISCOUNT)).toFixed(2);

            details.push(`  BUY ${symbol}: ${qty} shares, limit $${limitPrice} (score: ${analysis.score}, ${reason})`);

            const order = await placeOrder({
              symbol,
              qty: String(qty),
              side: "buy",
              type: "limit",
              time_in_force: "day",
              limit_price: limitPrice,
            });

            // Update sector map
            heldSectors[sector] = (heldSectors[sector] || 0) + 1;

            // Calculate ATR-based stop for logging
            const atr = calculateATR(bars);
            const stopDistance = atr * RULES.STOP_ATR_MULTIPLIER;
            const stopPrice = (price - stopDistance).toFixed(2);
            const targetPrice = analysis.priceTarget || price * 1.15;

            await logTrade(
              symbol,
              "buy",
              qty,
              price,
              `[${reason}] Score: ${analysis.score}, Signal: ${analysis.signal}, Conf: ${analysis.confidence}%. Stop: $${stopPrice} (ATR: $${atr.toFixed(2)}). Target: $${targetPrice.toFixed(2)}. ${analysis.summary.slice(0, 150)}`,
              analysis.score,
              analysis.signal,
              order.id
            );
            tradesPlaced++;

            // === OPTIONS PLAY: Buy calls/puts based on AI recommendation ===
            if (analysis.optionsPlay && analysis.optionsPlay.strategy !== "none" && analysis.optionsPlay.confidence >= 60) {
              try {
                const optPlay = analysis.optionsPlay;
                const isCall = optPlay.strategy.includes("call");
                const isPut = optPlay.strategy.includes("put");

                if ((isCall || isPut) && optPlay.strike) {
                  // Find matching options contract
                  const optionType = isCall ? "call" : "put";
                  const contracts = await getOptionsChain(symbol, undefined, optionType);

                  // Find contract with closest strike, 2-6 weeks out
                  const now = new Date();
                  const minExpiry = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 2 weeks
                  const maxExpiry = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000); // 6 weeks

                  const validContracts = contracts.filter((c) => {
                    const expDate = new Date(c.expiration_date);
                    const strikeDiff = Math.abs(parseFloat(c.strike_price) - optPlay.strike!);
                    return expDate >= minExpiry && expDate <= maxExpiry && strikeDiff <= price * 0.05; // within 5% of recommended strike
                  });

                  if (validContracts.length > 0) {
                    // Pick the one closest to recommended strike
                    validContracts.sort((a, b) =>
                      Math.abs(parseFloat(a.strike_price) - optPlay.strike!) -
                      Math.abs(parseFloat(b.strike_price) - optPlay.strike!)
                    );
                    const contract = validContracts[0];

                    // Size: max 1-2% of portfolio on options (they're leveraged)
                    const optionsMaxSpend = equity * 0.015; // 1.5% of portfolio
                    const optionsQty = Math.max(1, Math.min(5, Math.floor(optionsMaxSpend / (price * 0.02)))); // rough sizing

                    details.push(`  OPTIONS: ${contract.symbol} (${optionType} $${contract.strike_price} exp ${contract.expiration_date}) x${optionsQty}`);

                    const optOrder = await placeOrder({
                      symbol: contract.symbol,
                      qty: String(optionsQty),
                      side: "buy",
                      type: "market",
                      time_in_force: "day",
                    });

                    await logTrade(
                      contract.symbol,
                      `buy_${optionType}`,
                      optionsQty,
                      null,
                      `[OPTIONS] ${optPlay.strategy}: ${optPlay.reasoning}. Target: ${optPlay.targetReturn}. Conf: ${optPlay.confidence}%`,
                      analysis.score,
                      analysis.signal,
                      optOrder.id
                    );
                    tradesPlaced++;
                  } else {
                    details.push(`  OPTIONS: No suitable contracts found for ${symbol} ${optionType} ~$${optPlay.strike}`);
                  }
                }
              } catch (optErr) {
                details.push(`  OPTIONS ERROR for ${symbol}: ${optErr}`);
              }
            }
          } else {
            const reason_text = `Score ${analysis.score} (need ${RULES.MIN_SCORE_TO_BUY}), Conf ${analysis.confidence}% (need ${RULES.MIN_CONFIDENCE}%), Signal: ${analysis.signal}`;
            details.push(`  ${symbol}: SKIP — ${reason_text}`);
            await logTrade(symbol, "skip", 0, null, reason_text, analysis.score, analysis.signal);
          }
        } catch (err) {
          errors++;
          details.push(`  ${symbol}: ERROR — ${err}`);
        }
      }
    }

    const summary = `[${regime.regime.toUpperCase()}] Scanned ${stocksScanned}, placed ${tradesPlaced} trades, managed ${positionsManaged} positions, ${errors} errors`;
    details.push(`\n${summary}`);
    await logRun("full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, startTime);

    // Send notification if trades were placed or positions were closed
    if (tradesPlaced > 0) {
      const tradeDetails = details.filter((d) => d.includes("BUY") || d.includes("STOP") || d.includes("TAKE PROFIT") || d.includes("TRAILING") || d.includes("THESIS") || d.includes("OPTIONS")).join("\n");
      await sendNotification(`🤖 Trading Agent: ${summary}\n\n${tradeDetails}`);
    }

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
