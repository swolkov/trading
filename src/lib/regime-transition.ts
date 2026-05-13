import { prisma } from "./db";
import { getHistoricalBars } from "./yahoo";
import { sendNotification } from "./notifications";

// ============ REGIME TRANSITION AGENT ============
// Detects when markets are TRANSITIONING between regimes — the most profitable moments.
// The existing market-regime.ts classifies snapshots. This agent detects the CHANGES.
// Volatility compression → expansion = breakout imminent.
// Breadth thrust = new trend starting.

export type TransitionType =
  | "compression_to_expansion"  // Squeeze breakout — big move incoming
  | "expansion_to_compression"  // Volatility dying — range-bound coming
  | "range_to_trend"            // Breaking out of consolidation
  | "trend_to_range"            // Trend exhaustion
  | "breadth_thrust"            // 80%+ advancing — rare, powerful bull signal
  | "breadth_collapse"          // 80%+ declining — crash warning
  | "vix_spike"                 // VIX jumps 30%+ in a day — fear event
  | "vix_crush"                 // VIX drops 20%+ — fear subsiding
  | "none";                     // No transition detected

export interface TransitionSignal {
  transition: TransitionType;
  confidence: number; // 0-100
  description: string;
  actionableAdvice: string;
  agentAdjustments: {
    positionSizeMultiplier: number; // override for all agents
    preferredStrategies: string[];
    avoidStrategies: string[];
    urgency: "immediate" | "next_session" | "gradual";
  };
  metrics: {
    volatilityCompression: number; // ratio of short-term vol to long-term vol
    adLine5d: number; // 5-day advance/decline momentum
    vixChange1d: number;
    vixChange5d: number;
    atrExpansion: number; // ratio of 5-day ATR to 20-day ATR
    priceVs20sma: number; // % distance from 20 SMA
    volumeSurge: number; // ratio of recent volume to average
  };
}

