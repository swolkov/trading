import { prisma } from "@/lib/db";
import { syncKrakenTrades, computeMarginScoreboard } from "@/lib/kraken-margin";

// Full backfill of Spencer's trade history from Kraken's ledger into the DB.
// CRON_SECRET-gated POST; safe to re-run (txid is the primary key). The 5-minute
// margin-watch cron keeps it topped up incrementally after this initial pull.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await syncKrakenTrades(true);
    await prisma.agentConfig.upsert({
      where: { key: "margin_trades_synced_at" },
      update: { value: new Date().toISOString() },
      create: { key: "margin_trades_synced_at", value: new Date().toISOString() },
    }).catch(() => {});
    const scoreboard = await computeMarginScoreboard();
    return Response.json({ ok: true, ...result, scoreboard });
  } catch (error) {
    console.error("[/api/margin/sync]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
