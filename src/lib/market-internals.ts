import { getHistoricalBars } from "./yahoo";
import { prisma } from "./db";

// ============ MARKET INTERNALS ============
// The secret weapon of institutional futures traders.
// TICK, breadth, and volume internals predict S&P direction BEFORE price moves.
// These are leading indicators, not lagging (unlike RSI, MACD, etc.)

export interface MarketInternals {
  // TICK Index — most important intraday indicator for ES/MES
  // Measures: # of NYSE stocks on uptick minus downtick at any moment
  // > +800 = strong buying pressure (bullish)
  // < -800 = strong selling pressure (bearish)
  // Extreme readings (>+1200 or <-1200) = reversal likely
  tick: number;
  tickSignal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  tickExtreme: boolean; // extreme = reversal warning

  // Advance/Decline — market breadth
  // How many stocks going up vs down? Confirms if move is broad or narrow
  advanceDecline: number; // positive = more advancing, negative = more declining
  breadthSignal: "strong" | "confirming" | "diverging" | "weak";

  // Volume internals
  upVolume: number; // volume on up-ticking stocks
  downVolume: number; // volume on down-ticking stocks
  volumeRatio: number; // upVol / downVol — >2 = very bullish, <0.5 = very bearish
  volumeSignal: "bullish" | "neutral" | "bearish";

  // VIX term structure (VIX vs VIX3M)
  vixRatio: number; // VIX / VIX3M — >1.0 = backwardation (fear), <0.9 = contango (calm)
  vixStructure: "contango" | "flat" | "backwardation";

  // Put/Call Ratio
  putCallRatio: number; // >1.2 = extreme fear (contrarian bullish), <0.7 = extreme greed (contrarian bearish)
  sentimentSignal: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";

  // Overall bias
  bias: "bullish" | "bearish" | "neutral";
  biasStrength: number; // 0-100
  summary: string;
}

