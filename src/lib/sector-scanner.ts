import { getHistoricalBars } from "./yahoo";
import { scanUnusualActivity, type UnusualActivity } from "./options-intelligence";

// ============ SECTOR SCANNER ============
// Themed universe monitoring with relative strength, range breakouts,
// volume spikes, unusual options flow, and configurable pass/fail rules.
// Acts as a PRE-FILTER before expensive AI analysis.

// ============ THEMED SECTOR UNIVERSES ============

export const SECTOR_UNIVERSES: Record<string, { name: string; description: string; symbols: string[] }> = {
  ai_capex: {
    name: "AI Hyper-Scale Capex",
    description: "Companies making or benefiting from massive AI infrastructure spending",
    symbols: [
      // The Spenders (hyperscalers building AI infrastructure)
      "MSFT", "GOOGL", "AMZN", "META",
      // The Picks & Shovels (chip makers / AI silicon)
      "NVDA", "AMD", "AVGO", "MRVL", "TSM",
      // AI Infrastructure (power, cooling, networking, data centers)
      "VRT", "ETN", "EQIX", "DLR", "ANET",
      // AI Software / Platform
      "PLTR", "SNOW", "DDOG", "CRM", "NOW",
      // AI Hardware / Components
      "DELL", "SMCI", "ARM", "QCOM",
    ],
  },
  // Extend easily:
  energy: {
    name: "Energy",
    description: "Oil, gas, and energy infrastructure",
    symbols: ["XOM", "CVX", "COP", "SLB", "EOG", "OXY", "PSX", "VLO", "MPC", "HAL"],
  },
  financials: {
    name: "Financials",
    description: "Banks, brokerages, and financial services",
    symbols: ["JPM", "GS", "MS", "BAC", "WFC", "SCHW", "BLK", "C", "USB", "AXP"],
  },
  biotech: {
    name: "Biotech",
    description: "Biotech and pharma with catalyst potential",
    symbols: ["LLY", "ABBV", "MRK", "BMY", "AMGN", "GILD", "REGN", "VRTX", "BIIB", "MRNA"],
  },
};

// ============ TYPES ============

export interface RelativeStrength {
  symbol: string;
  return5d: number;
  return20d: number;
  spyReturn5d: number;
  spyReturn20d: number;
  rs5d: number;   // symbol return - SPY return (5d)
  rs20d: number;  // symbol return - SPY return (20d)
  rsRank: number; // 1 = strongest in universe, N = weakest
}

export interface RangeBreakout {
  symbol: string;
  rangeHigh: number;
  rangeLow: number;
  rangeDays: number;       // how long the consolidation lasted
  currentPrice: number;
  breakoutDirection: "up" | "down";
  breakoutPct: number;     // how far above/below the range
  volumeRatio: number;     // today's volume vs 20-day avg
  confirmed: boolean;      // volume > 1.5x average
}

export interface SectorHealth {
  sectorKey: string;
  sectorName: string;
  avgRs5d: number;         // avg relative strength of the sector vs SPY
  avgRs20d: number;
  breadth: number;          // % of stocks above their 20-SMA
  breakoutCount: number;    // how many stocks are breaking out
  signal: "sector_breakout" | "sector_strength" | "neutral" | "sector_weakness" | "sector_breakdown";
  summary: string;
}

export interface ScanPassResult {
  symbol: string;
  sector: string;
  passed: boolean;
  score: number;            // 0-100 composite score
  rs: RelativeStrength;
  breakout: RangeBreakout | null;
  unusualFlow: UnusualActivity[];
  volumeRatio: number;
  above20sma: boolean;
  rsi: number | null;
  reasons: string[];        // why it passed or failed
  direction: "bullish" | "bearish" | "neutral";
}

export interface SectorScanResult {
  sectorHealth: SectorHealth;
  candidates: ScanPassResult[];  // only those that passed
  all: ScanPassResult[];         // everything scanned
  scannedAt: Date;
}

// ============ TECHNICAL HELPERS ============

