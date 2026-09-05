import { krakenPublic } from "@/lib/kraken";
import { usRetailMaxLeverage, isUsMarginSymbol } from "@/lib/kraken-pairs";

// The margin universe for the cockpit's pair picker: every USD pair with margin enabled
// on Kraken (international list), its max US-RETAIL leverage, the LIVE spread, and
// whether a US retail account can margin-trade it at all. Cached 5 minutes (public data).
//
// ⚠️ AssetPairs describes the INTERNATIONAL product (~132 pairs). A US retail account
// gets the 28 pairs in kraken-pairs.ts US_MARGIN_MAX_LEVERAGE — `usMargin` says which, and
// `tradeable` now requires BOTH a tight spread AND US eligibility, because the executor
// refuses everything else.
export const dynamic = "force-dynamic";

interface UniverseRow {
  pair: string;         // Kraken pair code (XBTUSD style where applicable)
  wsname: string;       // display name e.g. XBT/USD
  maxLeverage: number;  // US-retail max from the table; AssetPairs only for non-US pairs
  spreadPct: number | null;
  bid: number | null;
  ask: number | null;
  usMargin: boolean;    // on Kraken's US retail margin list (the only pairs live can trade)
  tradeable: boolean;   // usMargin AND spread < 0.30% — beyond that a 3-day hold starts underwater
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
      const intlMax = v.leverage_buy?.length ? Math.max(...v.leverage_buy) : 0;
      if (intlMax < 2) continue;
      // Correct to the US-retail max (BTC 10x→20x); majors are unchanged.
      const maxLev = usRetailMaxLeverage(key, intlMax);
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
      const usMargin = isUsMarginSymbol(p.key);
      return {
        pair: p.key,
        wsname: p.wsname,
        maxLeverage: p.maxLev,
        spreadPct,
        bid,
        ask,
        usMargin,
        tradeable: usMargin && spreadPct != null && spreadPct < 0.3,
      };
    }).sort((a, b) => (Number(b.usMargin) - Number(a.usMargin)) || (b.maxLeverage - a.maxLeverage) || ((a.spreadPct ?? 99) - (b.spreadPct ?? 99)));

    cache = { at: Date.now(), rows };
    return Response.json({ rows, cachedAt: new Date().toISOString() });
  } catch (error) {
    console.error("[/api/margin/universe]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
