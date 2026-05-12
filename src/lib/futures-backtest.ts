// ============ FUTURES BACKTESTING ENGINE ============
// Replays historical 5m bar data through setup detection, simulates bracket order fills,
// and calculates per-setup statistics to validate or kill each strategy.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YFBacktest = require("yahoo-finance2").default || require("yahoo-finance2");
const yfBT = new YFBacktest({ suppressNotices: ["ripHistorical"] });

// ── Types ──────────────────────────────────────────────

interface Bar {
  t: number;  // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

type SetupType =
  | "opening_range_breakout"
  | "vwap_mean_reversion"
  | "trend_continuation"
  | "key_level_bounce"
  | "ema_crossover";

interface SimTrade {
  setup: SetupType;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  target: number;
  entryTime: number;
  exitPrice: number;
  exitTime: number;
  exitReason: "target" | "stop" | "eod";
  pnl: number;         // in points
  rMultiple: number;    // pnl / risk
  holdBars: number;
}

interface SetupStats {
  setup: SetupType;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;       // points
  avgLoss: number;      // points
  profitFactor: number;
  totalPnl: number;     // points
  maxDrawdown: number;  // points
  avgRMultiple: number;
  avgHoldBars: number;
  sharpe: number;
  verdict: "keep" | "optimize" | "kill";
}

export interface BacktestResult {
  symbol: string;
  period: string;
  totalBars: number;
  tradingDays: number;
  setups: SetupStats[];
  allTrades: SimTrade[];
  equity: number[];      // cumulative P&L curve (points)
  summary: {
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    totalPnl: number;
    maxDrawdown: number;
    sharpe: number;
    bestSetup: string;
    worstSetup: string;
  };
}

// ── Technical Indicators (mirrors futures-agent.ts) ──────

function ema(data: number[], period: number): number[] {
  if (data.length === 0) return [];
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
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcVwap(bars: { h: number; l: number; c: number; v: number }[]): {
  vwap: number; upperBand: number; lowerBand: number;
} {
  let cumPV = 0, cumV = 0, cumPV2 = 0;
  for (const bar of bars) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    cumPV += typical * bar.v;
    cumPV2 += typical * typical * bar.v;
    cumV += bar.v;
  }
  const vwapVal = cumV > 0 ? cumPV / cumV : 0;
  const variance = cumV > 0 ? (cumPV2 / cumV) - (vwapVal * vwapVal) : 0;
  const stdDev = Math.sqrt(Math.max(0, variance));
  return { vwap: vwapVal, upperBand: vwapVal + stdDev, lowerBand: vwapVal - stdDev };
}

// ── Session helpers ──────────────────────────────────────

const RTH_START_UTC = 13.5; // 9:30 AM ET
const RTH_END_UTC = 20;     // 4:00 PM ET

function barToSession(bar: Bar): { session: string; isRTH: boolean; minutesSinceOpen: number } {
  const date = new Date(bar.t * 1000);
  const utcHour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const minutesSinceOpen = Math.max(0, (utcHour - RTH_START_UTC) * 60);
  const isRTH = utcHour >= RTH_START_UTC && utcHour < RTH_END_UTC;

  let session: string;
  if (utcHour < 13) session = "after_hours";
  else if (utcHour < 13.5) session = "pre_market";
  else if (minutesSinceOpen < 15) session = "open";
  else if (utcHour < 16) session = "morning";
  else if (utcHour < 18) session = "midday";
  else if (utcHour < 19.75) session = "afternoon";
  else if (utcHour < 20) session = "close";
  else session = "after_hours";

  return { session, isRTH, minutesSinceOpen };
}

function isSameDay(t1: number, t2: number): boolean {
  const d1 = new Date(t1 * 1000);
  const d2 = new Date(t2 * 1000);
  return d1.getUTCFullYear() === d2.getUTCFullYear() &&
    d1.getUTCMonth() === d2.getUTCMonth() &&
    d1.getUTCDate() === d2.getUTCDate();
}

// ── Setup Detection (same logic as agent) ──────────────

interface DetectedSetup {
  type: SetupType;
  direction: "long" | "short";
  confidence: number;
  stopDistance: number;
  targetDistance: number;
}

function detectSetup(
  price: number,
  closes: number[],
  bars: Bar[],
  prevDayHigh: number,
  prevDayLow: number,
  openingRangeHigh: number,
  openingRangeLow: number,
  vwapData: { vwap: number; upperBand: number; lowerBand: number },
  session: string,
  trend15: string,
): DetectedSetup | null {
  if (closes.length < 25) return null;

  const currentRSI = rsi(closes) || 50;
  const emaFast = ema(closes, 9);
  const emaSlow = ema(closes, 21);
  const currentATR = atr(bars);
  if (currentATR === 0) return null;

  const avgVolume = bars.length >= 20 ? bars.slice(-20).reduce((s, b) => s + b.v, 0) / 20 : 0;
  const currentVolume = bars[bars.length - 1]?.v || 0;
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  const fastEMA = emaFast[emaFast.length - 1];
  const slowEMA = emaSlow[emaSlow.length - 1];
  const prevFastEMA = emaFast[emaFast.length - 2];
  const prevSlowEMA = emaSlow[emaSlow.length - 2];

  // Determine rough "regime" from EMAs
  const isTrending = Math.abs(fastEMA - slowEMA) / price > 0.001;
  const regime = fastEMA > slowEMA ? (isTrending ? "bull" : "choppy") : (isTrending ? "bear" : "choppy");

  // SETUP 1: Opening Range Breakout
  if (session === "morning" && openingRangeHigh > 0 && openingRangeLow > 0) {
    if (price > openingRangeHigh && volumeRatio > 1.2) {
      return {
        type: "opening_range_breakout", direction: "long", confidence: 75,
        stopDistance: currentATR * 1.5,
        targetDistance: (price - openingRangeLow) * 1.5,
      };
    }
    if (price < openingRangeLow && volumeRatio > 1.2) {
      return {
        type: "opening_range_breakout", direction: "short", confidence: 75,
        stopDistance: currentATR * 1.5,
        targetDistance: (openingRangeHigh - price) * 1.5,
      };
    }
  }

  // SETUP 2: VWAP Mean Reversion
  if ((session === "midday" || session === "afternoon") && regime === "choppy") {
    if (price > vwapData.upperBand && currentRSI > 70) {
      return {
        type: "vwap_mean_reversion", direction: "short", confidence: 70,
        stopDistance: currentATR * 1.5,
        targetDistance: price - vwapData.vwap,
      };
    }
    if (price < vwapData.lowerBand && currentRSI < 30) {
      return {
        type: "vwap_mean_reversion", direction: "long", confidence: 70,
        stopDistance: currentATR * 1.5,
        targetDistance: vwapData.vwap - price,
      };
    }
  }

  // SETUP 3: Trend Continuation
  if (regime === "bull" || regime === "bear") {
    const isTrendUp = fastEMA > slowEMA && price > fastEMA;
    const isTrendDown = fastEMA < slowEMA && price < fastEMA;

    if (isTrendUp && price <= fastEMA * 1.001 && price >= slowEMA && currentRSI > 40 && currentRSI < 60) {
      let conf = 80;
      if (trend15 === "down") conf -= 20;
      return {
        type: "trend_continuation", direction: "long", confidence: conf,
        stopDistance: currentATR * 1.5, targetDistance: currentATR * 3.0,
      };
    }
    if (isTrendDown && price >= fastEMA * 0.999 && price <= slowEMA && currentRSI > 40 && currentRSI < 60) {
      let conf = 80;
      if (trend15 === "up") conf -= 20;
      return {
        type: "trend_continuation", direction: "short", confidence: conf,
        stopDistance: currentATR * 1.5, targetDistance: currentATR * 3.0,
      };
    }
  }

  // SETUP 4: Key Level Bounce
  if (prevDayHigh > 0 && prevDayLow > 0) {
    const nearPrevLow = Math.abs(price - prevDayLow) / price < 0.001;
    const nearPrevHigh = Math.abs(price - prevDayHigh) / price < 0.001;

    if (nearPrevLow && currentRSI < 35) {
      return {
        type: "key_level_bounce", direction: "long", confidence: 65,
        stopDistance: currentATR * 2.0, targetDistance: currentATR * 2.5,
      };
    }
    if (nearPrevHigh && currentRSI > 65) {
      return {
        type: "key_level_bounce", direction: "short", confidence: 65,
        stopDistance: currentATR * 2.0, targetDistance: currentATR * 2.5,
      };
    }
  }

  // SETUP 5: EMA Crossover
  const isBullishCross = prevFastEMA <= prevSlowEMA && fastEMA > slowEMA;
  const isBearishCross = prevFastEMA >= prevSlowEMA && fastEMA < slowEMA;

  if (isBullishCross && price > vwapData.vwap && volumeRatio > 1.0) {
    return {
      type: "ema_crossover", direction: "long", confidence: 60,
      stopDistance: currentATR * 1.5, targetDistance: currentATR * 2.5,
    };
  }
  if (isBearishCross && price < vwapData.vwap && volumeRatio > 1.0) {
    return {
      type: "ema_crossover", direction: "short", confidence: 60,
      stopDistance: currentATR * 1.5, targetDistance: currentATR * 2.5,
    };
  }

  return null;
}

// ── Simulate bracket order fill ──────────────────────────

function simulateTrade(
  setup: DetectedSetup,
  entryBar: Bar,
  futureBars: Bar[],
): SimTrade | null {
  const entryPrice = entryBar.c; // enter at close of signal bar
  const stopLoss = setup.direction === "long"
    ? entryPrice - setup.stopDistance
    : entryPrice + setup.stopDistance;
  const target = setup.direction === "long"
    ? entryPrice + setup.targetDistance
    : entryPrice - setup.targetDistance;

  // Walk forward through bars looking for stop or target hit
  for (let i = 0; i < futureBars.length; i++) {
    const bar = futureBars[i];

    // Check if we've crossed into next day — force close at EOD
    if (!isSameDay(entryBar.t, bar.t)) {
      const exitPrice = futureBars[i - 1]?.c || entryPrice;
      const pnl = setup.direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
      return {
        setup: setup.type, direction: setup.direction,
        entryPrice, stopLoss, target,
        entryTime: entryBar.t, exitPrice, exitTime: futureBars[i - 1]?.t || bar.t,
        exitReason: "eod", pnl, rMultiple: pnl / setup.stopDistance, holdBars: i,
      };
    }

    // Check stop hit (assume worst case: stop checked before target on losing bars)
    if (setup.direction === "long") {
      if (bar.l <= stopLoss) {
        const pnl = stopLoss - entryPrice;
        return {
          setup: setup.type, direction: setup.direction,
          entryPrice, stopLoss, target,
          entryTime: entryBar.t, exitPrice: stopLoss, exitTime: bar.t,
          exitReason: "stop", pnl, rMultiple: pnl / setup.stopDistance, holdBars: i + 1,
        };
      }
      if (bar.h >= target) {
        const pnl = target - entryPrice;
        return {
          setup: setup.type, direction: setup.direction,
          entryPrice, stopLoss, target,
          entryTime: entryBar.t, exitPrice: target, exitTime: bar.t,
          exitReason: "target", pnl, rMultiple: pnl / setup.stopDistance, holdBars: i + 1,
        };
      }
    } else {
      if (bar.h >= stopLoss) {
        const pnl = entryPrice - stopLoss;
        return {
          setup: setup.type, direction: setup.direction,
          entryPrice, stopLoss, target,
          entryTime: entryBar.t, exitPrice: stopLoss, exitTime: bar.t,
          exitReason: "stop", pnl, rMultiple: pnl / setup.stopDistance, holdBars: i + 1,
        };
      }
      if (bar.l <= target) {
        const pnl = entryPrice - target;
        return {
          setup: setup.type, direction: setup.direction,
          entryPrice, stopLoss, target,
          entryTime: entryBar.t, exitPrice: target, exitTime: bar.t,
          exitReason: "target", pnl, rMultiple: pnl / setup.stopDistance, holdBars: i + 1,
        };
      }
    }
  }

  // If no exit found, close at last bar
  const lastBar = futureBars[futureBars.length - 1] || entryBar;
  const exitPrice = lastBar.c;
  const pnl = setup.direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return {
    setup: setup.type, direction: setup.direction,
    entryPrice, stopLoss, target,
    entryTime: entryBar.t, exitPrice, exitTime: lastBar.t,
    exitReason: "eod", pnl, rMultiple: pnl / setup.stopDistance, holdBars: futureBars.length,
  };
}

// ── Data fetching ──────────────────────────────────────

async function fetchBars(symbol: string, interval: "5m" | "15m", days: number): Promise<Bar[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const result = await yfBT.chart(symbol, { period1: start, period2: end, interval });

  if (!result?.quotes || !Array.isArray(result.quotes)) return [];

  return result.quotes
    .filter((q: Record<string, number | null>) => q.close != null && q.close > 0)
    .map((q: Record<string, number | Date | null>) => ({
      t: q.date ? new Date(String(q.date)).getTime() / 1000 : 0,
      o: Number(q.open) || 0,
      h: Number(q.high) || 0,
      l: Number(q.low) || 0,
      c: Number(q.close) || 0,
      v: Number(q.volume) || 0,
    }));
}

// ── Group bars by trading day ──────────────────────────

function groupByDay(bars: Bar[]): Map<string, Bar[]> {
  const days = new Map<string, Bar[]>();
  for (const bar of bars) {
    const d = new Date(bar.t * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    if (!days.has(key)) days.set(key, []);
    days.get(key)!.push(bar);
  }
  return days;
}

// ── Calculate setup stats ──────────────────────────────

function calcStats(trades: SimTrade[], setupType: SetupType): SetupStats {
  const setupTrades = trades.filter((t) => t.setup === setupType);
  if (setupTrades.length === 0) {
    return {
      setup: setupType, trades: 0, wins: 0, losses: 0, winRate: 0,
      avgWin: 0, avgLoss: 0, profitFactor: 0, totalPnl: 0,
      maxDrawdown: 0, avgRMultiple: 0, avgHoldBars: 0, sharpe: 0,
      verdict: "kill",
    };
  }

  const wins = setupTrades.filter((t) => t.pnl > 0);
  const losses = setupTrades.filter((t) => t.pnl <= 0);
  const winRate = wins.length / setupTrades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const totalPnl = setupTrades.reduce((s, t) => s + t.pnl, 0);
  const avgRMultiple = setupTrades.reduce((s, t) => s + t.rMultiple, 0) / setupTrades.length;
  const avgHoldBars = setupTrades.reduce((s, t) => s + t.holdBars, 0) / setupTrades.length;

  // Max drawdown
  let peak = 0, maxDD = 0, cumPnl = 0;
  for (const t of setupTrades) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe (annualized from per-trade returns)
  const pnls = setupTrades.map((t) => t.pnl);
  const mean = totalPnl / pnls.length;
  const stddev = Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length);
  const sharpe = stddev > 0 ? (mean / stddev) * Math.sqrt(252) : 0; // ~252 trading days

  // Verdict
  let verdict: "keep" | "optimize" | "kill";
  if (profitFactor >= 1.5 && winRate >= 0.45 && setupTrades.length >= 5) {
    verdict = "keep";
  } else if (profitFactor >= 1.0 && winRate >= 0.35 && setupTrades.length >= 3) {
    verdict = "optimize";
  } else {
    verdict = "kill";
  }

  return {
    setup: setupType, trades: setupTrades.length,
    wins: wins.length, losses: losses.length, winRate,
    avgWin, avgLoss, profitFactor, totalPnl, maxDrawdown: maxDD,
    avgRMultiple, avgHoldBars, sharpe, verdict,
  };
}

// ── MAIN BACKTEST RUNNER ──────────────────────────────

export async function runFuturesBacktest(
  symbol: string = "ES=F",
  days: number = 55,
): Promise<BacktestResult> {
  // Fetch 5m and 15m data
  const [bars5m, bars15m] = await Promise.all([
    fetchBars(symbol, "5m", days),
    fetchBars(symbol, "15m", days),
  ]);

  if (bars5m.length < 100) {
    throw new Error(`Insufficient data: only ${bars5m.length} bars for ${symbol}`);
  }

  const dayGroups = groupByDay(bars5m);
  const dayKeys = [...dayGroups.keys()].sort();
  const allTrades: SimTrade[] = [];

  // Build 15m close array for trend detection
  const closes15m = bars15m.map((b) => b.c);

  // Process each trading day
  for (let d = 1; d < dayKeys.length; d++) {
    const prevDayBars = dayGroups.get(dayKeys[d - 1])!;
    const todayBars = dayGroups.get(dayKeys[d])!;

    if (todayBars.length < 10) continue;

    // Prev day levels
    const prevDayHigh = Math.max(...prevDayBars.map((b) => b.h));
    const prevDayLow = Math.min(...prevDayBars.map((b) => b.l));

    // Filter to RTH bars only
    const rthBars = todayBars.filter((b) => {
      const s = barToSession(b);
      return s.isRTH;
    });
    if (rthBars.length < 6) continue;

    // Opening range (first 3 bars = 15 min of 5m data)
    const openBars = rthBars.slice(0, 3);
    const orHigh = Math.max(...openBars.map((b) => b.h));
    const orLow = Math.min(...openBars.map((b) => b.l));

    // Track trades per day (max 6)
    let dailyTrades = 0;
    let inPosition = false;

    // Walk through bars (skip first 3 = opening range, skip last 3 = closing)
    for (let i = 4; i < rthBars.length - 3; i++) {
      if (dailyTrades >= 6 || inPosition) continue;

      const bar = rthBars[i];
      const { session, minutesSinceOpen } = barToSession(bar);

      // Skip first/last 15 min
      if (minutesSinceOpen < 15) continue;
      if (minutesSinceOpen > 375) continue; // 6h15m = last 15 min

      // Build lookback window
      const lookbackBars = rthBars.slice(Math.max(0, i - 50), i + 1);
      const lookbackCloses = lookbackBars.map((b) => b.c);

      // Session VWAP (from session open, not arbitrary window)
      const sessionBars = rthBars.slice(0, i + 1);
      const vwapData = calcVwap(sessionBars);

      // 15m trend
      const trend15idx = bars15m.findIndex((b) => b.t > bar.t);
      const trend15Closes = trend15idx > 21
        ? closes15m.slice(trend15idx - 21, trend15idx)
        : closes15m.slice(0, Math.min(21, closes15m.length));
      const ema9_15 = ema(trend15Closes, 9);
      const ema21_15 = ema(trend15Closes, 21);
      const trend15 = ema9_15.length > 0 && ema21_15.length > 0
        ? (ema9_15[ema9_15.length - 1] > ema21_15[ema21_15.length - 1] ? "up" : "down")
        : "flat";

      // Detect setup
      const setup = detectSetup(
        bar.c, lookbackCloses, lookbackBars,
        prevDayHigh, prevDayLow, orHigh, orLow,
        vwapData, session, trend15,
      );

      if (!setup || setup.confidence < 55) continue;
      if (setup.targetDistance <= 0 || setup.stopDistance <= 0) continue;

      // Simulate the trade
      const futureBars = rthBars.slice(i + 1);
      const trade = simulateTrade(setup, bar, futureBars);
      if (trade) {
        allTrades.push(trade);
        dailyTrades++;
        inPosition = true;

        // Skip ahead past the trade
        const exitIdx = rthBars.findIndex((b) => b.t >= trade.exitTime);
        if (exitIdx > i) {
          i = exitIdx;
          inPosition = false;
        }
      }
    }
  }

  // Calculate equity curve
  const equity: number[] = [];
  let cumPnl = 0;
  for (const trade of allTrades) {
    cumPnl += trade.pnl;
    equity.push(cumPnl);
  }

  // Per-setup stats
  const setupTypes: SetupType[] = [
    "opening_range_breakout",
    "vwap_mean_reversion",
    "trend_continuation",
    "key_level_bounce",
    "ema_crossover",
  ];
  const setups = setupTypes.map((s) => calcStats(allTrades, s));

  // Overall stats
  const totalWins = allTrades.filter((t) => t.pnl > 0).length;
  const grossWin = allTrades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(allTrades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);

  let peak = 0, maxDD = 0;
  cumPnl = 0;
  for (const t of allTrades) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    if (peak - cumPnl > maxDD) maxDD = peak - cumPnl;
  }

  const mean = allTrades.length > 0 ? totalPnl / allTrades.length : 0;
  const stddev = allTrades.length > 0
    ? Math.sqrt(allTrades.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / allTrades.length)
    : 0;
  const sharpe = stddev > 0 ? (mean / stddev) * Math.sqrt(252) : 0;

  const bestSetup = setups.reduce((a, b) => a.profitFactor > b.profitFactor ? a : b);
  const worstSetup = setups.filter((s) => s.trades > 0).reduce((a, b) => a.profitFactor < b.profitFactor ? a : b, setups[0]);

  return {
    symbol,
    period: `${dayKeys[0]} to ${dayKeys[dayKeys.length - 1]}`,
    totalBars: bars5m.length,
    tradingDays: dayKeys.length,
    setups,
    allTrades,
    equity,
    summary: {
      totalTrades: allTrades.length,
      winRate: allTrades.length > 0 ? totalWins / allTrades.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : 0,
      totalPnl,
      maxDrawdown: maxDD,
      sharpe,
      bestSetup: bestSetup.setup.replace(/_/g, " "),
      worstSetup: worstSetup.setup.replace(/_/g, " "),
    },
  };
}