interface BarData {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function calcATR(bars: BarData[], period: number): number {
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

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

export async function detectTransitions(): Promise<TransitionSignal> {
  const startTime = Date.now();

  // Fetch data in parallel
  const [spyBars, vixBars, qqqBars, iwmBars] = await Promise.all([
    getHistoricalBars("SPY", 60).catch(() => []),
    getHistoricalBars("^VIX", 30).catch(() => getHistoricalBars("VIXY", 30).catch(() => [])),
    getHistoricalBars("QQQ", 30).catch(() => []),
    getHistoricalBars("IWM", 30).catch(() => []),
  ]);

  if (spyBars.length < 30) {
    return noTransition("Insufficient data");
  }

  const closes = spyBars.map((b) => b.c);
  const volumes = spyBars.map((b) => b.v);
  const current = closes[closes.length - 1];

  // === VOLATILITY COMPRESSION/EXPANSION ===
  // Compare 5-day vol to 20-day vol
  const returns5d = [];
  const returns20d = [];
  for (let i = closes.length - 5; i < closes.length; i++) {
    returns5d.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  for (let i = closes.length - 20; i < closes.length; i++) {
    returns20d.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const vol5d = calcStdDev(returns5d) * Math.sqrt(252);
  const vol20d = calcStdDev(returns20d) * Math.sqrt(252);
  const volatilityCompression = vol20d > 0 ? vol5d / vol20d : 1;

  // ATR expansion
  const atr5 = calcATR(spyBars, 5);
  const atr20 = calcATR(spyBars, 20);
  const atrExpansion = atr20 > 0 ? atr5 / atr20 : 1;

  // === BREADTH (using SPY vs QQQ vs IWM as proxy) ===
  let adLine5d = 0;
  if (qqqBars.length >= 6 && iwmBars.length >= 6) {
    const indices = [
      { bars: spyBars, name: "SPY" },
      { bars: qqqBars, name: "QQQ" },
      { bars: iwmBars, name: "IWM" },
    ];
    for (const idx of indices) {
      const c = idx.bars;
      if (c.length < 6) continue;
      const ret5d = (c[c.length - 1].c - c[c.length - 6].c) / c[c.length - 6].c;
      adLine5d += ret5d > 0 ? 1 : -1;
    }
    adLine5d = (adLine5d / 3) * 100; // normalized -100 to 100
  }

  // === VIX ANALYSIS ===
  let vixChange1d = 0;
  let vixChange5d = 0;
  let vixLevel = 20;
  if (vixBars.length >= 6) {
    vixLevel = vixBars[vixBars.length - 1].c;
    const vixPrev = vixBars[vixBars.length - 2].c;
    const vix5dAgo = vixBars[vixBars.length - 6].c;
    vixChange1d = vixPrev > 0 ? ((vixLevel - vixPrev) / vixPrev) * 100 : 0;
    vixChange5d = vix5dAgo > 0 ? ((vixLevel - vix5dAgo) / vix5dAgo) * 100 : 0;
  }

  // === PRICE VS 20 SMA ===
  const sma20 = calcSMA(closes, 20);
  const priceVs20sma = sma20 > 0 ? ((current - sma20) / sma20) * 100 : 0;

  // === VOLUME SURGE ===
  const recentVol = calcSMA(volumes.slice(-3), 3);
  const avgVol = calcSMA(volumes.slice(-20), 20);
  const volumeSurge = avgVol > 0 ? recentVol / avgVol : 1;

  const metrics = {
    volatilityCompression,
    adLine5d,
    vixChange1d,
    vixChange5d,
    atrExpansion,
    priceVs20sma,
    volumeSurge,
  };

  // === DETECT TRANSITION ===

  // VIX spike (highest priority — immediate danger)
  if (vixChange1d > 30) {
    return buildSignal("vix_spike", 90, metrics,
      `VIX spiked ${vixChange1d.toFixed(0)}% in 1 day — fear event in progress`,
      "HALT new long trades. Close weak positions. Consider buying puts for protection. Wait for VIX to stabilize before re-entering.",
      { positionSizeMultiplier: 0.3, preferredStrategies: ["puts", "iron_condor"], avoidStrategies: ["buy_call", "momentum"], urgency: "immediate" }
    );
  }

  // VIX crush — fear subsiding
  if (vixChange5d < -25 && vixLevel < 20) {
    return buildSignal("vix_crush", 75, metrics,
      `VIX crushed ${Math.abs(vixChange5d).toFixed(0)}% over 5 days to ${vixLevel.toFixed(1)} — fear unwinding`,
      "Fear is subsiding. Resume normal trading. Good time for call spreads. Premium selling becomes attractive.",
      { positionSizeMultiplier: 1.2, preferredStrategies: ["credit_spread", "buy_call", "premium_selling"], avoidStrategies: ["buy_put"], urgency: "next_session" }
    );
  }

  // Compression to expansion — squeeze breakout
  if (volatilityCompression < 0.5 && atrExpansion > 1.5 && volumeSurge > 1.5) {
    const direction = priceVs20sma > 0 ? "BULLISH" : "BEARISH";
    return buildSignal("compression_to_expansion", 85, metrics,
      `Volatility squeeze BREAKING OUT ${direction}! Vol compressed to ${(volatilityCompression * 100).toFixed(0)}% of normal, now expanding with ${(volumeSurge * 100 - 100).toFixed(0)}% volume surge`,
      `Big move starting. Trade WITH the breakout direction (${direction}). Use momentum strategies. Increase size on the breakout side.`,
      {
        positionSizeMultiplier: 1.4,
        preferredStrategies: direction === "BULLISH" ? ["buy_call", "momentum", "breakout"] : ["buy_put", "short_momentum"],
        avoidStrategies: ["iron_condor", "mean_reversion"],
        urgency: "immediate",
      }
    );
  }

  // Expansion to compression — volatility dying
  if (volatilityCompression > 1.8 && atrExpansion < 0.7) {
    return buildSignal("expansion_to_compression", 70, metrics,
      `Volatility CONTRACTING — 5d vol ${(volatilityCompression * 100).toFixed(0)}% of 20d, ATR shrinking. Range-bound market incoming.`,
      "Switch to premium selling strategies. Iron condors and credit spreads work best here. Avoid directional bets.",
      { positionSizeMultiplier: 0.8, preferredStrategies: ["iron_condor", "credit_spread", "mean_reversion"], avoidStrategies: ["momentum", "breakout"], urgency: "next_session" }
    );
  }

  // Breadth thrust — rare, powerful
  if (adLine5d > 80 && priceVs20sma > 1 && volumeSurge > 1.3) {
    return buildSignal("breadth_thrust", 80, metrics,
      `BREADTH THRUST: All major indices advancing together (${adLine5d.toFixed(0)}% breadth) with volume confirmation`,
      "Rare bullish signal. Be aggressive on the long side. Buy quality dips. This typically precedes a sustained rally.",
      { positionSizeMultiplier: 1.5, preferredStrategies: ["buy_call", "momentum", "sector_rotation"], avoidStrategies: ["buy_put", "short"], urgency: "immediate" }
    );
  }

  // Breadth collapse
  if (adLine5d < -80 && priceVs20sma < -1 && volumeSurge > 1.3) {
    return buildSignal("breadth_collapse", 80, metrics,
      `BREADTH COLLAPSE: All major indices declining together (${adLine5d.toFixed(0)}% breadth) on heavy volume`,
      "Broad selling pressure. Raise cash immediately. Close weak longs. Consider index puts for portfolio protection.",
      { positionSizeMultiplier: 0.3, preferredStrategies: ["buy_put", "cash", "defensive"], avoidStrategies: ["buy_call", "momentum"], urgency: "immediate" }
    );
  }

  // Range to trend — price breaking away from mean with volume
  if (Math.abs(priceVs20sma) > 2 && volumeSurge > 1.3 && atrExpansion > 1.2) {
    const direction = priceVs20sma > 0 ? "BULLISH" : "BEARISH";
    return buildSignal("range_to_trend", 65, metrics,
      `Range breaking to ${direction} trend — price ${priceVs20sma.toFixed(1)}% from 20 SMA with expanding ATR and volume`,
      `New trend emerging ${direction}. Align positions with the trend. Use trend-following strategies.`,
      {
        positionSizeMultiplier: 1.2,
        preferredStrategies: direction === "BULLISH" ? ["buy_call", "trend_following"] : ["buy_put", "short_trend"],
        avoidStrategies: ["mean_reversion", "iron_condor"],
        urgency: "next_session",
      }
    );
  }

  // Trend to range — price returning to mean, ATR contracting
  if (Math.abs(priceVs20sma) < 0.5 && atrExpansion < 0.8 && volumeSurge < 0.8) {
    return buildSignal("trend_to_range", 55, metrics,
      "Trend fading — price converging to 20 SMA, ATR contracting, volume drying up",
      "Trend exhaustion. Switch to range-bound strategies. Sell premium. Reduce directional bets.",
      { positionSizeMultiplier: 0.7, preferredStrategies: ["iron_condor", "credit_spread", "mean_reversion"], avoidStrategies: ["momentum", "breakout"], urgency: "gradual" }
    );
  }

  return noTransition("No regime transition detected — current regime stable");
}

function noTransition(description: string): TransitionSignal {
  return {
    transition: "none",
    confidence: 0,
    description,
    actionableAdvice: "No transition — continue current strategy",
    agentAdjustments: {
      positionSizeMultiplier: 1.0,
      preferredStrategies: [],
      avoidStrategies: [],
      urgency: "gradual",
    },
    metrics: {
      volatilityCompression: 1,
      adLine5d: 0,
      vixChange1d: 0,
      vixChange5d: 0,
      atrExpansion: 1,
      priceVs20sma: 0,
      volumeSurge: 1,
    },
  };
}

function buildSignal(
  transition: TransitionType,
  confidence: number,
  metrics: TransitionSignal["metrics"],
  description: string,
  actionableAdvice: string,
  agentAdjustments: TransitionSignal["agentAdjustments"]
): TransitionSignal {
  return { transition, confidence, description, actionableAdvice, agentAdjustments, metrics };
}

// Run the full transition check + persist + notify
export async function runTransitionCheck(): Promise<TransitionSignal> {
  const startTime = Date.now();

  const signal = await detectTransitions();

  // Get previous transition to detect changes
  const prevConfig = await prisma.agentConfig.findUnique({
    where: { key: "regime_transition" },
  });
  const prevTransition = prevConfig ? JSON.parse(prevConfig.value).transition : "none";

  // Store current transition
  await prisma.agentConfig.upsert({
    where: { key: "regime_transition" },
    update: { value: JSON.stringify(signal) },
    create: { key: "regime_transition", value: JSON.stringify(signal) },
  });

  // If transition changed — apply adjustments and notify
  if (signal.transition !== "none" && signal.transition !== prevTransition) {
    // Store the position size override for other agents to read
    await prisma.agentConfig.upsert({
      where: { key: "regime_size_override" },
      update: { value: String(signal.agentAdjustments.positionSizeMultiplier) },
      create: { key: "regime_size_override", value: String(signal.agentAdjustments.positionSizeMultiplier) },
    });

    // Store preferred/avoid strategies
    await prisma.agentConfig.upsert({
      where: { key: "regime_preferred_strategies" },
      update: { value: JSON.stringify(signal.agentAdjustments.preferredStrategies) },
      create: { key: "regime_preferred_strategies", value: JSON.stringify(signal.agentAdjustments.preferredStrategies) },
    });

    await prisma.agentConfig.upsert({
      where: { key: "regime_avoid_strategies" },
      update: { value: JSON.stringify(signal.agentAdjustments.avoidStrategies) },
      create: { key: "regime_avoid_strategies", value: JSON.stringify(signal.agentAdjustments.avoidStrategies) },
    });

    // ALERT — this is important
    const urgencyEmoji = signal.agentAdjustments.urgency === "immediate" ? "🚨" : "⚡";
    await sendNotification(
      `${urgencyEmoji} REGIME TRANSITION: ${signal.transition.replace(/_/g, " ").toUpperCase()}\n` +
      `Confidence: ${signal.confidence}%\n` +
      `${signal.description}\n\n` +
      `ACTION: ${signal.actionableAdvice}\n` +
      `Size: ${signal.agentAdjustments.positionSizeMultiplier}x | Prefer: ${signal.agentAdjustments.preferredStrategies.join(", ")} | Avoid: ${signal.agentAdjustments.avoidStrategies.join(", ")}`,
      "general"
    );
  }

  const summary = signal.transition !== "none"
    ? `Transition: ${signal.transition} (${signal.confidence}% confidence) — ${signal.description}`
    : "No regime transition detected";

  await prisma.agentRun.create({
    data: {
      runType: "regime_transition",
      stocksScanned: 4, // SPY, VIX, QQQ, IWM
      tradesPlaced: 0,
      positionsManaged: 0,
      errors: 0,
      summary,
      durationMs: Date.now() - startTime,
    },
  });

  return signal;
}
