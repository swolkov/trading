import { krakenConfigured, krakenPublic } from "@/lib/kraken";
import { getKrakenMarginHealth, getKrakenMarginPositions, liquidationEstimate } from "@/lib/kraken-margin";
import { pairBase, publicPairFor } from "@/lib/kraken-pairs";

// Live margin state for the cockpit: account health (margin level vs the 80%/40%
// call/liquidation lines), open positions with exact liquidation prices, and the
// financing cost each position is paying.
//
// Cached ~20s in module scope. The cockpit polls every 30s; without this cache each poll
// fired two PRIVATE Kraken calls, and when they overlapped the guardian's own private
// calls (one shared API key) Kraken rejected them with EAPI:Invalid nonce / Rate limit.
// A short cache collapses the poll storm to at most one private read per 20s per instance,
// which is monitoring-fresh and stops the collisions. (The guardian reads uncached — it
// needs live data for liquidation checks.)
export const dynamic = "force-dynamic";

let statusCache: { at: number; body: unknown } | null = null;
const STATUS_TTL_MS = 20_000;

export async function GET() {
  try {
    if (!krakenConfigured()) {
      return Response.json({ connected: false, positions: [], health: null });
    }
    if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
      return Response.json(statusCache.body);
    }
    // Sequence the two private reads (not Promise.all) so their nonces are strictly
    // ordered even under an odd clock, then let the cache absorb repeat polls.
    const health = await getKrakenMarginHealth();
    const positions = await getKrakenMarginPositions();

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
    statusCache = { at: Date.now(), body };
    return Response.json(body);
  } catch (error) {
    console.error("[/api/margin/status]", error);
    // Serve the last good snapshot on a transient Kraken error rather than flashing an
    // error in the cockpit — a slightly stale read beats a blank panel.
    if (statusCache) return Response.json({ ...(statusCache.body as object), stale: true });
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
