import { getSnapshot, getBars, getOptionsChain, getOptionsSnapshots, placeOrder } from "./alpaca";
import { getHistoricalBars } from "./yahoo";
import { prisma } from "./db";

// ============ QUICK PLAYS — 7-14 DTE MECHANICAL TRADES ============
// These are purely technical setups. No AI committee needed.
// Small positions (1% of equity), quick in and out.

interface QuickPlay {
  symbol: string;
  setup: string;
  direction: "call" | "put";
  confidence: number;
  reasoning: string;
}

interface QuickPlayResult {
  symbol: string;
  setup: string;
  action: string;
  details: string;
  success: boolean;
}

// Technical helpers
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

function calcATR(bars: { h: number; l: number; c: number }[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// ============ SCAN FOR QUICK PLAY SETUPS ============
export async function scanQuickPlays(symbols: string[]): Promise<QuickPlay[]> {
  const plays: QuickPlay[] = [];

  for (const symbol of symbols.slice(0, 20)) {
    try {
      let bars: { t: string; o: number; h: number; l: number; c: number; v: number }[] = [];
      try { bars = await getBars(symbol, "1Day"); } catch { /* skip */ }
      if (bars.length < 20) {
        try { bars = await getHistoricalBars(symbol, 60); } catch { continue; }
      }
      if (bars.length < 20) continue;

      const closes = bars.map((b) => b.c);
      const volumes = bars.map((b) => b.v);
      const current = closes[closes.length - 1];
      const rsi = calcRSI(closes);
      const sma20 = calcSMA(closes, 20);
      const sma50 = calcSMA(closes, 50);
      const atr = calcATR(bars);
      const avgVol = calcSMA(volumes, 20);
      const todayVol = volumes[volumes.length - 1];
      const prevClose = closes[closes.length - 2];
      const gapPct = ((current - prevClose) / prevClose) * 100;

      // === SETUP 1: OVERSOLD BOUNCE ===
      // RSI < 25, stock at/near 20-SMA support, volume spike
      if (rsi && rsi < 25 && sma20 && current >= sma20 * 0.97 && current <= sma20 * 1.01) {
        plays.push({
          symbol, setup: "oversold_bounce", direction: "call", confidence: 75,
          reasoning: `RSI ${rsi.toFixed(0)} extremely oversold near 20-SMA support ($${sma20.toFixed(2)}). Mean reversion bounce likely.`,
        });
        continue;
      }

      // === SETUP 2: OVERBOUGHT REVERSAL ===
      // RSI > 80, extended above 20-SMA, today's candle is red (reversal)
      if (rsi && rsi > 80 && sma20 && current > sma20 * 1.05 && current < prevClose) {
        plays.push({
          symbol, setup: "overbought_reversal", direction: "put", confidence: 70,
          reasoning: `RSI ${rsi.toFixed(0)} overbought, extended ${((current / sma20 - 1) * 100).toFixed(1)}% above 20-SMA, red reversal candle.`,
        });
        continue;
      }

      // === SETUP 3: MOMENTUM BREAKOUT ===
      // Price just broke above 50-SMA with volume 2x average
      if (sma50 && prevClose < sma50 && current > sma50 && avgVol && todayVol > avgVol * 2) {
        plays.push({
          symbol, setup: "momentum_breakout", direction: "call", confidence: 80,
          reasoning: `Breakout above 50-SMA ($${sma50.toFixed(2)}) with ${(todayVol / avgVol).toFixed(1)}x volume. Momentum confirmed.`,
        });
        continue;
      }

      // === SETUP 4: BREAKDOWN ===
      // Price just broke below 50-SMA with volume 2x average
      if (sma50 && prevClose > sma50 && current < sma50 && avgVol && todayVol > avgVol * 2) {
        plays.push({
          symbol, setup: "breakdown", direction: "put", confidence: 80,
          reasoning: `Breakdown below 50-SMA ($${sma50.toFixed(2)}) with ${(todayVol / avgVol).toFixed(1)}x volume. Selling pressure confirmed.`,
        });
        continue;
      }

      // === SETUP 5: GAP AND GO ===
      // Stock gapped 3%+ today with high volume
      if (Math.abs(gapPct) > 3 && avgVol && todayVol > avgVol * 1.5) {
        plays.push({
          symbol,
          setup: "gap_and_go",
          direction: gapPct > 0 ? "call" : "put",
          confidence: 70,
          reasoning: `Gap ${gapPct > 0 ? "up" : "down"} ${Math.abs(gapPct).toFixed(1)}% with ${(todayVol / avgVol).toFixed(1)}x volume. Momentum continuation.`,
        });
        continue;
      }

      // === SETUP 6: SUPPORT BOUNCE ===
      // Price within 1% of 52-week low and RSI < 35
      const low52 = Math.min(...closes.slice(-252));
      if (rsi && rsi < 35 && current < low52 * 1.03 && current > low52 * 0.99) {
        plays.push({
          symbol, setup: "support_bounce", direction: "call", confidence: 65,
          reasoning: `Near 52-week low ($${low52.toFixed(2)}) with RSI ${rsi.toFixed(0)}. Strong support bounce potential.`,
        });
        continue;
      }

    } catch {
      continue;
    }
  }

  return plays;
}

// ============ EXECUTE QUICK PLAY ============
export async function executeQuickPlay(
  play: QuickPlay,
  equity: number
): Promise<QuickPlayResult> {
  try {
    const snap = await getSnapshot(play.symbol);
    const price = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
    if (price <= 0 || price < 20) {
      return { symbol: play.symbol, setup: play.setup, action: "skip", details: "Price too low or unavailable", success: false };
    }

    // Find a 7-14 DTE contract
    const now = new Date();
    const minExp = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const maxExp = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const contracts = await getOptionsChain(play.symbol, undefined, play.direction, minExp, maxExp);
    if (contracts.length === 0) {
      return { symbol: play.symbol, setup: play.setup, action: "skip", details: `No ${play.direction} contracts (7-14 DTE)`, success: false };
    }

    // Pick slightly OTM strike
    const otmPct = play.direction === "call" ? 1.02 : 0.98;
    const targetStrike = price * otmPct;
    contracts.sort((a, b) =>
      Math.abs(parseFloat(a.strike_price) - targetStrike) -
      Math.abs(parseFloat(b.strike_price) - targetStrike)
    );

    // Try top 3 for liquidity
    for (const contract of contracts.slice(0, 3)) {
      let premium = 0;
      try {
        const snapshots = await getOptionsSnapshots([contract.symbol]);
        const s = snapshots[contract.symbol];
        if (s?.latestQuote) {
          const bid = s.latestQuote.bp;
          const ask = s.latestQuote.ap;
          if (bid > 0 && ask > 0) {
            const spread = (ask - bid) / ((bid + ask) / 2);
            if (spread > 0.20) continue; // too wide
            premium = (bid + ask) / 2;
          }
        }
      } catch { continue; }

      if (premium <= 0) premium = price * 0.015;

      // Size: 1% of equity for quick plays (small bets)
      const maxRisk = equity * 0.01;
      const costPerContract = premium * 100;
      const qty = Math.max(1, Math.min(3, Math.floor(maxRisk / costPerContract)));

      const strike = parseFloat(contract.strike_price);
      const dte = Math.floor((new Date(contract.expiration_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      const order = await placeOrder({
        symbol: contract.symbol,
        qty: String(qty),
        side: "buy",
        type: "market",
        time_in_force: "day",
      });

      const details = `QUICK PLAY [${play.setup.toUpperCase()}]: Bought ${qty}x ${play.symbol} $${strike} ${play.direction} exp ${contract.expiration_date} (${dte} DTE) @ ~$${premium.toFixed(2)}. Risk: $${(costPerContract * qty).toFixed(0)}. ${play.reasoning}`;

      await prisma.autoTradeLog.create({
        data: {
          symbol: contract.symbol,
          action: `quick_${play.direction}`,
          qty,
          price: premium,
          reason: details,
          aiScore: play.confidence,
          aiSignal: play.setup,
          orderId: order.id,
        },
      });

      return { symbol: play.symbol, setup: play.setup, action: `buy_${play.direction}`, details, success: true };
    }

    return { symbol: play.symbol, setup: play.setup, action: "skip", details: "All contracts illiquid", success: false };
  } catch (err) {
    return { symbol: play.symbol, setup: play.setup, action: "error", details: `Error: ${err}`, success: false };
  }
}