// Fetch market internals from available data sources
export async function getMarketInternals(): Promise<MarketInternals> {
  // TICK index via Yahoo ($TICK or ^TICK)
  let tick = 0;
  let tickSignal: MarketInternals["tickSignal"] = "neutral";
  let tickExtreme = false;
  try {
    const tickBars = await getHistoricalBars("^TICK", 1);
    if (tickBars.length > 0) {
      tick = tickBars[tickBars.length - 1].c;
      if (tick > 1200) { tickSignal = "strong_buy"; tickExtreme = true; }
      else if (tick > 600) tickSignal = "buy";
      else if (tick < -1200) { tickSignal = "strong_sell"; tickExtreme = true; }
      else if (tick < -600) tickSignal = "sell";
      else tickSignal = "neutral";
    }
  } catch { /* TICK may not be available via Yahoo */ }

  // Advance/Decline via $ADVN - $DECL or breadth ETFs
  let advanceDecline = 0;
  let breadthSignal: MarketInternals["breadthSignal"] = "confirming";
  try {
    // Use ETF proxies: SPXL (3x bull) vs SPXS (3x bear) volume ratio as proxy
    const [advBars, decBars] = await Promise.all([
      getHistoricalBars("^ADV", 1).catch(() => []),
      getHistoricalBars("^DECL", 1).catch(() => []),
    ]);
    if (advBars.length > 0 && decBars.length > 0) {
      advanceDecline = advBars[advBars.length - 1].c - decBars[decBars.length - 1].c;
      if (Math.abs(advanceDecline) > 1500) breadthSignal = "strong";
      else if (Math.abs(advanceDecline) > 500) breadthSignal = "confirming";
      else breadthSignal = "weak";
    }
  } catch {}

  // Volume internals — up volume vs down volume
  let upVolume = 0, downVolume = 0, volumeRatio = 1;
  let volumeSignal: MarketInternals["volumeSignal"] = "neutral";
  try {
    const [upBars, dnBars] = await Promise.all([
      getHistoricalBars("^UVOL", 1).catch(() => []),
      getHistoricalBars("^DVOL", 1).catch(() => []),
    ]);
    if (upBars.length > 0 && dnBars.length > 0) {
      upVolume = upBars[upBars.length - 1].c;
      downVolume = dnBars[dnBars.length - 1].c;
      volumeRatio = downVolume > 0 ? upVolume / downVolume : 1;
      if (volumeRatio > 2) volumeSignal = "bullish";
      else if (volumeRatio < 0.5) volumeSignal = "bearish";
    }
  } catch {}

  // VIX term structure
  let vixRatio = 0.9;
  let vixStructure: MarketInternals["vixStructure"] = "contango";
  try {
    const [vixBars, vix3mBars] = await Promise.all([
      getHistoricalBars("^VIX", 2),
      getHistoricalBars("^VIX3M", 2).catch(() => []),
    ]);
    if (vixBars.length > 0 && vix3mBars.length > 0) {
      const vix = vixBars[vixBars.length - 1].c;
      const vix3m = vix3mBars[vix3mBars.length - 1].c;
      vixRatio = vix3m > 0 ? vix / vix3m : 0.9;
      if (vixRatio > 1.05) vixStructure = "backwardation";
      else if (vixRatio < 0.92) vixStructure = "contango";
      else vixStructure = "flat";
    }
  } catch {}

  // Put/Call Ratio
  let putCallRatio = 1.0;
  let sentimentSignal: MarketInternals["sentimentSignal"] = "neutral";
  try {
    const pcBars = await getHistoricalBars("^CPC", 2).catch(() => []);
    if (pcBars.length > 0) {
      putCallRatio = pcBars[pcBars.length - 1].c;
      if (putCallRatio > 1.3) sentimentSignal = "extreme_fear";
      else if (putCallRatio > 1.1) sentimentSignal = "fear";
      else if (putCallRatio < 0.6) sentimentSignal = "extreme_greed";
      else if (putCallRatio < 0.8) sentimentSignal = "greed";
    }
  } catch {}

  // Calculate overall bias
  let biasScore = 0; // -100 to +100
  if (tickSignal === "strong_buy") biasScore += 30;
  else if (tickSignal === "buy") biasScore += 15;
  else if (tickSignal === "sell") biasScore -= 15;
  else if (tickSignal === "strong_sell") biasScore -= 30;

  if (volumeSignal === "bullish") biasScore += 20;
  else if (volumeSignal === "bearish") biasScore -= 20;

  if (vixStructure === "contango") biasScore += 10;
  else if (vixStructure === "backwardation") biasScore -= 20;

  if (advanceDecline > 500) biasScore += 15;
  else if (advanceDecline < -500) biasScore -= 15;

  // Sentiment is contrarian
  if (sentimentSignal === "extreme_fear") biasScore += 10; // contrarian bullish
  else if (sentimentSignal === "extreme_greed") biasScore -= 10; // contrarian bearish

  const bias: MarketInternals["bias"] = biasScore > 20 ? "bullish" : biasScore < -20 ? "bearish" : "neutral";
  const biasStrength = Math.min(100, Math.abs(biasScore));

  const summary = `Internals: ${bias} (${biasStrength}%) | TICK: ${tick} (${tickSignal}) | Vol ratio: ${volumeRatio.toFixed(1)} | VIX structure: ${vixStructure} | P/C: ${putCallRatio.toFixed(2)} (${sentimentSignal})`;

  return {
    tick, tickSignal, tickExtreme,
    advanceDecline, breadthSignal,
    upVolume, downVolume, volumeRatio, volumeSignal,
    vixRatio, vixStructure,
    putCallRatio, sentimentSignal,
    bias, biasStrength, summary,
  };
}

// Store internals snapshot to DB (for synthesis agent to correlate with trades)
export async function storeInternalsSnapshot(internals: MarketInternals): Promise<void> {
  try {
    await prisma.agentConfig.upsert({
      where: { key: "market_internals_latest" },
      update: { value: JSON.stringify({ ...internals, timestamp: new Date().toISOString() }) },
      create: { key: "market_internals_latest", value: JSON.stringify({ ...internals, timestamp: new Date().toISOString() }) },
    });
  } catch {}
}

// Quick check: does the market support this direction?
export function internalsSupport(internals: MarketInternals, direction: "long" | "short"): boolean {
  if (direction === "long") {
    return internals.bias === "bullish" || (internals.bias === "neutral" && internals.tickSignal !== "sell" && internals.tickSignal !== "strong_sell");
  } else {
    return internals.bias === "bearish" || (internals.bias === "neutral" && internals.tickSignal !== "buy" && internals.tickSignal !== "strong_buy");
  }
}
