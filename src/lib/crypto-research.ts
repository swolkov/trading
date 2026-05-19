// Crypto-specific research: Fear & Greed Index, BTC dominance, regime detection

import { getCryptoBars, getCryptoSnapshots, DEFAULT_CRYPTO_SYMBOLS, type CryptoBar } from "./alpaca";
import { vaultWrite } from "./vault";

// ── Fear & Greed Index (free, no key needed) ──

export interface FearGreedData {
  value: number;
  classification: string; // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  timestamp: string;
}

export async function getFearAndGreed(): Promise<FearGreedData | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (data?.data?.[0]) {
      return {
        value: parseInt(data.data[0].value),
        classification: data.data[0].value_classification,
        timestamp: new Date(parseInt(data.data[0].timestamp) * 1000).toISOString(),
      };
    }
  } catch {}
  return null;
}

// ── BTC Dominance (CoinGecko free tier, no key) ──

export interface CryptoGlobalData {
  btcDominance: number;
  ethDominance: number;
  totalMarketCap: number;
  totalVolume24h: number;
}

export async function getCryptoGlobal(): Promise<CryptoGlobalData | null> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global", {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (data?.data) {
      return {
        btcDominance: data.data.market_cap_percentage?.btc || 0,
        ethDominance: data.data.market_cap_percentage?.eth || 0,
        totalMarketCap: data.data.total_market_cap?.usd || 0,
        totalVolume24h: data.data.total_volume?.usd || 0,
      };
    }
  } catch {}
  return null;
}

// ── Technical Indicators ──

