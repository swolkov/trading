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
import { findBestContract, executeOptionsTrade, manageOptionsPositions, executeStraddle, executeSpread } from "./options-trader";
import { scanEarningsReactions, prePositionEarnings } from "./earnings-trader";
import { sellIronCondor, sellCreditSpread, defendPremiumPosition } from "./premium-seller";
import { scanQuickPlays, executeQuickPlay } from "./quick-plays";
import { generateMacroBriefing } from "./macro-briefing";
import { reviewTrade } from "./risk-agent";
import { scanGaps } from "./gap-scanner";
import { reviewClosedTrades } from "./trade-reviewer";
import { scanRelativeValue } from "./relative-value";
import { sendNotification, type NotifyChannel } from "./notifications";
import { analyzeStock } from "./ai-analyst";
import { getScoreAdjustment } from "./learning-engine";
import { analyzeVolatility } from "./options-intelligence";
import { checkCorrelationWithPortfolio, clearCorrelationCache } from "./correlation";
import { scoreLiquidity } from "./liquidity-agent";
import { getExecutionAdvice } from "./execution-quality";
import { evaluateDrawdownState, getDrawdownOverrides, isStrategyAllowed } from "./drawdown-protocol";
import { scanSector, type SectorScanResult } from "./sector-scanner";
import { getOptionsSnapshots } from "./alpaca";
import { prisma } from "./db";
import { getVaultContextForAI, logTradeToJournal, logDecision, logObservation } from "./vault";

// ============ DEFAULT RULES (overridden by database config) ============
const DEFAULT_RULES = {
  MAX_POSITIONS: 8,
  MAX_PER_SECTOR: 3,
  MAX_POSITION_PCT: 0.03,        // 3% of equity max per trade (~$2,700 on $91k)
  MIN_POSITION_PCT: 0.015,       // 1.5% of equity min per trade (~$1,350)
  MIN_CASH_RESERVE_PCT: 0.20,
  MIN_SCORE_TO_BUY: 45,
  MIN_CONFIDENCE: 60,
  STOP_ATR_MULTIPLIER: 2.0,
  MAX_STOP_PCT: 0.10,
  MIN_STOP_PCT: 0.03,
  TRAILING_ACTIVATION_PCT: 0.05,
  TRAILING_ATR_MULTIPLIER: 1.5,
  TAKE_PROFIT_PCT: 0.25,
  MAX_DAILY_TRADES: 4,
  COOLDOWN_HOURS: 12,
  LIMIT_ORDER_DISCOUNT: 0.001,
  EARNINGS_BLACKOUT_DAYS: 5,
  MIN_VOLUME_RATIO: 0.5,
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
  rules: { MIN_POSITION_PCT: number; MAX_POSITION_PCT: number; MIN_SCORE_TO_BUY: number } = DEFAULT_RULES,
  annualizedVol?: number // stock's 20-day annualized volatility (0-1 scale)
): number {
  const baseRatio = rules.MIN_POSITION_PCT;
  const maxRatio = rules.MAX_POSITION_PCT;
  const scoreRange = 100 - rules.MIN_SCORE_TO_BUY;
  const absScore = Math.abs(score);
  const scoreFactor = Math.min(1, (absScore - rules.MIN_SCORE_TO_BUY) / scoreRange);
  const confidenceFactor = Math.min(1, confidence / 100);

  let ratio = baseRatio + (maxRatio - baseRatio) * scoreFactor * confidenceFactor;
  ratio *= regimeMultiplier;

  // Volatility normalization: high-vol stocks get smaller positions
  // Target: a 5% position in a 15% vol stock = same risk as 2.5% position in 30% vol stock
  // Baseline vol = 25% annualized (typical large cap). Adjust proportionally.
  if (annualizedVol && annualizedVol > 0) {
    const baselineVol = 0.25;
    const volAdjust = Math.max(0.4, Math.min(1.5, baselineVol / annualizedVol));
    ratio *= volAdjust;
  }

  const positionValue = equity * ratio;
  return Math.floor(positionValue / price);
}

