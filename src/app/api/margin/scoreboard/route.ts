import { computeMarginScoreboard, listRoundTrips } from "@/lib/kraken-margin";

// The "was I winning" scoreboard: Spencer's real margin round trips, hit rate,
// expectancy after fees + rollover, and progress toward the automation gate.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [scoreboard, trips] = await Promise.all([
      computeMarginScoreboard(),
      listRoundTrips(),
    ]);
    return Response.json({
      scoreboard,
      // Most recent 50 round trips for the cockpit's trade list.
      recentTrips: trips.slice(-50).reverse(),
    });
  } catch (error) {
    console.error("[/api/margin/scoreboard]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
