import { prisma } from "@/lib/db";

/**
 * Live order book from Databento MBP-10. Reads from the live_depth table that
 * sidecar writes every ~2s.
 *
 * Returns empty book gracefully if sidecar hasn't started writing depth yet
 * (e.g., right after deploy or if MBP-10 schema subscription is unavailable on
 * the current Databento plan).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });

  try {
    const rows = await prisma.$queryRaw<{ symbol: string; bids: unknown; asks: unknown; levels: number; ts: bigint | null; updated_at: Date }[]>`
      SELECT symbol, bids, asks, levels, ts, updated_at FROM live_depth WHERE symbol = ${symbol} LIMIT 1
    `;
    if (rows.length === 0) {
      return Response.json({ symbol, available: false, message: "No depth data yet. Sidecar may still be starting or MBP-10 subscription may be unavailable on this Databento plan." });
    }
    const row = rows[0];
    const ageSeconds = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 1000);
    return Response.json({
      symbol: row.symbol,
      available: true,
      bids: row.bids ?? [],
      asks: row.asks ?? [],
      levels: row.levels,
      ts: row.ts ? Number(row.ts) : null,
      ageSeconds,
      stale: ageSeconds > 10, // 10s+ since last update = stale
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // live_depth table doesn't exist yet — sidecar hasn't been redeployed
    if (msg.includes("does not exist") || msg.includes("relation")) {
      return Response.json({ symbol, available: false, message: "live_depth table not created yet. Redeploy the sidecar (railway up ./sidecar --path-as-root --service databento-sidecar)." });
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}