// Calculate annualized volatility from price bars
function calculateAnnualizedVol(bars: { c: number }[]): number {
  if (bars.length < 21) return 0.25; // default 25%
  const returns: number[] = [];
  for (let i = bars.length - 20; i < bars.length; i++) {
    returns.push(Math.log(bars[i].c / bars[i - 1].c));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  return Math.sqrt(variance * 252);
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

    // Step 0: Morning macro briefing from Head Strategist
    let macroBriefing = "";
    try {
      const briefing = await generateMacroBriefing();
      macroBriefing = `MACRO BRIEFING: ${briefing.summary}\nBias: ${briefing.bias.toUpperCase()}\nFavor: ${briefing.sectorFavors.join(", ") || "none"}\nAvoid: ${briefing.sectorAvoids.join(", ") || "none"}\nToday's rules: ${briefing.tradingRules.join(" | ")}`;
      details.push(macroBriefing);
    } catch {
      details.push("MACRO BRIEFING: Unable to generate");
    }

    // Step 0b: Review past trades and extract lessons
    try {
      const lessons = await reviewClosedTrades();
      if (lessons.length > 0) {
        details.push(`LESSONS LEARNED: ${lessons.length} insights from past trades`);
      }
    } catch { /* ignore */ }

    // Step 0c: Load Obsidian vault intelligence
    let vaultContext = "";
    try {
      vaultContext = await getVaultContextForAI("options-agent", "premium-selling.md");
      if (vaultContext) details.push("VAULT BRAIN: Loaded regime, lessons, anti-patterns from Obsidian");
    } catch { /* vault optional */ }

    // Load permanent lessons from our first week of trading
    try {
      const permLessons = await prisma.agentConfig.findUnique({ where: { key: "permanent_lessons" } });
      if (permLessons?.value) {
        const lessonList = JSON.parse(permLessons.value);
        details.push(`PERMANENT RULES (${lessonList.length}): ${lessonList[0].slice(0, 80)}...`);
      }
    } catch { /* ignore */ }

    // Step 1b: Detect market regime
    let regime: RegimeAnalysis;
    try {
      regime = await detectMarketRegime();
      details.push(`REGIME: ${regime.regime.toUpperCase()} — ${regime.recommendation}`);
    } catch {
      regime = { regime: "choppy", positionSizeMultiplier: 0.8, cashReservePct: 25 } as RegimeAnalysis;
      details.push("REGIME: Unable to detect, using conservative defaults");
    }

    // Step 1c: Load regime transition + event catalyst overrides
    let regimeOverride = 1.0;
    let eventOverride = 1.0;
    try {
      const [regimeConfig, eventConfig] = await Promise.all([
        prisma.agentConfig.findUnique({ where: { key: "regime_size_override" } }),
        prisma.agentConfig.findUnique({ where: { key: "event_size_override" } }),
      ]);
      if (regimeConfig?.value) regimeOverride = parseFloat(regimeConfig.value) || 1.0;
      if (eventConfig?.value) eventOverride = parseFloat(eventConfig.value) || 1.0;
      if (regimeOverride !== 1.0) details.push(`REGIME TRANSITION: size override ${regimeOverride}x`);
      if (eventOverride !== 1.0) details.push(`EVENT CATALYST: size override ${eventOverride}x`);
    } catch { /* use defaults */ }

    // Step 1d: Evaluate drawdown protocol
    let drawdownMultiplier = 1.0;
    let drawdownMinScore = 0;
    try {
      const ddState = await evaluateDrawdownState();
      if (ddState.mode !== "NORMAL") {
        drawdownMultiplier = ddState.overrides.sizeMultiplier;
        drawdownMinScore = ddState.overrides.minScoreOverride;
        details.push(`DRAWDOWN: ${ddState.mode} — ${ddState.reason}`);
        details.push(`  DD overrides: size ${(drawdownMultiplier * 100).toFixed(0)}%, min score ${drawdownMinScore}, max pos ${ddState.overrides.maxPositions}`);
        if (ddState.mode === "LOCKDOWN") {
          details.push("LOCKDOWN: No new trades — managing existing positions only");
        }
      }
    } catch { /* use defaults */ }

    // Step 2: Get account state
    const account = await getAccount();
    const equity = parseFloat(account.equity);
    const cash = parseFloat(account.cash);
    const positions = await getPositions();

    // PDT CHECK: if day trading buying power is $0, we can only manage existing positions
    const dtBuyingPower = parseFloat(account.daytrading_buying_power || "0");
    const isPDTRestricted = account.pattern_day_trader && dtBuyingPower <= 0;
    if (isPDTRestricted) {
      details.push("PDT RESTRICTED: Day trading buying power is $0. Managing positions only — no new trades until restriction lifts.");
    }

    // Apply regime-adjusted cash reserve
    const effectiveCashReserve = Math.max(RULES.MIN_CASH_RESERVE_PCT, regime.cashReservePct / 100);

    // ============ SPENDING & SAFETY LIMITS ============
    // Safety limits — scale with account size (defaults for ~$5k account)
    // These are overridden by database config if set
    let dailyLossLimit = Math.max(100, equity * 0.05);     // 5% of equity
    let dailySpendCap = Math.max(500, equity * 0.50);      // 50% of equity
    let maxOptionsExposure = Math.max(1000, equity * 0.75); // 75% of equity
    let perTradeMax = Math.max(50, equity * 0.02);          // 2% of equity
    let drawdownKillPct = 10;                                // 10% always
    try {
      const configs = await prisma.agentConfig.findMany();
      const cm: Record<string, string> = {};
      for (const c of configs) cm[c.key] = c.value;
      if (cm.daily_loss_limit) dailyLossLimit = parseFloat(cm.daily_loss_limit);
      if (cm.daily_spend_cap) dailySpendCap = parseFloat(cm.daily_spend_cap);
      if (cm.max_options_exposure) maxOptionsExposure = parseFloat(cm.max_options_exposure);
      if (cm.per_trade_max) perTradeMax = parseFloat(cm.per_trade_max);
      if (cm.drawdown_kill_pct) drawdownKillPct = parseFloat(cm.drawdown_kill_pct);
    } catch { /* use defaults */ }

    // DRAWDOWN KILL SWITCH: if account dropped too much from peak, stop
    const portfolioValue = parseFloat(account.portfolio_value || account.equity);
    const lastEquityVal = parseFloat(account.last_equity);
    const startingCapital = 100000; // paper trading start
    const peakValue = Math.max(startingCapital, lastEquityVal, portfolioValue);
    const drawdownPct = ((peakValue - portfolioValue) / peakValue) * 100;
    if (drawdownPct >= drawdownKillPct) {
      const summary = `KILL SWITCH: Account down ${drawdownPct.toFixed(1)}% from peak (limit: ${drawdownKillPct}%). Agent paused.`;
      details.push(summary);
      await sendNotification(`🛑 ${summary}`, "general");
      await logRun("full", 0, 0, 0, 0, summary, startTime);
      return { runType: "full", stocksScanned: 0, tradesPlaced: 0, positionsManaged: 0, errors: 0, summary, details };
    }

    // DAILY LOSS CHECK: if already lost too much today, stop
    const dailyPnl = portfolioValue - lastEquityVal;
    if (dailyPnl < -dailyLossLimit) {
      const summary = `DAILY LOSS LIMIT: Down $${Math.abs(dailyPnl).toFixed(2)} today (limit: $${dailyLossLimit}). Stopping.`;
      details.push(summary);
      await logRun("full", 0, 0, 0, 0, summary, startTime);
      return { runType: "full", stocksScanned: 0, tradesPlaced: 0, positionsManaged: 0, errors: 0, summary, details };
    }

    // DAILY SPEND CHECK: how much have we already spent today on new trades?
    const todayBuys = await prisma.autoTradeLog.findMany({
      where: {
        createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        action: { in: ["buy", "buy_call", "buy_put", "earnings_call", "earnings_put", "buy_straddle_call", "buy_straddle_put", "spread_buy_call", "spread_buy_put"] },
      },
    });
    const todaySpent = todayBuys.reduce((sum, t) => sum + (t.price || 0) * (t.qty || 1) * 100, 0);
    const remainingBudget = dailySpendCap - todaySpent;

    if (remainingBudget <= 0) {
      const summary = `DAILY SPEND CAP: Already spent $${todaySpent.toFixed(0)} today (cap: $${dailySpendCap}). No more trades.`;
      details.push(summary);
      await logRun("full", 0, 0, 0, 0, summary, startTime);
      return { runType: "full", stocksScanned: 0, tradesPlaced: 0, positionsManaged: 0, errors: 0, summary, details };
    }

    // OPTIONS EXPOSURE CHECK: total value of current options positions
    const optionsPositions = positions.filter((p) => p.symbol.length > 10);
    const currentOptionsExposure = optionsPositions.reduce((sum, p) => sum + Math.abs(parseFloat(p.market_value)), 0);
    const optionsHeadroom = maxOptionsExposure - currentOptionsExposure;

    details.push(`Safety: Daily loss $${Math.abs(dailyPnl).toFixed(0)}/$${dailyLossLimit} | Spent $${todaySpent.toFixed(0)}/$${dailySpendCap} | Options exposure $${currentOptionsExposure.toFixed(0)}/$${maxOptionsExposure} | Drawdown ${drawdownPct.toFixed(1)}%/${drawdownKillPct}%`);

    // Consecutive loss protection: check last 5 closed trades
    let lossMultiplier = 1.0;
    try {
      const recentClosed = await prisma.autoTradeLog.findMany({
        where: { pnl: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 5,
      });
      const consecutiveLosses = recentClosed.findIndex((t) => (t.pnl || 0) > 0);
      if (consecutiveLosses >= 3) {
        lossMultiplier = 0.5; // Cut position sizes in half after 3 consecutive losses
        details.push(`⚠️ LOSS PROTECTION: ${consecutiveLosses} consecutive losses — reducing position sizes 50%`);
      } else if (consecutiveLosses === -1 && recentClosed.length >= 5) {
        lossMultiplier = 0.3; // All 5 recent trades are losses — nearly stop trading
        details.push(`🛑 HEAVY LOSS PROTECTION: All recent trades are losses — reducing sizes 70%`);
      }
    } catch { /* ignore */ }

    // Apply loss multiplier + regime transition + event catalyst + drawdown protocol to sizing
    const effectiveSizeMultiplier = regime.positionSizeMultiplier * lossMultiplier * regimeOverride * eventOverride * drawdownMultiplier;

    details.push(`Portfolio: $${equity.toFixed(2)} equity, $${cash.toFixed(2)} cash, ${positions.length} positions (regime: ${regime.regime}, sizing: ${effectiveSizeMultiplier.toFixed(2)}x${lossMultiplier < 1 ? " [loss protected]" : ""})`);

    // Step 3: Check daily trade count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = await prisma.autoTradeLog.count({
      where: {
        createdAt: { gte: todayStart },
        action: { in: ["buy", "sell", "stop_loss", "take_profit", "trailing_stop", "thesis_change", "partial_profit", "breakeven_stop", "dead_money", "spread_take_profit", "spread_stop_loss", "spread_expiry_close", "premium_defense_close", "premium_roll"] },
      },
    });

    if (todayTrades >= RULES.MAX_DAILY_TRADES) {
      const summary = `Daily trade limit reached (${todayTrades}/${RULES.MAX_DAILY_TRADES})`;
      details.push(summary);
      await logRun("full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, startTime);
      return { runType: "full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, details };
    }

    // ============ STEP 4: MANAGE EXISTING POSITIONS ============

    // === SPREAD DETECTION: Group paired options legs to prevent managing them independently ===
    // A spread = same underlying, same expiry, one long + one short, different strikes
    // We MUST close both legs together or neither — closing one leg leaves a naked position.
    const spreadLegs = new Set<string>(); // symbols that are part of a spread (managed as unit)

    const allOptionPositions = positions.filter((p) => p.symbol.length > 10);
    for (const pos of allOptionPositions) {
      const match = pos.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      if (!match) continue;
      const [, underlying, expDate, optType] = match;
      const qty = parseInt(pos.qty);

      // Find the other leg: same underlying, same expiry, same type (C or P), opposite direction
      const partner = allOptionPositions.find((p) => {
        if (p.symbol === pos.symbol) return false;
        const m = p.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        if (!m) return false;
        const partnerQty = parseInt(p.qty);
        return m[1] === underlying && m[2] === expDate && m[3] === optType &&
          ((qty > 0 && partnerQty < 0) || (qty < 0 && partnerQty > 0)); // opposite sides
      });

      if (partner) {
        spreadLegs.add(pos.symbol);
        spreadLegs.add(partner.symbol);
      }
    }

    if (spreadLegs.size > 0) {
      details.push(`SPREAD DETECTION: ${spreadLegs.size / 2} spread(s) identified — managing as units, not individual legs`);
    }

    // Group spreads for unified management
    const processedSpreads = new Set<string>(); // track which spreads we've already handled

    for (const pos of positions) {
      positionsManaged++;
      const currentPrice = parseFloat(pos.current_price);
      const entryPrice = parseFloat(pos.avg_entry_price);
      const qty = parseInt(pos.qty);
      const pnlPct = (currentPrice - entryPrice) / entryPrice;
      const isOptionsPosition = pos.symbol.length > 10; // Options symbols are longer

      // === OPTIONS MANAGEMENT ===
      if (isOptionsPosition) {

        // === SPREAD MANAGEMENT: handle both legs together ===
        if (spreadLegs.has(pos.symbol)) {
          if (processedSpreads.has(pos.symbol)) continue; // already handled with partner

          // Find the partner leg
          const match = pos.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
          if (!match) continue;
          const [, underlying, expDate, optType] = match;

          const partner = allOptionPositions.find((p) => {
            if (p.symbol === pos.symbol) return false;
            const m = p.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
            if (!m) return false;
            const pQty = parseInt(p.qty);
            return m[1] === underlying && m[2] === expDate && m[3] === optType &&
              ((qty > 0 && pQty < 0) || (qty < 0 && pQty > 0));
          });

          if (partner) {
            processedSpreads.add(pos.symbol);
            processedSpreads.add(partner.symbol);

            const longLeg = qty > 0 ? pos : partner;
            const shortLeg = qty < 0 ? pos : partner;
            const longStrike = longLeg.symbol.match(/(\d{8})$/)?.[1];
            const shortStrike = shortLeg.symbol.match(/(\d{8})$/)?.[1];

            // Combined P&L from Alpaca (already correct)
            const spreadPnl = parseFloat(pos.unrealized_pl) + parseFloat(partner.unrealized_pl);

            // For credit spreads: max profit = net credit received, max loss = spread width - credit
            const shortEntry = parseFloat(shortLeg.avg_entry_price);
            const longEntry = parseFloat(longLeg.avg_entry_price);
            const netCredit = (shortEntry - longEntry) * Math.abs(parseInt(shortLeg.qty)) * 100;
            const spreadWidth = Math.abs(parseInt(shortStrike || "0") - parseInt(longStrike || "0")) / 1000;
            const maxLoss = (spreadWidth - (shortEntry - longEntry)) * Math.abs(parseInt(shortLeg.qty)) * 100;

            // P&L as % of max profit (for take profit) and max loss (for stop)
            const pnlPctOfMaxProfit = netCredit > 0 ? spreadPnl / netCredit : 0;
            const pnlPctOfMaxLoss = maxLoss > 0 ? spreadPnl / maxLoss : 0;

            // Parse DTE
            const year = 2000 + parseInt(expDate.slice(0, 2));
            const month = parseInt(expDate.slice(2, 4)) - 1;
            const day = parseInt(expDate.slice(4, 6));
            const expiry = new Date(year, month, day);
            const dte = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

            const spreadDesc = `${underlying} $${parseInt(shortStrike || "0") / 1000}/$${parseInt(longStrike || "0") / 1000} ${optType === "P" ? "put" : "call"} spread`;

            // TAKE PROFIT: close at 50% of max credit collected
            if (pnlPctOfMaxProfit >= 0.50) {
              details.push(`  SPREAD TAKE PROFIT: ${spreadDesc} at ${(pnlPctOfMaxProfit * 100).toFixed(0)}% of max profit ($${spreadPnl.toFixed(0)}/$${netCredit.toFixed(0)}) — closing both legs`);
              try {
                // Close long leg (sell), close short leg (buy back)
                await placeOrder({ symbol: longLeg.symbol, qty: String(Math.abs(parseInt(longLeg.qty))), side: "sell", type: "market", time_in_force: "day" });
                await placeOrder({ symbol: shortLeg.symbol, qty: String(Math.abs(parseInt(shortLeg.qty))), side: "buy", type: "market", time_in_force: "day" });
                await logTrade(pos.symbol, "spread_take_profit", Math.abs(qty), currentPrice, `Spread take profit: ${spreadDesc} at ${(pnlPctOfMaxProfit * 100).toFixed(0)}% of max profit. P&L: $${spreadPnl.toFixed(2)}`, null, null, undefined, spreadPnl);
                tradesPlaced += 2;
              } catch (err) { errors++; details.push(`  Failed: ${err}`); }
              continue;
            }

            // STOP LOSS: if spread loss exceeds max risk (spread width - credit)
            if (spreadPnl <= -maxLoss * 0.90) {
              details.push(`  SPREAD STOP: ${spreadDesc} loss $${Math.abs(spreadPnl).toFixed(0)} near max risk $${maxLoss.toFixed(0)} — closing both legs`);
              try {
                await placeOrder({ symbol: longLeg.symbol, qty: String(Math.abs(parseInt(longLeg.qty))), side: "sell", type: "market", time_in_force: "day" });
                await placeOrder({ symbol: shortLeg.symbol, qty: String(Math.abs(parseInt(shortLeg.qty))), side: "buy", type: "market", time_in_force: "day" });
                await logTrade(pos.symbol, "spread_stop_loss", Math.abs(qty), currentPrice, `Spread stop: ${spreadDesc} loss $${Math.abs(spreadPnl).toFixed(0)} (max risk: $${maxLoss.toFixed(0)}). Closing.`, null, null, undefined, spreadPnl);
                tradesPlaced += 2;
              } catch (err) { errors++; details.push(`  Failed: ${err}`); }
              continue;
            }

            // CLOSE NEAR EXPIRY: if < 5 DTE, close the spread to avoid assignment risk
            if (dte <= 5) {
              details.push(`  SPREAD EXPIRY: ${spreadDesc} ${dte} DTE — closing both legs to avoid assignment`);
              try {
                await placeOrder({ symbol: longLeg.symbol, qty: String(Math.abs(parseInt(longLeg.qty))), side: "sell", type: "market", time_in_force: "day" });
                await placeOrder({ symbol: shortLeg.symbol, qty: String(Math.abs(parseInt(shortLeg.qty))), side: "buy", type: "market", time_in_force: "day" });
                await logTrade(pos.symbol, "spread_expiry_close", Math.abs(qty), currentPrice, `Spread expiry close: ${spreadDesc} at ${dte} DTE. P&L: $${spreadPnl.toFixed(2)}`, null, null, undefined, spreadPnl);
                tradesPlaced += 2;
              } catch (err) { errors++; details.push(`  Failed: ${err}`); }
              continue;
            }

            const profitPct = netCredit > 0 ? (pnlPctOfMaxProfit * 100).toFixed(0) : "N/A";
            details.push(`  ${spreadDesc}: ${spreadPnl >= 0 ? "+" : ""}$${spreadPnl.toFixed(0)} (${profitPct}% of max profit), ${dte} DTE — holding`);
            continue;
          }
        }

        // === STANDALONE OPTIONS: not part of a spread ===
        // Check if this is a SHORT options position (premium selling) — needs defense logic
        const isShortOptions = qty < 0;
        if (isShortOptions) {
          try {
            const defense = await defendPremiumPosition(pos, equity);
            if (defense.action !== "hold") tradesPlaced++;
            details.push(`  ${pos.symbol}: PREMIUM ${defense.action.replace(/_/g, " ").toUpperCase()} — ${defense.details}`);
          } catch (err) {
            details.push(`  ${pos.symbol}: Premium defense error — ${err}`);
          }
          continue;
        }

        // Long options management (profit targets, stops, partials)
        const optActions = await manageOptionsPositions([pos]);
        for (const act of optActions) {
          if (act.action !== "hold") tradesPlaced++;
          details.push(`  ${act.symbol}: ${act.action.toUpperCase()} — ${act.reason}`);
        }
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

      // Find original buy to calculate hold duration
      const originalBuy = await prisma.autoTradeLog.findFirst({
        where: { symbol: pos.symbol, action: { in: ["buy", "buy_call", "buy_put"] } },
        orderBy: { createdAt: "desc" },
      });
      const holdDays = originalBuy
        ? (Date.now() - new Date(originalBuy.createdAt).getTime()) / (1000 * 60 * 60 * 24)
        : 0;

      // === PARTIAL PROFIT-TAKING ===
      // At +15%: sell half, move mental stop to breakeven
      // At +30%: sell another quarter, trail the rest
      // At full TAKE_PROFIT_PCT: sell everything
      const hasPartialTake = originalBuy
        ? await prisma.autoTradeLog.count({
            where: { symbol: pos.symbol, action: "partial_profit", createdAt: { gte: originalBuy.createdAt } },
          })
        : 0;

      if (pnlPct >= 0.15 && pnlPct < RULES.TAKE_PROFIT_PCT && hasPartialTake === 0 && qty >= 2) {
        // First partial: sell half
        const sellQty = Math.max(1, Math.floor(qty / 2));
        details.push(`PARTIAL PROFIT: ${pos.symbol} up +${(pnlPct * 100).toFixed(1)}% — selling ${sellQty}/${qty} shares, breakeven stop on rest`);
        try {
          const order = await placeOrder({ symbol: pos.symbol, qty: String(sellQty), side: "sell", type: "market", time_in_force: "day" });
          await logTrade(pos.symbol, "partial_profit", sellQty, currentPrice, `Partial take #1: sold ${sellQty}/${qty} at +${(pnlPct * 100).toFixed(1)}%. Remaining ${qty - sellQty} shares with breakeven stop.`, null, null, order.id, parseFloat(pos.unrealized_pl) * (sellQty / qty));
          tradesPlaced++;
        } catch (err) { errors++; details.push(`  Failed: ${err}`); }
        continue;
      }

      if (pnlPct >= 0.30 && pnlPct < RULES.TAKE_PROFIT_PCT && hasPartialTake === 1 && qty >= 2) {
        // Second partial: sell another quarter (half of remaining)
        const sellQty = Math.max(1, Math.floor(qty / 2));
        details.push(`PARTIAL PROFIT #2: ${pos.symbol} up +${(pnlPct * 100).toFixed(1)}% — selling ${sellQty} more, trailing rest`);
        try {
          const order = await placeOrder({ symbol: pos.symbol, qty: String(sellQty), side: "sell", type: "market", time_in_force: "day" });
          await logTrade(pos.symbol, "partial_profit", sellQty, currentPrice, `Partial take #2: sold ${sellQty} more at +${(pnlPct * 100).toFixed(1)}%. Remaining ${qty - sellQty} shares trailing.`, null, null, order.id, parseFloat(pos.unrealized_pl) * (sellQty / qty));
          tradesPlaced++;
        } catch (err) { errors++; details.push(`  Failed: ${err}`); }
        continue;
      }

      // After first partial take, breakeven stop replaces ATR stop
      const effectiveStopPct = hasPartialTake > 0 ? 0 : stopPct;

      // TRAILING STOP: if position is up enough, trail the stop
      if (pnlPct >= RULES.TRAILING_ACTIVATION_PCT) {
        const trailDistance = atr * RULES.TRAILING_ATR_MULTIPLIER;
        const trailStopPrice = currentPrice - trailDistance;
        const trailFromHigh = (currentPrice - trailStopPrice) / currentPrice;

        const highWaterMark = entryPrice * (1 + pnlPct);
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

      // BREAKEVEN STOP: after partial profit-taking, don't let winners become losers
      if (hasPartialTake > 0 && pnlPct <= 0) {
        details.push(`BREAKEVEN STOP: ${pos.symbol} gave back gains after partial take — selling at ${(pnlPct * 100).toFixed(1)}%`);
        try {
          const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
          await logTrade(pos.symbol, "breakeven_stop", qty, currentPrice, `Breakeven stop after partial profit: ${(pnlPct * 100).toFixed(1)}%`, null, null, order.id, parseFloat(pos.unrealized_pl));
          tradesPlaced++;
        } catch (err) { errors++; details.push(`  Failed: ${err}`); }
        continue;
      }

      // HARD STOP LOSS (ATR-based)
      if (pnlPct <= -stopPct) {
        details.push(`STOP LOSS: ${pos.symbol} down ${(pnlPct * 100).toFixed(1)}% (ATR stop: -${(stopPct * 100).toFixed(1)}%) — selling`);
        try {
          const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
          await logTrade(pos.symbol, "stop_loss", qty, currentPrice, `ATR stop: down ${(pnlPct * 100).toFixed(1)}% (limit: -${(stopPct * 100).toFixed(1)}%)`, null, null, order.id, parseFloat(pos.unrealized_pl));
          tradesPlaced++;
          try { await logDecision("auto-trader", "EXIT", pos.symbol, `STOP LOSS: down ${(pnlPct * 100).toFixed(1)}%`, 1); } catch {}
        } catch (err) { errors++; details.push(`  Failed: ${err}`); }
        continue;
      }

      // HARD TAKE PROFIT (full exit)
      if (pnlPct >= RULES.TAKE_PROFIT_PCT) {
        details.push(`TAKE PROFIT: ${pos.symbol} up ${(pnlPct * 100).toFixed(1)}% — selling all`);
        try {
          const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
          await logTrade(pos.symbol, "take_profit", qty, currentPrice, `Up ${(pnlPct * 100).toFixed(1)}%`, null, null, order.id, parseFloat(pos.unrealized_pl));
          tradesPlaced++;
          try { await logDecision("auto-trader", "EXIT", pos.symbol, `TAKE PROFIT: up ${(pnlPct * 100).toFixed(1)}%`, 5); } catch {}
        } catch (err) { errors++; details.push(`  Failed: ${err}`); }
        continue;
      }

      // === DEAD MONEY DETECTION ===
      // If held > 10 days and moved < 3%, the capital is better deployed elsewhere
      if (holdDays > 10 && Math.abs(pnlPct) < 0.03) {
        details.push(`DEAD MONEY: ${pos.symbol} held ${holdDays.toFixed(0)} days, only ${(pnlPct * 100).toFixed(1)}% move — freeing capital`);
        try {
          const order = await placeOrder({ symbol: pos.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
          await logTrade(pos.symbol, "dead_money", qty, currentPrice, `Dead money exit: held ${holdDays.toFixed(0)} days with ${(pnlPct * 100).toFixed(1)}% return. Capital better used elsewhere.`, null, null, order.id, parseFloat(pos.unrealized_pl));
          tradesPlaced++;
        } catch (err) { errors++; details.push(`  Failed: ${err}`); }
        continue;
      }

      // THESIS RE-EVALUATION: Check if original analysis still holds
      const originalReport = await prisma.researchReport.findFirst({
        where: { symbol: pos.symbol },
        orderBy: { createdAt: "desc" },
      });

      if (originalReport && originalReport.score > 0) {
        if (holdDays > 3) {
          try {
            const news = await getNews([pos.symbol], 3);
            const hasNegativeNews = news.some((n) =>
              n.headline.toLowerCase().match(/downgrade|lawsuit|recall|investigation|fraud|miss|cut|warning|loss/)
            );

            if (hasNegativeNews && pnlPct < 0) {
              details.push(`THESIS CHANGE: ${pos.symbol} negative news + underwater — re-evaluating...`);
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

      const partialNote = hasPartialTake > 0 ? ` [${hasPartialTake} partial takes, BE stop]` : "";
      const holdNote = holdDays > 5 ? ` [${holdDays.toFixed(0)}d]` : "";
      details.push(`  ${pos.symbol}: ${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(1)}% (stop: -${(effectiveStopPct * 100).toFixed(1)}%)${partialNote}${holdNote} — holding`);
    }

    // ============ STEP 4b: EARNINGS REACTION TRADES ============
    try {
      details.push("\nScanning for earnings reactions...");
      const earningsPlays = await scanEarningsReactions(equity);
      for (const play of earningsPlays) {
        if (play.success) {
          details.push(`  EARNINGS PLAY: ${play.symbol} ${play.direction === "bullish" ? "BEAT" : "MISSED"} by ${Math.abs(play.surprisePct).toFixed(1)}%, gap ${play.gapPct >= 0 ? "+" : ""}${play.gapPct.toFixed(1)}% → ${play.action} ${play.contractSymbol} x${play.qty}`);
          tradesPlaced++;
        } else if (play.action === "skip") {
          details.push(`  EARNINGS: ${play.symbol} ${play.direction} surprise ${Math.abs(play.surprisePct).toFixed(1)}% — ${play.reasoning}`);
        }
      }
      if (earningsPlays.length === 0) {
        details.push("  No actionable earnings reactions found");
      }
    } catch (err) {
      details.push(`  Earnings scan error: ${err}`);
    }

    // Load focus symbols early (used by pre-positioning and candidate selection)
    let focusSymbols: string[] = [];
    let blacklist: string[] = [];
    try {
      const focusConfig = await prisma.agentConfig.findUnique({ where: { key: "focus_symbols" } });
      const blacklistConfig = await prisma.agentConfig.findUnique({ where: { key: "blacklist" } });
      if (focusConfig?.value) focusSymbols = focusConfig.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (blacklistConfig?.value) blacklist = blacklistConfig.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    } catch { /* ignore */ }

    // ============ STEP 4c: PRE-POSITION FOR UPCOMING EARNINGS ============
    try {
      details.push("\nPre-positioning for upcoming earnings...");
      const preEarnings = await prePositionEarnings(equity, focusSymbols);
      for (const pe of preEarnings) {
        details.push(`  ${pe.symbol}: ${pe.action.toUpperCase()} — ${pe.details}`);
        if (pe.success) tradesPlaced += 2; // straddle = 2 legs
      }
      if (preEarnings.length === 0) {
        details.push("  No upcoming earnings in focus list (2-5 days out)");
      }
    } catch (err) {
      details.push(`  Earnings pre-position error: ${err}`);
    }

    // ============ STEP 4d: PORTFOLIO GREEKS ============
    let portfolioDelta = 0;
    let portfolioTheta = 0;
    try {
      const optPositions = positions.filter((p) => p.symbol.length > 10);
      if (optPositions.length > 0) {
        const optSymbols = optPositions.map((p) => p.symbol);
        const snapshots = await getOptionsSnapshots(optSymbols);
        let totalTheta = 0;
        let totalGamma = 0;
        for (const pos of optPositions) {
          const snap = snapshots[pos.symbol];
          const qty = parseInt(pos.qty);
          if (snap?.greeks) {
            portfolioDelta += (snap.greeks.delta || 0) * qty * 100;
            totalTheta += (snap.greeks.theta || 0) * qty * 100;
            totalGamma += (snap.greeks.gamma || 0) * qty * 100;
          }
        }
        const directionText = portfolioDelta > 50 ? "bullish" : portfolioDelta < -50 ? "bearish" : "neutral";
        details.push(`PORTFOLIO GREEKS: Delta: ${portfolioDelta.toFixed(0)} (${directionText}), Theta: $${totalTheta.toFixed(2)}/day, Gamma: ${totalGamma.toFixed(2)}`);
        if (totalTheta < -100) {
          details.push("⚠️ HIGH THETA DECAY: Losing >$100/day to time decay — consider closing some positions");
        }
        portfolioTheta = totalTheta;
      }
    } catch { /* greeks optional */ }

    // Clear correlation cache for this run
    clearCorrelationCache();

    // ============ STEP 5: AI RESEARCH + MECHANICAL TRADES ============
    const activePositions = positions.filter((p) => Math.abs(parseFloat(p.market_value)) > 1);
    if (!isPDTRestricted && activePositions.length < RULES.MAX_POSITIONS && tradesPlaced + todayTrades < RULES.MAX_DAILY_TRADES) {
      details.push("\n=== MECHANICAL TRADES (pairs + sector signals — no AI needed) ===");

      // Cooldown: skip symbols traded in the last 4 hours to prevent churning
      const cooldownTime = new Date(Date.now() - 4 * 60 * 60 * 1000);
      const recentTrades = await prisma.autoTradeLog.findMany({
        where: { createdAt: { gte: cooldownTime } },
        select: { symbol: true },
      });
      const recentSymbols = new Set(recentTrades.map((t) => t.symbol.replace(/\d.*$/, "")));

      // Pairs trades: buy calls on stocks lagging peers by 10%+
      try {
        const rvSignals = await scanRelativeValue([...focusSymbols.slice(0, 30)]);
        const strongLaggards = rvSignals.filter((s) => s.signal === "laggard_buy" && s.strength !== "weak" && Math.abs(s.divergence) >= 10);

        for (const rv of strongLaggards.slice(0, 2)) {
          if (tradesPlaced + todayTrades >= RULES.MAX_DAILY_TRADES) break;
          if (positions.some((p) => p.symbol.includes(rv.symbol))) continue;
          if (recentSymbols.has(rv.symbol)) { details.push(`  PAIRS: ${rv.symbol} — cooldown (traded recently)`); continue; }

          // Get price and find a 14-30 DTE call
          try {
            const snap = await getSnapshot(rv.symbol);
            const price = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
            if (price < 20) continue;

            const direction = "bullish" as const;
            // Always use "moderate" conviction for 14-30 DTE swing trades (not short-dated)
            const { contract, snapshot: optSnap, reasoning } = await findBestContract(rv.symbol, direction, price, 70, "moderate");

            if (contract) {
              const optResult = await executeOptionsTrade(rv.symbol, contract, optSnap, equity, 65, "buy", `[PAIRS] ${rv.reasoning}`);
              if (optResult.success) {
                details.push(`  PAIRS BUY: ${rv.symbol} — lagging peers by ${Math.abs(rv.divergence).toFixed(1)}%. ${optResult.reasoning}`);
                tradesPlaced++;
              } else {
                details.push(`  PAIRS: ${rv.symbol} — ${optResult.reasoning}`);
              }
            } else {
              details.push(`  PAIRS: ${rv.symbol} — ${reasoning}`);
            }
          } catch (err) {
            details.push(`  PAIRS: ${rv.symbol} error — ${err}`);
          }
        }

        // Also look for leaders to buy puts (stocks leading by 10%+ = overextended)
        const strongLeaders = rvSignals.filter((s) => s.signal === "leader_sell" && s.strength !== "weak" && Math.abs(s.divergence) >= 10);
        for (const rv of strongLeaders.slice(0, 1)) {
          if (tradesPlaced + todayTrades >= RULES.MAX_DAILY_TRADES) break;
          if (positions.some((p) => p.symbol.includes(rv.symbol))) continue;

          try {
            const snap = await getSnapshot(rv.symbol);
            const price = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
            if (price < 20) continue;

            const { contract, snapshot: optSnap, reasoning } = await findBestContract(rv.symbol, "bearish", price, 70, "moderate");
            if (contract) {
              const optResult = await executeOptionsTrade(rv.symbol, contract, optSnap, equity, 65, "sell", `[PAIRS] ${rv.reasoning}`);
              if (optResult.success) {
                details.push(`  PAIRS SELL: ${rv.symbol} — leading peers by ${Math.abs(rv.divergence).toFixed(1)}%. ${optResult.reasoning}`);
                tradesPlaced++;
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* pairs scanning optional */ }
    }

    // ============ STEP 5b: AI SWING TRADES (14-30 DTE, best setups) ============
    // 5-expert committee: technical, fundamental, sentiment, options strategist, risk manager.
    // Full research on each candidate — the REAL edge of this system.
    if (isPDTRestricted) {
      details.push(`Directional scanning: Skipped (PDT restricted)`);
    } else if (activePositions.length >= RULES.MAX_POSITIONS) {
      details.push(`At max positions (${activePositions.length}/${RULES.MAX_POSITIONS}) — not scanning`);
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

      // focusSymbols and blacklist already loaded in Step 4c
      const blacklistSet = new Set(blacklist);

      // Candidate selection: diversified sources
      const candidates = new Map<string, string>(); // symbol -> reason

      // PRIORITY: Focus symbols first (user's watchlist)
      for (const sym of focusSymbols) {
        if (!heldSymbols.has(sym) && !blacklistSet.has(sym)) {
          candidates.set(sym, "focus_watchlist");
        }
      }

      // Top gainers with momentum — $20 min price ensures liquid options
      gainers.slice(0, 20).forEach((m) => {
        if (!heldSymbols.has(m.symbol) && !blacklistSet.has(m.symbol) && m.price > 20 && m.percent_change < 15) {
          candidates.set(m.symbol, "momentum_gainer");
        }
      });

      // Oversold losers (contrarian bounce plays — only if drop isn't catastrophic)
      losers.slice(0, 15).forEach((m) => {
        if (!heldSymbols.has(m.symbol) && !blacklistSet.has(m.symbol) && m.price > 20 && m.percent_change > -10) {
          candidates.set(m.symbol, "oversold_bounce");
        }
      });

      // Most active (high liquidity = easier exits)
      active.slice(0, 15).forEach((m) => {
        if (!heldSymbols.has(m.symbol) && !blacklistSet.has(m.symbol) && m.price > 20) {
          candidates.set(m.symbol, "high_volume");
        }
      });

      // Gap stocks (high priority — strong momentum signals)
      try {
        const gaps = await scanGaps();
        for (const gap of gaps.slice(0, 10)) {
          if (!heldSymbols.has(gap.symbol) && !blacklistSet.has(gap.symbol) && gap.currentPrice > 20) {
            candidates.set(gap.symbol, `gap_${gap.direction}_${gap.strength}`);
            details.push(`  GAP: ${gap.symbol} ${gap.gapPct >= 0 ? "+" : ""}${gap.gapPct.toFixed(1)}% (${gap.strength}) — ${gap.recommendation}`);
          }
        }
      } catch { /* ignore */ }

      // Relative value: find stocks lagging their peers (Citadel pairs trading)
      try {
        const rvSignals = await scanRelativeValue([...focusSymbols.slice(0, 30)]);
        for (const rv of rvSignals.filter((s) => s.signal === "laggard_buy" && s.strength !== "weak").slice(0, 10)) {
          if (!heldSymbols.has(rv.symbol) && !blacklistSet.has(rv.symbol)) {
            candidates.set(rv.symbol, `relative_value_laggard`);
            details.push(`  PAIRS: ${rv.symbol} lagging peers by ${Math.abs(rv.divergence).toFixed(1)}% — ${rv.reasoning}`);
          }
        }
      } catch { /* ignore */ }

      // Sector Scanner: themed universe monitoring with RS, breakouts, and pass/fail
      let sectorScanResults: SectorScanResult[] = [];
      try {
        // Load active sectors from config, default to ai_capex
        let activeSectors = ["ai_capex"];
        try {
          const sectorConfig = await prisma.agentConfig.findUnique({ where: { key: "sector_scanner_sectors" } });
          if (sectorConfig?.value) activeSectors = sectorConfig.value.split(",").map((s) => s.trim()).filter(Boolean);
        } catch { /* use default */ }

        for (const sectorKey of activeSectors) {
          try {
            const sectorResult = await scanSector(sectorKey);
            sectorScanResults.push(sectorResult);
            details.push(`\n=== SECTOR: ${sectorResult.sectorHealth.sectorName} (${sectorResult.sectorHealth.signal.replace(/_/g, " ").toUpperCase()}) ===`);
            details.push(`  ${sectorResult.sectorHealth.summary}`);

            // Add passing candidates
            for (const c of sectorResult.candidates.slice(0, 10)) {
              if (!heldSymbols.has(c.symbol) && !blacklistSet.has(c.symbol)) {
                const reason = c.breakout
                  ? `sector_breakout_${c.breakout.breakoutDirection}`
                  : c.direction === "bullish" ? "sector_rs_leader" : "sector_rs_laggard";
                candidates.set(c.symbol, reason);
                const detail = c.breakout
                  ? `${c.symbol}: RANGE BREAKOUT ${c.breakout.breakoutDirection.toUpperCase()} after ${c.breakout.rangeDays}d (+${c.breakout.breakoutPct.toFixed(1)}%, vol ${c.breakout.volumeRatio.toFixed(1)}x)${c.breakout.confirmed ? " CONFIRMED" : ""}`
                  : `${c.symbol}: RS rank #${c.rs.rsRank}, score ${c.score} (${c.direction})`;
                details.push(`  ${detail} — ${c.reasons[0] || ""}`);
              }
            }
          } catch (err) {
            details.push(`  Sector scan error (${sectorKey}): ${err}`);
          }
        }
      } catch { /* ignore */ }

      details.push(`Found ${candidates.size} candidates from ${gainers.length} gainers, ${losers.length} losers, ${active.length} active${sectorScanResults.length > 0 ? `, ${sectorScanResults.length} sector scans` : ""}`);

      // Cooldown check — skip cooldown entirely if we have no positions (fresh start)
      let recentSymbols = new Set<string>();
      if (positions.length > 0) {
        const cooldownTime = new Date(Date.now() - RULES.COOLDOWN_HOURS * 60 * 60 * 1000);
        const recentReports = await prisma.researchReport.findMany({
          where: { createdAt: { gte: cooldownTime } },
          select: { symbol: true },
        });
        recentSymbols = new Set(recentReports.map((r) => r.symbol));
      } else {
        details.push("No positions — cooldown bypassed, re-analyzing everything");
      }

      // Prioritize candidates: special signals first (gaps, sector breakouts, pairs, momentum), then focus watchlist
      // This ensures high-signal candidates get analyzed before hitting the AI limit
      const prioritized = [...candidates.entries()].sort(([, a], [, b]) => {
        const priority = (r: string) =>
          r.startsWith("sector_breakout") ? 0 :
          r.startsWith("gap_") ? 1 :
          r.startsWith("relative_value") ? 2 :
          r.startsWith("sector_rs") ? 3 :
          r.startsWith("momentum") ? 4 :
          r === "oversold_bounce" ? 5 :
          r === "high_volume" ? 6 :
          7; // focus_watchlist last (they often score "hold")
        return priority(a) - priority(b);
      });

      // Analyze and potentially buy — cap AI analyses to avoid timeout
      // Each AI call takes ~20-30s. With macro briefing + trade review + scanning,
      // we only have ~120s left for stock analysis before Vercel's 300s limit.
      let aiAnalysesRun = 0;
      const MAX_AI_ANALYSES = 3;
      for (const [symbol, reason] of prioritized) {
        if (tradesPlaced + todayTrades >= RULES.MAX_DAILY_TRADES) break;
        if (positions.length + tradesPlaced >= RULES.MAX_POSITIONS) break;
        if (aiAnalysesRun >= MAX_AI_ANALYSES) {
          details.push(`Hit AI analysis limit (${MAX_AI_ANALYSES}) — stopping scan to avoid timeout`);
          break;
        }
        // Time guard: exit gracefully before Vercel 300s timeout
        if (Date.now() - startTime > 240_000) {
          details.push(`Time guard: ${Math.round((Date.now() - startTime) / 1000)}s elapsed — stopping to avoid 504 timeout`);
          break;
        }

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
          // Relax volume filter in first hour after open (9:30-10:30 ET) — volume builds throughout the day
          const now = new Date();
          const etHour = now.getUTCHours() - 4; // rough ET conversion
          const earlySession = etHour < 11; // before 10:30am ET
          const volumeThreshold = earlySession ? RULES.MIN_VOLUME_RATIO * 0.5 : RULES.MIN_VOLUME_RATIO;
          if (avgVolume > 0 && recentVolume / avgVolume < volumeThreshold) {
            details.push(`  ${symbol}: skipped (low volume: ${(recentVolume / avgVolume * 100).toFixed(0)}% of avg, need ${(volumeThreshold * 100).toFixed(0)}%)`);
            continue;
          }

          // RSI and trend checks — but DON'T block bearish plays or special signals
          const closes = bars.map((b) => b.c);
          const rsi = calculateRSI(closes);
          const sma50 = sma(closes, 50);
          const currentClose = closes[closes.length - 1];
          const isSpecialSignal = reason.startsWith("gap_") || reason.startsWith("relative_value") || reason.startsWith("momentum") || reason === "oversold_bounce";

          // RSI > 85 = overbought, but let AI decide if it's momentum or reversal
          // RSI > 80 only blocks if NOT a special signal (gaps, pairs, momentum)
          if (rsi && rsi > 85 && !isSpecialSignal) {
            details.push(`  ${symbol}: skipped (RSI ${rsi.toFixed(0)} — extreme overbought)`);
            continue;
          }

          // Below 50-SMA check — skip for bearish plays (we WANT to buy puts on downtrending stocks)
          // and for special signals (pairs, mean reversion, etc.)
          if (sma50 && currentClose < sma50 * 0.97 && !isSpecialSignal) {
            details.push(`  ${symbol}: skipped (below 50-SMA, not in uptrend)`);
            continue;
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

          // === PORTFOLIO BALANCE CHECK ===
          // Count current directional bias to avoid loading all one direction
          const currentPuts = positions.filter((p) => p.symbol.length > 10 && p.symbol.includes("P0")).length +
            (tradesPlaced > 0 ? 1 : 0); // rough count
          const currentCalls = positions.filter((p) => p.symbol.length > 10 && p.symbol.includes("C0")).length;
          const bearBias = currentPuts > currentCalls + 3; // heavily bearish
          const bullBias = currentCalls > currentPuts + 3; // heavily bullish
          if (bearBias) {
            details.push(`  ⚖️ Portfolio is heavily bearish (${currentPuts} puts vs ${currentCalls} calls) — favoring bullish opportunities`);
          }

          // === FULL AI ANALYSIS ===
          details.push(`  Analyzing ${symbol} (${reason})...`);
          aiAnalysesRun++;
          const analysis = await analyzeStock(symbol);

          // === LEARNING ENGINE FEEDBACK: adjust score based on historical performance ===
          const report = await prisma.researchReport.findFirst({
            where: { symbol },
            orderBy: { createdAt: "desc" },
            select: { sector: true },
          });
          const sectorForLearning = report?.sector || "Unknown";
          const learningAdj = await getScoreAdjustment(symbol, sectorForLearning, reason);
          if (learningAdj.multiplier !== 1.0) {
            const originalScore = analysis.score;
            analysis.score = Math.round(analysis.score * learningAdj.multiplier);
            analysis.score = Math.max(-100, Math.min(100, analysis.score));
            for (const lr of learningAdj.reasons) {
              details.push(`  LEARNING: ${lr}`);
            }
            details.push(`  ${symbol}: score adjusted ${originalScore} → ${analysis.score} (${learningAdj.multiplier.toFixed(2)}x)`);
          }

          details.push(`  ${symbol}: score=${analysis.score}, signal=${analysis.signal}, conf=${analysis.confidence}%`);

          // Check trade criteria — bullish (buy calls) OR bearish (buy puts)
          // NO regime adjustment — directional bets need REAL conviction (score 70+)
          // Premium selling handles the choppy market. This section is for home runs only.
          const effectiveMinScore = RULES.MIN_SCORE_TO_BUY;
          const effectiveMinConf = RULES.MIN_CONFIDENCE;

          // If portfolio is heavily one-directional (by position count OR delta), lower threshold for opposite
          const deltaIsVeryBearish = portfolioDelta < -200;
          const deltaIsVeryBullish = portfolioDelta > 200;
          const bullishThreshold = (bearBias || deltaIsVeryBearish) ? Math.max(20, effectiveMinScore - 10) : effectiveMinScore;
          const bearishThreshold = (bullBias || deltaIsVeryBullish) ? Math.max(20, effectiveMinScore - 10) : effectiveMinScore;

          // Accept trades when score is strong enough — don't require exact signal match
          // Score 45+ with "hold" is still worth a trade (AI is being cautious, score says otherwise)
          const isBullish = analysis.score >= bullishThreshold &&
            analysis.confidence >= effectiveMinConf &&
            analysis.signal !== "sell" && analysis.signal !== "strong_sell"; // anything except bearish
          const isBearish = analysis.score <= -bearishThreshold &&
            analysis.confidence >= effectiveMinConf &&
            analysis.signal !== "buy" && analysis.signal !== "strong_buy"; // anything except bullish

          if (isBullish || isBearish) {
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

            const stockVol = calculateAnnualizedVol(bars);
            const qty = calculatePositionSize(equity, analysis.score, analysis.confidence, price, effectiveSizeMultiplier, { ...RULES, MIN_SCORE_TO_BUY: effectiveMinScore }, stockVol);
            if (qty <= 0) {
              details.push(`  ${symbol}: SKIP — position too small`);
              continue;
            }

            const positionValue = qty * price;
            if (positionValue > availableCash) {
              details.push(`  ${symbol}: SKIP — exceeds available cash`);
              continue;
            }

            // Check options_only mode (UI stores this as trade_options=true, legacy key: options_only)
            let optionsOnlyMode = false;
            try {
              const [optOnlyConfig, tradeOptionsConfig] = await Promise.all([
                prisma.agentConfig.findUnique({ where: { key: "options_only" } }),
                prisma.agentConfig.findUnique({ where: { key: "trade_options" } }),
              ]);
              optionsOnlyMode = optOnlyConfig?.value === "true" || tradeOptionsConfig?.value === "true";
            } catch { /* default false */ }

            if (!optionsOnlyMode && isBullish) {
              // === STOCK ENTRY GATE ===
              // Stocks require HIGHER conviction than options — 0% WR in first 10 trades was due to
              // low-conviction entries. Now require: score ≥ 65, conf ≥ 70, above 20-SMA, volume surge.
              // Can be toggled via DB config: stocks_enabled = "true"/"false"/"paper"

              let stocksMode: "disabled" | "paper" | "live" = "paper";
              try {
                const stockConfig = await prisma.agentConfig.findUnique({ where: { key: "stocks_enabled" } });
                const val = stockConfig?.value?.toLowerCase();
                if (val === "true" || val === "live") stocksMode = "live";
                else if (val === "paper") stocksMode = "paper";
                else if (val === "false" || val === "disabled") stocksMode = "disabled";
              } catch { /* default paper */ }

              if (stocksMode === "disabled") {
                details.push(`  ${symbol}: STOCKS DISABLED (set stocks_enabled=paper or live to enable)`);
                continue;
              }

              // Higher bar for stocks: score ≥ 65, confidence ≥ 70%
              const STOCK_MIN_SCORE = 65;
              const STOCK_MIN_CONF = 70;
              if (analysis.score < STOCK_MIN_SCORE || analysis.confidence < STOCK_MIN_CONF) {
                details.push(`  ${symbol}: STOCK SKIP — score ${analysis.score} (need ${STOCK_MIN_SCORE}), conf ${analysis.confidence}% (need ${STOCK_MIN_CONF}%)`);
                continue;
              }

              // Technical confirmation: must be above 20-SMA and showing volume surge
              const sma20 = sma(closes, 20);
              const volumeSurge = avgVolume > 0 ? recentVolume / avgVolume : 0;
              if (sma20 && currentClose < sma20) {
                details.push(`  ${symbol}: STOCK SKIP — below 20-SMA ($${currentClose.toFixed(2)} < $${sma20.toFixed(2)})`);
                continue;
              }
              if (volumeSurge < 1.2) {
                details.push(`  ${symbol}: STOCK SKIP — no volume confirmation (${(volumeSurge * 100).toFixed(0)}% of avg, need 120%+)`);
                continue;
              }

              // RSI sanity: don't buy overbought stocks (>75)
              if (rsi && rsi > 75) {
                details.push(`  ${symbol}: STOCK SKIP — RSI overbought (${rsi.toFixed(0)})`);
                continue;
              }

              // EXECUTION QUALITY — get optimal order type and limit price
              let execType: "market" | "limit" = "limit";
              let limitPrice: string;
              try {
                const quote = await getQuote(symbol);
                const advice = getExecutionAdvice(symbol, "buy", quote.bp, quote.ap, qty);
                execType = advice.recommendedType;
                limitPrice = advice.limitPrice
                  ? advice.limitPrice!.toFixed(2)
                  : (price * (1 - RULES.LIMIT_ORDER_DISCOUNT)).toFixed(2);
                if (advice.recommendedType === "limit" && advice.limitPrice) {
                  details.push(`  EXEC: ${advice.reason}`);
                }
              } catch {
                limitPrice = (price * (1 - RULES.LIMIT_ORDER_DISCOUNT)).toFixed(2);
              }

              // Calculate ATR-based stop and target
              const atr = calculateATR(bars);
              const stopDistance = atr * RULES.STOP_ATR_MULTIPLIER;
              const stopPrice = (price - stopDistance).toFixed(2);
              const targetPrice = analysis.priceTarget || price * 1.15;
              const riskReward = stopDistance > 0 ? ((targetPrice as number) - price) / stopDistance : 0;

              // Require minimum 1.5:1 risk/reward
              if (riskReward < 1.5) {
                details.push(`  ${symbol}: STOCK SKIP — R:R too low (${riskReward.toFixed(1)}:1, need 1.5:1+)`);
                continue;
              }

              if (stocksMode === "paper") {
                // Paper trade mode: log what WOULD have happened without executing
                details.push(`  ${symbol}: STOCK PAPER TRADE — BUY ${qty} @ $${price.toFixed(2)}, Stop $${stopPrice}, Target $${(targetPrice as number).toFixed(2)}, R:R ${riskReward.toFixed(1)}:1 (score: ${analysis.score}, conf: ${analysis.confidence}%)`);
                await logTrade(
                  symbol, "stock_paper", qty, price,
                  `[PAPER] [${reason}] Score: ${analysis.score}, Conf: ${analysis.confidence}%. Stop: $${stopPrice}. Target: $${(targetPrice as number).toFixed(2)}. R:R: ${riskReward.toFixed(1)}:1. ${analysis.summary.slice(0, 120)}`,
                  analysis.score, analysis.signal
                );
              } else {
                // Live stock execution
                details.push(`  BUY ${symbol}: ${qty} shares, ${execType} $${limitPrice} (score: ${analysis.score}, R:R ${riskReward.toFixed(1)}:1, ${reason})`);

                const order = await placeOrder({
                  symbol,
                  qty: String(qty),
                  side: "buy",
                  type: execType,
                  time_in_force: "day",
                  ...(execType === "limit" ? { limit_price: limitPrice } : {}),
                });

                heldSectors[sector] = (heldSectors[sector] || 0) + 1;

                await logTrade(
                  symbol, "buy", qty, price,
                  `[${reason}] Score: ${analysis.score}, Signal: ${analysis.signal}, Conf: ${analysis.confidence}%. Stop: $${stopPrice} (ATR: $${atr.toFixed(2)}). Target: $${(targetPrice as number).toFixed(2)}. R:R: ${riskReward.toFixed(1)}:1. ${analysis.summary.slice(0, 150)}`,
                  analysis.score, analysis.signal, order.id
                );
                tradesPlaced++;

                // Log to Obsidian vault
                try {
                  await logTradeToJournal({
                    tradeId: `${new Date().toISOString().slice(0, 10)}-STK-${order.id.slice(-4)}`,
                    timestamp: new Date().toISOString(),
                    instrument: symbol,
                    direction: "LONG",
                    strategy: reason.includes("premium") ? "premium-selling" : "swing",
                    setupType: reason,
                    contracts: qty,
                    entryPrice: price,
                    stopPrice: parseFloat(stopPrice),
                    targetPrice: targetPrice as number,
                    conviction: Math.round(analysis.score / 20),
                  }, "auto-trader");
                  await logDecision("auto-trader", "ENTRY", symbol,
                    `${reason}: Score ${analysis.score}, ${analysis.signal}, ${analysis.confidence}% conf, R:R ${riskReward.toFixed(1)}:1`,
                    Math.round(analysis.score / 20));
                } catch { /* vault optional */ }
              }
            } else if (optionsOnlyMode || isBearish) {
              details.push(`  ${symbol}: ${isBearish ? "BEARISH — buying puts" : "OPTIONS-ONLY mode — buying options"}`);
            }

            // === RISK AGENT REVIEW — final gatekeeper before any trade ===
            const riskCheck = reviewTrade(
              symbol,
              isBearish ? "bearish" : "bullish",
              optionsOnlyMode ? "options" : "stock",
              price * (calculatePositionSize(equity, analysis.score, analysis.confidence, price, effectiveSizeMultiplier, { ...RULES, MIN_SCORE_TO_BUY: effectiveMinScore }) || 1),
              1,
              { equity, cash, positions, portfolioDelta, dailyPnl, totalTheta: portfolioTheta }
            );
            if (!riskCheck.approved) {
              details.push(`  ${symbol}: RISK VETO — ${riskCheck.reason}`);
              await logTrade(symbol, "risk_veto", 0, null, riskCheck.reason, analysis.score, analysis.signal);
              continue;
            }
            if (riskCheck.reason !== "Approved") {
              details.push(`  ${symbol}: RISK NOTE — ${riskCheck.reason}`);
            }

            // === CORRELATION CHECK — avoid redundant correlated positions ===
            try {
              const corrCheck = await checkCorrelationWithPortfolio(symbol, positions);
              if (corrCheck.correlated) {
                // Correlated in same direction = skip (redundant risk)
                const existingIsPut = positions.some((p) => p.symbol.includes(corrCheck.with!) && p.symbol.includes("P0"));
                const newIsPut = isBearish;
                if (existingIsPut === newIsPut) {
                  details.push(`  ${symbol}: SKIP — correlated with ${corrCheck.with} (r=${corrCheck.correlation!.toFixed(2)}), same direction`);
                  continue;
                } else {
                  details.push(`  ${symbol}: Correlated with ${corrCheck.with} but OPPOSITE direction — good hedge`);
                }
              }
            } catch { /* correlation check optional */ }

            // === REGIME-GATED STRATEGY SELECTION ===
            // CHOPPY/RANGE_BOUND regime: BLOCK directional option buys — theta kills you
            // Only allow premium selling (iron condors, credit spreads) in choppy markets
            const direction = isBearish ? "bearish" as const : "bullish" as const;
            const absScore = Math.abs(analysis.score);
            const isHighConviction = absScore >= 70 && analysis.confidence >= 75;
            const isChoppyRegime = regime.regime === "choppy";

            if (isChoppyRegime) {
              // In choppy markets, ONLY allow premium selling strategies
              // Directional option buying = donating to theta decay
              details.push(`  ${symbol}: REGIME BLOCK — ${regime.regime.toUpperCase()} market, skipping directional options (theta trap). Only premium selling allowed.`);
              await logTrade(symbol, "regime_block", 0, null, `Blocked directional options in ${regime.regime} regime — theta decay risk`, analysis.score, analysis.signal);
              continue;
            }

            // Default: straight directional trade (only in TRENDING regimes)
            let optStrategy = direction === "bullish" ? "buy_call" : "buy_put";

            // Only override to spread if AI specifically recommended it AND conviction is low
            if (!isHighConviction && analysis.optionsPlay?.strategy) {
              const aiStrat = analysis.optionsPlay.strategy;
              if (aiStrat.includes("spread") || aiStrat.includes("iron_condor") || aiStrat.includes("straddle")) {
                optStrategy = aiStrat;
              }
            }

            // Map strategy names
            if (optStrategy === "sell_put_spread") optStrategy = "bull_call_spread";
            if (optStrategy === "sell_call_spread") optStrategy = "bear_put_spread";

            if (isHighConviction) {
              details.push(`  ${symbol}: HIGH CONVICTION (score ${analysis.score}, conf ${analysis.confidence}%) — STRAIGHT ${direction === "bullish" ? "CALL" : "PUT"}, no hedging`);
            }

            try {
              if (optStrategy === "iron_condor") {
                // IRON CONDOR — profit from stock staying in range (choppy market king)
                const icResult = await sellIronCondor(symbol, equity);
                details.push(`  ${icResult.details}`);
                if (icResult.success) tradesPlaced += 4;
              } else if (optStrategy === "bull_call_spread" || optStrategy === "bear_put_spread") {
                // SPREAD TRADE — defined risk
                const spreadDir = optStrategy === "bull_call_spread" ? "bull_call" as const : "bear_put" as const;
                const spreadResult = await executeSpread(symbol, spreadDir, equity, analysis.score, analysis.summary);
                details.push(`  ${spreadResult.details}`);
                if (spreadResult.success) tradesPlaced += 2; // 2 legs
              } else if (optStrategy === "straddle" || optStrategy === "strangle") {
                // STRADDLE — bet on big move either way (before earnings, etc.)
                const straddleResult = await executeStraddle(symbol, equity, analysis.score, analysis.summary);
                details.push(`  ${straddleResult.details}`);
                if (straddleResult.success) tradesPlaced += 2; // 2 legs
              } else {
                // SINGLE LEG — buy call or buy put
                // Determine conviction level for DTE selection
                const absScore = Math.abs(analysis.score);
                const aiConviction = analysis.optionsPlay?.conviction as "high" | "moderate" | "gamble" | undefined;
                const conviction: "high" | "moderate" | "gamble" = aiConviction || (
                  absScore >= 60 && analysis.confidence >= 85 ? "high" :
                  reason.startsWith("gap_") || reason.startsWith("momentum") ? "gamble" :
                  "moderate"
                );
                if (conviction !== "moderate") {
                  details.push(`  ${symbol}: ${conviction.toUpperCase()} conviction — ${conviction === "gamble" ? "7-14 DTE aggressive" : "7-21 DTE fast trade"}`);
                }
                const { contract, snapshot, reasoning } = await findBestContract(symbol, direction, price, analysis.confidence, conviction);
                if (contract) {
                  // LIQUIDITY CHECK — reject illiquid options before execution
                  try {
                    const liq = await scoreLiquidity(contract.symbol, true);
                    if (!liq.tradeable) {
                      details.push(`  ${symbol}: LIQUIDITY VETO — ${liq.warnings[0] || "illiquid"} (score: ${liq.score})`);
                      await logTrade(symbol, "liquidity_veto", 0, null, `Option ${contract.symbol} rejected: ${liq.recommendation}`, analysis.score, analysis.signal);
                      continue;
                    }
                    if (liq.score < 40) {
                      details.push(`  ${symbol}: LIQUIDITY WARNING — score ${liq.score}/100, ${liq.recommendation}`);
                    }
                  } catch { /* liquidity check optional — proceed */ }

                  const optResult = await executeOptionsTrade(symbol, contract, snapshot, equity, analysis.score, analysis.signal, analysis.summary);
                  if (optResult.success) {
                    details.push(`  OPTIONS: ${optResult.reasoning}`);
                    tradesPlaced++;
                  } else {
                    details.push(`  OPTIONS FAILED: ${optResult.reasoning}`);
                  }
                } else {
                  details.push(`  OPTIONS: ${reasoning}`);
                }
              }
            } catch (optErr) {
              details.push(`  OPTIONS ERROR: ${optErr}`);
            }
          } else {
            const reason_text = `Score ${analysis.score} (need ±${effectiveMinScore}), Conf ${analysis.confidence}% (need ${effectiveMinConf}%), Signal: ${analysis.signal}`;
            details.push(`  ${symbol}: SKIP — ${reason_text}`);
            await logTrade(symbol, "skip", 0, null, reason_text, analysis.score, analysis.signal);
          }
        } catch (err) {
          errors++;
          details.push(`  ${symbol}: ERROR — ${err}`);
        }
      }
    }

    // ============ STEP 6: QUICK PLAYS (SECONDARY — extreme setups only) ============
    // Only trade extreme RSI (<20 or >85) and big gaps (5%+). Small position, lottery ticket.
    const activePos = positions.filter((p) => Math.abs(parseFloat(p.market_value)) > 1);
    const tradesRemaining = RULES.MAX_DAILY_TRADES - tradesPlaced - todayTrades;
    if (!isPDTRestricted && activePos.length < RULES.MAX_POSITIONS && tradesRemaining >= 1) {
      try {
        details.push("\n=== QUICK PLAYS (extreme setups only — lottery tickets) ===");
        const plays = await scanQuickPlays(focusSymbols.slice(0, 15));
        // Only take the most extreme setups (confidence 75+)
        const extremePlays = plays.filter((p) => p.confidence >= 75);
        if (extremePlays.length === 0) {
          details.push("  No extreme setups found");
        }
        for (const play of extremePlays.slice(0, 1)) { // Max 1 quick play per run
          if (tradesPlaced + todayTrades >= RULES.MAX_DAILY_TRADES) break;
          if (positions.some((p) => p.symbol.includes(play.symbol))) continue;
          const result = await executeQuickPlay(play, equity);
          details.push(`  ${result.details}`);
          if (result.success) tradesPlaced++;
        }
      } catch (err) {
        details.push(`  Quick plays error: ${err}`);
      }
    }

    // Premium selling REMOVED — user wants directional only, no spreads/hedges
    // Spreads only placed if AI specifically recommends AND score < 70

    const summary = `[${regime.regime.toUpperCase()}] Scanned ${stocksScanned}, placed ${tradesPlaced} trades, managed ${positionsManaged} positions, ${errors} errors`;
    details.push(`\n${summary}`);
    await logRun("full", stocksScanned, tradesPlaced, positionsManaged, errors, summary, startTime);

    // Send notification if trades were placed or positions were closed
    if (tradesPlaced > 0) {
      const optionsDetails = details.filter((d) => d.includes("OPTIONS") || d.includes("CALL") || d.includes("PUT") || d.includes("SPREAD") || d.includes("STRADDLE")).join("\n");
      const stockDetails = details.filter((d) => !optionsDetails.includes(d) && (d.includes("BUY") || d.includes("STOP") || d.includes("TAKE PROFIT") || d.includes("TRAILING") || d.includes("THESIS"))).join("\n");

      if (optionsDetails) {
        await sendNotification(`🤖 Options Agent: ${summary}\n\n${optionsDetails}`, "options");
      }
      if (stockDetails) {
        await sendNotification(`🤖 Trading Agent: ${summary}\n\n${stockDetails}`, "general");
      }
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
