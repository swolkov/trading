import { krakenConfigured, krakenPublic } from "@/lib/kraken";
import { marginDisplaySnapshot, liquidationEstimate } from "@/lib/kraken-margin";
import { pairBase, publicPairFor } from "@/lib/kraken-pairs";

// Live margin state for the cockpit: account health (margin level vs the 80%/40%
// call/liquidation lines), open positions with exact liquidation prices, and the
// financing cost each position is paying.
//
// Reads Kraken through marginDisplaySnapshot (kraken-margin.ts): one private read per
// ~20s shared by every display route AND across instances via AgentConfig. Every open
// admin page used to spend its own two private calls from the one rate/nonce budget the
// guardian and executor depend on; a cold instance had no cache at all. (The guardian
// reads uncached — it needs live data for liquidation checks.)
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!krakenConfigured()) {
      return Response.json({ connected: false, positions: [], health: null });
    }
    const snap = await marginDisplaySnapshot();
    const { health, positions } = snap.value;

    // One Ticker call for all open pairs to price liquidation distance. Venue-suffixed
    // pair names (XBTUSD:BTNL) are not valid market-data pairs — map to public ones.
    let prices: Record<string, number> = {};
    if (positions.length) {
      try {
        const tick = await krakenPublic("Ticker", { pair: [...new Set(positions.map((p) => publicPairFor(p.pair)))].join(",") });
        for (const [k, v] of Object.entries(tick)) {
          const c = (v as { c?: string[] })?.c?.[0];
          if (c) prices[k] = parseFloat(c);
        }
      } catch { prices = {}; }
    }
    const priceFor = (pair: string): number | null => {
      if (prices[pair]) return prices[pair];
      // Kraken echoes canonical names (XXBTZUSD for XBTUSD) — match on the shared base.
      for (const [k, px] of Object.entries(prices)) {
        if (pairBase(k) === pairBase(pair)) return px;
      }
      return null;
    };

    const body = {
      connected: true,
      asOf: snap.value.readAt,
      stale: snap.stale,
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
    };
    return Response.json(body);
  } catch (error) {
    console.error("[/api/margin/status]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
