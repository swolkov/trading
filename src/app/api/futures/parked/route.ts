import { prisma } from "@/lib/db";

// The Futures desk's status while PARKED (Aug 2026): engine heartbeats, the mode flag and
// the engines' own position records, read from the DB only. Deliberately no Tradovate call —
// the retired dashboard's broker polls were what tripped Tradovate's per-account rate limit
// and killed the engine.
export const dynamic = "force-dynamic";

function countPositions(raw: string | undefined): number | null {
  if (!raw) return null;
  try { const j = JSON.parse(raw); return j && typeof j === "object" ? Object.keys(j).length : null; } catch { return null; }
}

export async function GET() {
  try {
    const keys = ["futures_engine_heartbeat_demo", "futures_engine_heartbeat_live", "trading_mode_futures", "futures_positions_live", "futures_positions_demo", "futures_cron_last_run"];
    const rows = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
    const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return Response.json({
      heartbeats: { demo: v.futures_engine_heartbeat_demo ?? null, live: v.futures_engine_heartbeat_live ?? null, cron: v.futures_cron_last_run ?? null },
      mode: v.trading_mode_futures ?? null,
      positions: { live: countPositions(v.futures_positions_live), demo: countPositions(v.futures_positions_demo) },
    });
  } catch (e) {
    return Response.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