function calcReturn(bars: { c: number }[], days: number): number {
  if (bars.length < days + 1) return 0;
  const current = bars[bars.length - 1].c;
  const prior = bars[bars.length - 1 - days].c;
  return ((current - prior) / prior) * 100;
}

function calcRSI(closes: number[], period = 14): number | null {
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

function calcSMA(data: number[], period: number): number | null {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ============ RANGE BREAKOUT DETECTION ============
// Looks for stocks that consolidated in a tight range and just broke out.
// A "range" = high/low within ATR*0.5 for at least 10 days, then a close
// outside that range on above-average volume.

function detectRangeBreakout(bars: { h: number; l: number; c: number; v: number }[]): RangeBreakout | null {
  if (bars.length < 25) return null;

  const closes = bars.map((b) => b.c);
  const volumes = bars.map((b) => b.v);
  const currentPrice = closes[closes.length - 1];
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const todayVolume = volumes[volumes.length - 1];
  const volumeRatio = avgVolume > 0 ? todayVolume / avgVolume : 1;

  // Look backward from 2 days ago (skip the breakout day itself) to find the range
  // Scan windows of 10-30 days to find the tightest consolidation
  let bestRange: { high: number; low: number; days: number; startIdx: number } | null = null;
  let tightestRangePct = Infinity;

  for (let lookback = 10; lookback <= Math.min(30, bars.length - 5); lookback++) {
    const rangeStart = bars.length - 2 - lookback; // -2 to skip last day (potential breakout)
    const rangeEnd = bars.length - 2;
    if (rangeStart < 0) continue;

    const rangeHighs = bars.slice(rangeStart, rangeEnd).map((b) => b.h);
    const rangeLows = bars.slice(rangeStart, rangeEnd).map((b) => b.l);
    const rangeHigh = Math.max(...rangeHighs);
    const rangeLow = Math.min(...rangeLows);
    const rangePct = ((rangeHigh - rangeLow) / rangeLow) * 100;

    // A valid consolidation: range is less than 10% of price
    if (rangePct < 10 && rangePct < tightestRangePct) {
      tightestRangePct = rangePct;
      bestRange = { high: rangeHigh, low: rangeLow, days: lookback, startIdx: rangeStart };
    }
  }

  if (!bestRange) return null;

  // Check if current price broke out of the range
  const breakoutUp = currentPrice > bestRange.high * 1.005; // 0.5% buffer to avoid noise
  const breakoutDown = currentPrice < bestRange.low * 0.995;

  if (!breakoutUp && !breakoutDown) return null;

  const breakoutDirection = breakoutUp ? "up" as const : "down" as const;
  const breakoutPct = breakoutUp
    ? ((currentPrice - bestRange.high) / bestRange.high) * 100
    : ((bestRange.low - currentPrice) / bestRange.low) * 100;

  return {
    symbol: "", // filled by caller
    rangeHigh: bestRange.high,
    rangeLow: bestRange.low,
    rangeDays: bestRange.days,
    currentPrice,
    breakoutDirection,
    breakoutPct,
    volumeRatio,
    confirmed: volumeRatio >= 1.5,
  };
}

// ============ RELATIVE STRENGTH vs SPY ============

async function calcRelativeStrength(
  symbol: string,
  symbolBars: { c: number }[],
  spyBars: { c: number }[]
): Promise<RelativeStrength> {
  const return5d = calcReturn(symbolBars, 5);
  const return20d = calcReturn(symbolBars, 20);
  const spyReturn5d = calcReturn(spyBars, 5);
  const spyReturn20d = calcReturn(spyBars, 20);

  return {
    symbol,
    return5d,
    return20d,
    spyReturn5d,
    spyReturn20d,
    rs5d: return5d - spyReturn5d,
    rs20d: return20d - spyReturn20d,
    rsRank: 0, // filled after all symbols computed
  };
}

// ============ PASS/FAIL SCORECARD ============

interface PassRules {
  minRs20d: number;           // minimum 20-day RS vs SPY to pass (-999 to disable)
  minVolumeRatio: number;     // minimum volume vs 20d avg (0.5 = 50%)
  requireAbove20sma: boolean; // must be above 20-SMA
  minScore: number;           // minimum composite score (0-100) to pass
  allowBreakdowns: boolean;   // allow bearish breakdowns as short candidates
}

const DEFAULT_PASS_RULES: PassRules = {
  minRs20d: -5,           // don't buy stocks lagging SPY by more than 5% over 20 days
  minVolumeRatio: 0.5,    // at least 50% of average volume
  requireAbove20sma: false, // don't require — breakout may be FROM the SMA
  minScore: 40,           // minimum composite score
  allowBreakdowns: true,  // also find short candidates
};

function scoreCandidate(
  rs: RelativeStrength,
  breakout: RangeBreakout | null,
  volumeRatio: number,
  above20sma: boolean,
  rsi: number | null,
  unusualFlow: UnusualActivity[],
  rules: PassRules
): { score: number; direction: "bullish" | "bearish" | "neutral"; reasons: string[] } {
  let score = 50; // start neutral
  const reasons: string[] = [];

  // Relative Strength (up to ±20 points)
  const rsPoints = Math.max(-20, Math.min(20, rs.rs20d * 2));
  score += rsPoints;
  if (rs.rs20d > 3) reasons.push(`Strong RS: +${rs.rs20d.toFixed(1)}% vs SPY (20d)`);
  else if (rs.rs20d < -3) reasons.push(`Weak RS: ${rs.rs20d.toFixed(1)}% vs SPY (20d)`);

  // Range Breakout (up to ±15 points)
  if (breakout) {
    if (breakout.breakoutDirection === "up") {
      score += breakout.confirmed ? 15 : 8;
      reasons.push(`Range breakout UP after ${breakout.rangeDays}d consolidation (+${breakout.breakoutPct.toFixed(1)}%)${breakout.confirmed ? " CONFIRMED (volume)" : ""}`);
    } else {
      score -= breakout.confirmed ? 15 : 8;
      reasons.push(`Range breakdown after ${breakout.rangeDays}d consolidation (-${breakout.breakoutPct.toFixed(1)}%)${breakout.confirmed ? " CONFIRMED (volume)" : ""}`);
    }
  }

  // Volume (up to ±10 points)
  if (volumeRatio > 2) { score += 10; reasons.push(`High volume: ${volumeRatio.toFixed(1)}x average`); }
  else if (volumeRatio > 1.5) { score += 5; reasons.push(`Above avg volume: ${volumeRatio.toFixed(1)}x`); }
  else if (volumeRatio < 0.5) { score -= 5; reasons.push(`Low volume: ${(volumeRatio * 100).toFixed(0)}% of avg`); }

  // Trend (up to ±5 points)
  if (above20sma) { score += 5; }
  else { score -= 5; }

  // RSI context (up to ±5 points)
  if (rsi !== null) {
    if (rsi > 70 && rsi < 80) { score += 3; reasons.push(`Momentum RSI: ${rsi.toFixed(0)}`); }
    else if (rsi >= 80) { score -= 3; reasons.push(`Overbought RSI: ${rsi.toFixed(0)}`); }
    else if (rsi < 30) { score -= 3; reasons.push(`Oversold RSI: ${rsi.toFixed(0)}`); }
  }

  // Unusual options flow (up to ±10 points)
  const bullishFlow = unusualFlow.filter((f) => f.signal === "bullish" && f.strength !== "normal");
  const bearishFlow = unusualFlow.filter((f) => f.signal === "bearish" && f.strength !== "normal");
  if (bullishFlow.length > 0) {
    score += Math.min(10, bullishFlow.length * 5);
    reasons.push(`Unusual bullish options flow: ${bullishFlow.length} signals`);
  }
  if (bearishFlow.length > 0) {
    score -= Math.min(10, bearishFlow.length * 5);
    reasons.push(`Unusual bearish options flow: ${bearishFlow.length} signals`);
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  // Determine direction
  let direction: "bullish" | "bearish" | "neutral" = "neutral";
  if (score >= 60) direction = "bullish";
  else if (score <= 40) direction = "bearish";

  return { score, direction, reasons };
}

// ============ MAIN SCAN FUNCTION ============

export async function scanSector(
  sectorKey: string,
  rules: Partial<PassRules> = {}
): Promise<SectorScanResult> {
  const sector = SECTOR_UNIVERSES[sectorKey];
  if (!sector) {
    throw new Error(`Unknown sector: ${sectorKey}. Available: ${Object.keys(SECTOR_UNIVERSES).join(", ")}`);
  }

  const effectiveRules = { ...DEFAULT_PASS_RULES, ...rules };
  const all: ScanPassResult[] = [];

  // Fetch SPY data once for relative strength comparison
  let spyBars: { c: number; h: number; l: number; v: number }[] = [];
  try {
    spyBars = await getHistoricalBars("SPY", 60);
  } catch {
    spyBars = [];
  }

  // Fetch all symbols in parallel (batched to avoid rate limits)
  const batchSize = 5;
  const allBars: Map<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> = new Map();

  for (let i = 0; i < sector.symbols.length; i += batchSize) {
    const batch = sector.symbols.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (sym) => {
        try {
          const bars = await getHistoricalBars(sym, 60);
          return { sym, bars };
        } catch {
          return { sym, bars: [] as { t: string; o: number; h: number; l: number; c: number; v: number }[] };
        }
      })
    );
    for (const { sym, bars } of results) {
      if (bars.length >= 20) allBars.set(sym, bars);
    }
  }

  // Scan unusual options flow for the sector (batch the whole universe)
  let allUnusualFlow: UnusualActivity[] = [];
  try {
    allUnusualFlow = await scanUnusualActivity(sector.symbols.slice(0, 10));
  } catch {
    // options flow is optional
  }

  // Calculate relative strength for all symbols
  const rsResults: RelativeStrength[] = [];
  for (const [sym, bars] of allBars) {
    const rs = await calcRelativeStrength(sym, bars, spyBars);
    rsResults.push(rs);
  }

  // Rank by 20-day RS (strongest first)
  rsResults.sort((a, b) => b.rs20d - a.rs20d);
  rsResults.forEach((rs, i) => { rs.rsRank = i + 1; });
  const rsMap = new Map(rsResults.map((rs) => [rs.symbol, rs]));

  // Score each symbol
  let breadthAbove20sma = 0;
  let breakoutCount = 0;

  for (const [sym, bars] of allBars) {
    const rs = rsMap.get(sym);
    if (!rs) continue;

    const closes = bars.map((b) => b.c);
    const volumes = bars.map((b) => b.v);
    const sma20 = calcSMA(closes, 20);
    const above20sma = sma20 !== null && closes[closes.length - 1] > sma20;
    const rsi = calcRSI(closes);
    const avgVol = calcSMA(volumes, 20);
    const todayVol = volumes[volumes.length - 1];
    const volumeRatio = avgVol && avgVol > 0 ? todayVol / avgVol : 1;

    if (above20sma) breadthAbove20sma++;

    // Range breakout detection
    let breakout = detectRangeBreakout(bars);
    if (breakout) {
      breakout.symbol = sym;
      breakoutCount++;
    }

    // Unusual flow for this symbol
    const symbolFlow = allUnusualFlow.filter((f) => f.symbol === sym);

    // Score it
    const { score, direction, reasons } = scoreCandidate(rs, breakout, volumeRatio, above20sma, rsi, symbolFlow, effectiveRules);

    // Apply pass/fail rules
    let passed = score >= effectiveRules.minScore;
    if (passed && rs.rs20d < effectiveRules.minRs20d && direction === "bullish") {
      passed = false;
      reasons.push(`FAIL: RS too weak (${rs.rs20d.toFixed(1)}% < ${effectiveRules.minRs20d}%)`);
    }
    if (passed && volumeRatio < effectiveRules.minVolumeRatio) {
      passed = false;
      reasons.push(`FAIL: Volume too low (${(volumeRatio * 100).toFixed(0)}% < ${(effectiveRules.minVolumeRatio * 100).toFixed(0)}%)`);
    }
    if (passed && effectiveRules.requireAbove20sma && !above20sma && direction === "bullish") {
      passed = false;
      reasons.push("FAIL: Below 20-SMA");
    }
    if (passed && direction === "bearish" && !effectiveRules.allowBreakdowns) {
      passed = false;
      reasons.push("FAIL: Bearish candidate but breakdowns disabled");
    }

    all.push({
      symbol: sym,
      sector: sectorKey,
      passed,
      score,
      rs,
      breakout,
      unusualFlow: symbolFlow,
      volumeRatio,
      above20sma,
      rsi,
      reasons,
      direction,
    });
  }

  // Sort by score descending
  all.sort((a, b) => {
    // Bullish high scores first, then bearish low scores
    if (a.direction === "bullish" && b.direction !== "bullish") return -1;
    if (a.direction !== "bullish" && b.direction === "bullish") return 1;
    if (a.direction === "bullish") return b.score - a.score;
    return a.score - b.score; // bearish: lower score = stronger short signal
  });

  const candidates = all.filter((c) => c.passed);

  // Sector health
  const totalSymbols = allBars.size;
  const breadthPct = totalSymbols > 0 ? (breadthAbove20sma / totalSymbols) * 100 : 50;
  const avgRs5d = rsResults.length > 0 ? rsResults.reduce((s, r) => s + r.rs5d, 0) / rsResults.length : 0;
  const avgRs20d = rsResults.length > 0 ? rsResults.reduce((s, r) => s + r.rs20d, 0) / rsResults.length : 0;

  let signal: SectorHealth["signal"] = "neutral";
  let summary = "";

  if (breakoutCount >= 3 && avgRs5d > 2) {
    signal = "sector_breakout";
    summary = `SECTOR BREAKOUT: ${breakoutCount}/${totalSymbols} stocks breaking out of ranges. Sector RS +${avgRs5d.toFixed(1)}% vs SPY. ${breadthPct.toFixed(0)}% above 20-SMA. STRONG signal — consider overweighting this sector.`;
  } else if (avgRs20d > 3 && breadthPct > 65) {
    signal = "sector_strength";
    summary = `SECTOR STRONG: ${sector.name} outperforming SPY by ${avgRs20d.toFixed(1)}% over 20 days. Breadth: ${breadthPct.toFixed(0)}%. Look for pullback entries on leaders.`;
  } else if (avgRs20d < -3 && breadthPct < 35) {
    signal = "sector_weakness";
    summary = `SECTOR WEAK: ${sector.name} lagging SPY by ${Math.abs(avgRs20d).toFixed(1)}% over 20 days. Breadth only ${breadthPct.toFixed(0)}%. Avoid longs, look for put opportunities.`;
  } else if (breakoutCount >= 2 && avgRs5d < -2) {
    signal = "sector_breakdown";
    summary = `SECTOR BREAKDOWN: ${breakoutCount} stocks breaking DOWN out of ranges. Sector weakening. Defensive posture.`;
  } else {
    summary = `${sector.name}: Neutral. RS vs SPY: ${avgRs20d >= 0 ? "+" : ""}${avgRs20d.toFixed(1)}% (20d). Breadth: ${breadthPct.toFixed(0)}%. ${breakoutCount} breakouts. No strong sector signal.`;
  }

  return {
    sectorHealth: {
      sectorKey,
      sectorName: sector.name,
      avgRs5d,
      avgRs20d,
      breadth: breadthPct,
      breakoutCount,
      signal,
      summary,
    },
    candidates,
    all,
    scannedAt: new Date(),
  };
}

// ============ SCAN ALL SECTORS ============

export async function scanAllSectors(
  sectorKeys?: string[],
  rules?: Partial<PassRules>
): Promise<SectorScanResult[]> {
  const keys = sectorKeys || Object.keys(SECTOR_UNIVERSES);
  const results: SectorScanResult[] = [];

  // Scan sectors sequentially to avoid rate limiting
  for (const key of keys) {
    try {
      const result = await scanSector(key, rules);
      results.push(result);
    } catch {
      // skip failed sectors
    }
  }

  return results;
}
