import { krakenPublic } from "@/lib/kraken";

// The tradeable margin universe for the cockpit's pair picker: every USD pair with
// margin enabled, its max leverage tier, and the LIVE spread. Spread is the gate that
// makes most of the 3x long-tail uninvestable — surfacing it stops a bad pair being
// picked by accident. Cached 5 minutes in module scope (public data, no key).
//
// ⚠️ AssetPairs reports the INTERNATIONAL tiers. US retail (Kraken Derivatives US) has
// ~25 pairs and BTC goes to 20x, not the [2..10] this endpoint claims — the UI labels
// the number "intl tier" and the true per-pair US access is confirmed by the account's
// own orders, never by this endpoint.
export const dynamic = "force-dynamic";

interface UniverseRow {
  pair: string;         // Kraken pair code (XBTUSD style where applicable)
  wsname: string;       // display name e.g. XBT/USD
  maxLeverage: number;  // international tier from leverage_buy (see caveat above)
  spreadPct: number | null;
  bid: number | null;
  ask: number | null;
  tradeable: boolean;   // spread < 0.30% — beyond that a 3-day hold starts underwater
}

let cache: { at: number; rows: UniverseRow[] } | null = null;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < 5 * 60 * 1000) {
      return Response.json({ rows: cache.rows, cachedAt: new Date(cache.at).toISOString() });
    }

    const pairsRes = await krakenPublic("AssetPairs");
    const marginPairs: { key: string; wsname: string; maxLev: number }[] = [];
    for (const [key, v0] of Object.entries(pairsRes)) {
      const v = v0 as { wsname?: string; quote?: string; leverage_buy?: number[]; status?: string };
      if (!v.wsname?.endsWith("/USD")) continue;
      if (v.status && v.status !== "online") continue;
      const maxLev = v.leverage_buy?.length ? Math.max(...v.leverage_buy) : 0;
      if (maxLev < 2) continue;
      marginPairs.push({ key, wsname: v.wsname, maxLev });
    }

    // One Ticker call for all pairs (Kraken accepts a comma list).
    let tick: Record<string, unknown> = {};
    try {
      tick = await krakenPublic("Ticker", { pair: marginPairs.map((p) => p.key).join(",") });
    } catch { tick = {}; }

    const rows: UniverseRow[] = marginPairs.map((p) => {
      const t = tick[p.key] as { a?: string[]; b?: string[] } | undefined;
      const ask = t?.a?.[0] ? parseFloat(t.a[0]) : null;
      const bid = t?.b?.[0] ? parseFloat(t.b[0]) : null;
      const spreadPct = ask && bid && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
      return {
        pair: p.key,
        wsname: p.wsname,
        maxLeverage: p.maxLev,
        spreadPct,
        bid,
        ask,
        tradeable: spreadPct != null && spreadPct < 0.3,
      };
    }).sort((a, b) => (b.maxLeverage - a.maxLeverage) || ((a.spreadPct ?? 99) - (b.spreadPct ?? 99)));

    cache = { at: Date.now(), rows };
    return Response.json({ rows, cachedAt: new Date().toISOString() });
  } catch (error) {
    console.error("[/api/margin/universe]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
