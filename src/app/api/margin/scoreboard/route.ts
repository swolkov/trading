import { computeMarginScoreboard, listRoundTrips } from "@/lib/kraken-margin";
import { shadowScore, strategyBreakdown, recentPaperTrades, edgeBreakdowns } from "@/lib/margin-shadow";

// The "was I winning" scoreboard: Spencer's real margin round trips, hit rate,
// expectancy after fees + rollover, and progress toward the automation gate. Plus the
// per-strategy paper breakdown and full trade log — the "what's working" admin view.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [scoreboard, trips, shadow, strategies, log, edges] = await Promise.all([
      computeMarginScoreboard(),
      listRoundTrips(),
      shadowScore().catch(() => null),
      strategyBreakdown().catch(() => []),
      recentPaperTrades(100).catch(() => []),
      edgeBreakdowns().catch(() => ({ byDirection: [], byCoin: [] })),
    ]);
    return Response.json({
      scoreboard,
      // Most recent 50 round trips for the cockpit's trade list.
      recentTrips: trips.slice(-50).reverse(),
      // Tracked-signal paper record: would these alerts have made money?
      shadow,
      // Per-strategy paper scoreboard (scanner vs manual) — what's working.
      strategies,
      // Full trade log — every tracked paper trade, newest first.
      log,
      // Edges: the paper record sliced by factor (direction, coin) — where's the edge.
      edges,
    });
  } catch (error) {
    console.error("[/api/margin/scoreboard]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