function ema(data: number[], period: number): number[] {
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
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ── Crypto Regime Detection ──

export type CryptoRegime = "CRYPTO_BULL" | "CRYPTO_BEAR" | "CRYPTO_CHOPPY" | "CRYPTO_EUPHORIA" | "CRYPTO_FEAR";

export interface CryptoRegimeResult {
  regime: CryptoRegime;
  fearGreed: FearGreedData | null;
  btcDominance: number;
  btcRsi: number | null;
  btcTrend: "up" | "down" | "sideways";
  details: string;
}

export async function detectCryptoRegime(): Promise<CryptoRegimeResult> {
  // Fetch all signals in parallel
  const [fearGreed, globalData, btcBars] = await Promise.all([
    getFearAndGreed(),
    getCryptoGlobal(),
    getCryptoBars("BTC/USD", "1Day", undefined, undefined).catch(() => [] as CryptoBar[]),
  ]);

  const closes = btcBars.map((b) => b.c);
  const btcRsi = rsi(closes);
  const btcDominance = globalData?.btcDominance || 0;
  const fg = fearGreed?.value || 50;

  // Trend: compare EMA 9 vs EMA 21
  let btcTrend: "up" | "down" | "sideways" = "sideways";
  if (closes.length >= 21) {
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const last9 = ema9[ema9.length - 1];
    const last21 = ema21[ema21.length - 1];
    const diff = (last9 - last21) / last21;
    if (diff > 0.01) btcTrend = "up";
    else if (diff < -0.01) btcTrend = "down";
  }

  // Classify regime
  let regime: CryptoRegime;
  if (fg >= 80) {
    regime = "CRYPTO_EUPHORIA";
  } else if (fg <= 20) {
    regime = "CRYPTO_FEAR";
  } else if (btcTrend === "up" && fg > 50) {
    regime = "CRYPTO_BULL";
  } else if (btcTrend === "down" && fg < 40) {
    regime = "CRYPTO_BEAR";
  } else {
    regime = "CRYPTO_CHOPPY";
  }

  const details = [
    `Fear & Greed: ${fg} (${fearGreed?.classification || "Unknown"})`,
    `BTC Dominance: ${btcDominance.toFixed(1)}%`,
    `BTC RSI(14): ${btcRsi?.toFixed(1) || "N/A"}`,
    `BTC Trend: ${btcTrend}`,
    `Regime: ${regime}`,
  ].join(" | ");

  return { regime, fearGreed, btcDominance, btcRsi, btcTrend, details };
}

// ── Crypto Setup Scanner ──

export interface CryptoSetup {
  symbol: string;
  type: "momentum_breakout" | "mean_reversion" | "trend_continuation" | "fade_extreme";
  direction: "long" | "short";
  price: number;
  stopPrice: number;
  targetPrice: number;
  riskReward: number;
  confidence: number;
  reasoning: string;
  indicators: {
    rsi: number | null;
    atr: number;
    ema9: number;
    ema21: number;
    volume24h: number;
    volumeRatio: number;
  };
}

export async function scanCryptoSetups(
  symbols: string[],
  regime: CryptoRegime,
): Promise<CryptoSetup[]> {
  const setups: CryptoSetup[] = [];

  for (const symbol of symbols) {
    try {
      // Fetch 1H bars for analysis (last 100 bars = ~4 days)
      const bars = await getCryptoBars(symbol, "1Hour");
      if (bars.length < 30) continue;

      const closes = bars.map((b) => b.c);
      const barData = bars.map((b) => ({ h: b.h, l: b.l, c: b.c, v: b.v }));
      const currentPrice = closes[closes.length - 1];
      const currentRsi = rsi(closes);
      const currentAtr = atr(barData);
      const ema9Arr = ema(closes, 9);
      const ema21Arr = ema(closes, 21);
      const ema9 = ema9Arr[ema9Arr.length - 1];
      const ema21 = ema21Arr[ema21Arr.length - 1];

      // Volume analysis
      const recentVol = bars.slice(-5).reduce((s, b) => s + b.v, 0) / 5;
      const avgVol = bars.slice(-20).reduce((s, b) => s + b.v, 0) / 20;
      const volumeRatio = avgVol > 0 ? recentVol / avgVol : 1;

      // 20-period high/low
      const high20 = Math.max(...closes.slice(-20));
      const low20 = Math.min(...closes.slice(-20));

      const indicators = {
        rsi: currentRsi,
        atr: currentAtr,
        ema9,
        ema21,
        volume24h: recentVol,
        volumeRatio,
      };

      // ── Setup Detection ──

      // 1. Momentum Breakout (bullish regimes)
      if (
        (regime === "CRYPTO_BULL" || regime === "CRYPTO_CHOPPY") &&
        currentPrice >= high20 * 0.998 &&
        volumeRatio > 1.3 &&
        ema9 > ema21
      ) {
        const stop = currentPrice - currentAtr * 1.5;
        const target = currentPrice + currentAtr * 3;
        const rr = (target - currentPrice) / (currentPrice - stop);
        if (rr >= 2) {
          setups.push({
            symbol,
            type: "momentum_breakout",
            direction: "long",
            price: currentPrice,
            stopPrice: stop,
            targetPrice: target,
            riskReward: rr,
            confidence: 60 + (volumeRatio > 2 ? 10 : 0) + (rr > 3 ? 5 : 0),
            reasoning: `Breaking 20-period high at ${currentPrice.toFixed(2)} with ${volumeRatio.toFixed(1)}x volume. EMA 9 > 21 confirms trend.`,
            indicators,
          });
        }
      }

      // 2. Mean Reversion (oversold)
      if (
        currentRsi !== null &&
        currentRsi < 30 &&
        currentPrice <= low20 * 1.01
      ) {
        const stop = currentPrice - currentAtr * 2;
        const target = ema21;
        const rr = Math.abs(target - currentPrice) / (currentPrice - stop);
        if (rr >= 1.5) {
          setups.push({
            symbol,
            type: "mean_reversion",
            direction: "long",
            price: currentPrice,
            stopPrice: stop,
            targetPrice: target,
            riskReward: rr,
            confidence: 55 + (currentRsi < 25 ? 10 : 0) + (regime === "CRYPTO_FEAR" ? 5 : 0),
            reasoning: `RSI ${currentRsi.toFixed(1)} oversold at 20-period low. Target mean reversion to EMA 21 at ${ema21.toFixed(2)}.`,
            indicators,
          });
        }
      }

      // 3. Trend Continuation (pullback to EMA 21)
      if (
        regime === "CRYPTO_BULL" &&
        ema9 > ema21 &&
        currentPrice > ema21 * 0.99 &&
        currentPrice < ema21 * 1.01 &&
        currentRsi !== null &&
        currentRsi > 40 &&
        currentRsi < 60
      ) {
        const stop = ema21 - currentAtr * 1.5;
        const target = currentPrice + currentAtr * 2.5;
        const rr = (target - currentPrice) / (currentPrice - stop);
        if (rr >= 2) {
          setups.push({
            symbol,
            type: "trend_continuation",
            direction: "long",
            price: currentPrice,
            stopPrice: stop,
            targetPrice: target,
            riskReward: rr,
            confidence: 65 + (currentRsi > 45 && currentRsi < 55 ? 5 : 0),
            reasoning: `Pullback to EMA 21 at ${ema21.toFixed(2)} in uptrend. RSI ${currentRsi?.toFixed(1)} neutral — room to run.`,
            indicators,
          });
        }
      }

    } catch (err) {
      console.error(`[crypto-research] Error scanning ${symbol}:`, err);
    }
  }

  // Sort by confidence descending
  return setups.sort((a, b) => b.confidence - a.confidence);
}

// ── Update Vault Brain ──

export async function updateCryptoRegimeVault(result: CryptoRegimeResult): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const content = `---
last_updated: "${today}"
updated_by: "crypto-agent"
---

# Crypto Market Regime

## Current Regime
- **Trend**: ${result.btcTrend === "up" ? "Bullish" : result.btcTrend === "down" ? "Bearish" : "Sideways"}
- **BTC Dominance**: ${result.btcDominance.toFixed(1)}%
- **Fear & Greed**: ${result.fearGreed?.value || "N/A"} (${result.fearGreed?.classification || "Unknown"})
- **BTC RSI(14)**: ${result.btcRsi?.toFixed(1) || "N/A"}

## Regime Classification
**Current**: \`${result.regime}\`

## Summary
${result.details}

## Implications for Crypto Agent
${result.regime === "CRYPTO_BULL" ? "- Favor momentum longs, ride trends, wider stops" : ""}
${result.regime === "CRYPTO_BEAR" ? "- Short-term mean reversion only, tight stops, reduce size 50%" : ""}
${result.regime === "CRYPTO_CHOPPY" ? "- Range trades, quick scalps, reduce size 75%" : ""}
${result.regime === "CRYPTO_EUPHORIA" ? "- Fade extremes, take profits aggressively, reduce size 50%" : ""}
${result.regime === "CRYPTO_FEAR" ? "- DCA entries, accumulation mode, wide stops" : ""}

## Regime Definitions
| Regime | Conditions | Trading Approach |
|--------|-----------|-----------------|
| CRYPTO_BULL | BTC > 50d MA, F&G > 60, rising dominance | Momentum longs, ride trends, wider stops |
| CRYPTO_BEAR | BTC < 50d MA, F&G < 30, declining alts | Short-term mean reversion only, tight stops |
| CRYPTO_CHOPPY | Mixed signals, F&G 30-60, low volume | Range trades, quick scalps, reduce size |
| CRYPTO_EUPHORIA | F&G > 80, parabolic moves, volume surge | Fade extremes, take profits aggressively |
| CRYPTO_FEAR | F&G < 20, capitulation volume | DCA entries, accumulation mode |
`;

  await vaultWrite("Brain/crypto-regime.md", content, "crypto-agent");
}
