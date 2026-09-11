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
    // Each block fails SOFT so one slow query cannot blank the whole page — but a failure
    // must never read as "no trades". Every block that fails is named in `degraded` and the
    // page shows that as a load error, not an empty state. (A cold start on Sep 11 rendered
    // "No paper trades yet" over a 231-trade record for exactly this reason.)
    const degraded: string[] = [];
    const soft = <T,>(name: string, p: Promise<T>, fallback: T): Promise<T> =>
      p.catch((e) => { degraded.push(`${name}: ${String(e?.message ?? e).slice(0, 80)}`); return fallback; });
    const [scoreboard, trips, shadow, strategies, log, edges, candidate, capacity] = await Promise.all([
      computeMarginScoreboard(),
      listRoundTrips(),
      soft("shadow", shadowScore(), null),
      soft("strategies", strategyBreakdown(), []),
      soft("log", recentPaperTrades(100), []),
      soft("edges", edgeBreakdowns(), { byDirection: [], byCoin: [] }),
      soft("candidate", candidateDetail(candSource), null),
      soft("capacity", capacityReport(candSource), null),
    ]);
    const scanRaw = await prisma.agentConfig.findUnique({ where: { key: "margin_scan_last_result" } }).then((r) => r?.value ?? null).catch(() => null);
    let scanLook: unknown = null;
    try { scanLook = scanRaw ? JSON.parse(scanRaw) : null; } catch { scanLook = null; }
    return Response.json({ scanLook,
      // Blocks that failed to load this request (name: reason). Empty = everything loaded.
      degraded,
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
