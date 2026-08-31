import { krakenConfigured, krakenPublic } from "@/lib/kraken";
import { getKrakenMarginHealth, getKrakenMarginPositions, liquidationEstimate } from "@/lib/kraken-margin";

// Live margin state for the cockpit: account health (margin level vs the 80%/40%
// call/liquidation lines), open positions with exact liquidation prices, and the
// financing cost each position is paying.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!krakenConfigured()) {
      return Response.json({ connected: false, positions: [], health: null });
    }
    const [health, positions] = await Promise.all([
      getKrakenMarginHealth(),
      getKrakenMarginPositions(),
    ]);

    // One Ticker call for all open pairs to price liquidation distance.
    let prices: Record<string, number> = {};
    if (positions.length) {
      try {
        const tick = await krakenPublic("Ticker", { pair: positions.map((p) => p.pair).join(",") });
        for (const [k, v] of Object.entries(tick)) {
          const c = (v as { c?: string[] })?.c?.[0];
          if (c) prices[k] = parseFloat(c);
        }
      } catch { prices = {}; }
    }
    const priceFor = (pair: string): number | null => {
      if (prices[pair]) return prices[pair];
      // Kraken echoes canonical names (XXBTZUSD for XBTUSD) — match loosely on the base.
      const base = pair.replace(/USD$/, "").replace(/^X/, "");
      for (const [k, px] of Object.entries(prices)) {
        if (k.replace(/^X/, "").replace(/Z?USD$/, "") === base) return px;
      }
      return null;
    };

    return Response.json({
      connected: true,
      health,
      positions: positions.map((p) => {
        const px = priceFor(p.pair);
        const liq = px != null ? liquidationEstimate(p, px) : null;
        return {
          ...p,
          currentPrice: px,
          liqPrice: liq?.liqPrice ?? null,
          liqPctAway: liq?.pctAway ?? null,
        };
      }),
    });
  } catch (error) {
    console.error("[/api/margin/status]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
