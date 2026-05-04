import { getTopMovers, getSnapshot } from "./alpaca";
import { getHistoricalBars } from "./yahoo";
import { prisma } from "./db";

// ============ GAP SCANNER ============
// Detects stocks that gap up/down significantly at open
// Large gaps with volume = momentum continuation trades
// Gap fills = mean reversion trades

export interface GapStock {
  symbol: string;
  previousClose: number;
  openPrice: number;
  currentPrice: number;
  gapPct: number;
  direction: "gap_up" | "gap_down";
  strength: "small" | "medium" | "large";
  recommendation: string;
}

export async function scanGaps(): Promise<GapStock[]> {
  const gaps: GapStock[] = [];

  try {
    // Get today's biggest movers — they likely gapped
    const [gainers, losers] = await Promise.all([
      getTopMovers("gainers").catch(() => []),
      getTopMovers("losers").catch(() => []),
    ]);

    const candidates = [
      ...gainers.slice(0, 8).map((m) => ({ symbol: m.symbol, pctChange: m.percent_change })),
      ...losers.slice(0, 8).map((m) => ({ symbol: m.symbol, pctChange: m.percent_change })),
    ].filter((c) => Math.abs(c.pctChange) >= 3 && c.symbol.length <= 5); // 3%+ move, normal symbols only

    for (const candidate of candidates.slice(0, 10)) {
      try {
        const bars = await getHistoricalBars(candidate.symbol, 5);
        if (bars.length < 2) continue;

        const previousClose = bars[bars.length - 2].c;
        let currentPrice = 0;

        try {
          const snap = await getSnapshot(candidate.symbol);
          currentPrice = snap.latestTrade?.p || snap.dailyBar?.o || 0;
        } catch {
          currentPrice = bars[bars.length - 1].c;
        }

        if (previousClose <= 0 || currentPrice <= 0) continue;

        const gapPct = ((currentPrice - previousClose) / previousClose) * 100;
        if (Math.abs(gapPct) < 3) continue;

        const direction = gapPct > 0 ? "gap_up" as const : "gap_down" as const;
        const absGap = Math.abs(gapPct);
        const strength = absGap >= 8 ? "large" as const : absGap >= 5 ? "medium" as const : "small" as const;

        let recommendation: string;
        if (direction === "gap_up") {
          if (strength === "large") {
            recommendation = "Large gap up — likely momentum continuation. Buy calls for quick 1-2 day ride.";
          } else {
            recommendation = "Moderate gap up — watch for continuation vs gap fill. Buy calls on breakout above first hour high.";
          }
        } else {
          if (strength === "large") {
            recommendation = "Large gap down — possible bounce play. Buy puts if it breaks below first hour low, or calls if it bounces.";
          } else {
            recommendation = "Moderate gap down — gap fill likely. Consider calls for bounce back to previous close.";
          }
        }

        gaps.push({
          symbol: candidate.symbol,
          previousClose,
          openPrice: currentPrice,
          currentPrice,
          gapPct,
          direction,
          strength,
          recommendation,
        });
      } catch {
        continue;
      }
    }

    // Sort by absolute gap size
    gaps.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
  } catch (err) {
    console.error("[gap-scanner]", err);
  }

  return gaps;
}
