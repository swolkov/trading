import { computeMarginScoreboard, listRoundTrips } from "@/lib/kraken-margin";
import { shadowScore, strategyBreakdown, recentPaperTrades, edgeBreakdowns, candidateDetail } from "@/lib/margin-shadow";
import { capacityReport } from "@/lib/margin-capacity";
import { prisma } from "@/lib/db";

// The "was I winning" scoreboard: Spencer's real margin round trips, hit rate,
// expectancy after fees + rollover, and progress toward the automation gate. Plus the
// per-strategy paper breakdown and full trade log — the "what's working" admin view.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // The live candidate = the armed sleeve if one is armed, else selective (same rule as the synthesis).
    const candSource = await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_live_sources" } })
      .then((r) => (r?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean)[0] || "selective").catch(() => "selective");
    const [scoreboard, trips, shadow, strategies, log, edges, candidate, capacity] = await Promise.all([
      computeMarginScoreboard(),
      listRoundTrips(),
      shadowScore().catch(() => null),
      strategyBreakdown().catch(() => []),
      recentPaperTrades(100).catch(() => []),
      edgeBreakdowns().catch(() => ({ byDirection: [], byCoin: [] })),
      candidateDetail(candSource).catch(() => null),
      capacityReport(candSource).catch(() => null),
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
      // The live candidate's pre-registered cuts (forward-only, timeframe, entry window) — read at 30 resolved each.
      candidate,
      // Cost of capacity: what the setups the executor refused since arming went on to do, and a slot replay.
      capacity,
    });
  } catch (error) {
    console.error("[/api/margin/scoreboard]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
