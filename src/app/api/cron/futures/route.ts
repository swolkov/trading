import { runFuturesAgent } from "@/lib/futures-agent";
import { checkTradovateAuth } from "@/lib/tradovate";
import { reconcileFills } from "@/lib/fill-reconciliation";
import { prisma } from "@/lib/db";

export const maxDuration = 300;

// Futures agent cron — SAFETY NET for the Railway real-time engine.
// If the real-time engine is alive (heartbeat < 5 min old), this cron defers trading.
// Fill reconciliation ALWAYS runs to ensure DB matches Tradovate.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const auth = await checkTradovateAuth();
    if (!auth.authenticated) {
      return Response.json({ status: "skipped", reason: "Tradovate not connected" });
    }

    // ALWAYS run fill reconciliation — catches missed trades regardless of engine status
    let reconciliation;
    try {
      reconciliation = await reconcileFills();
      if (reconciliation.backfilled > 0 || reconciliation.pnlCorrections > 0) {
        console.log(`[cron/futures] Reconciliation: ${reconciliation.backfilled} backfilled, ${reconciliation.pnlCorrections} P&L corrected`);
      }
    } catch (err) {
      console.error("[cron/futures] Reconciliation error:", err);
      reconciliation = { error: String(err) };
    }

    // Check if the real-time engine is alive AND actually processing
    const heartbeat = await prisma.agentConfig.findUnique({
      where: { key: "futures_engine_heartbeat" },
    });

    if (heartbeat?.value) {
      let lastBeat: number;
      let currentTickCount: number | null = null;
      let yahooHealth: string | null = null;

      try {
        // Enhanced heartbeat: JSON with tickCount, positions, yahoo health, etc.
        const parsed = JSON.parse(heartbeat.value);
        lastBeat = new Date(parsed.timestamp).getTime();
        currentTickCount = parsed.tickCount ?? null;
        yahooHealth = parsed.yahooHealth ?? null;
      } catch {
        // Legacy format: plain ISO string
        lastBeat = new Date(heartbeat.value).getTime();
      }

      const ageMinutes = (Date.now() - lastBeat) / 60000;

      if (ageMinutes < 5) {
        // Heartbeat is fresh — but verify engine is actually processing ticks
        let engineStalled = false;

        if (currentTickCount !== null) {
          const prevTickRecord = await prisma.agentConfig.findUnique({
            where: { key: "futures_cron_last_tick_count" },
          });

          if (prevTickRecord?.value) {
            const prevTickCount = parseInt(prevTickRecord.value, 10);
            // Tick count unchanged across 2+ cron checks = engine stuck
            if (currentTickCount <= prevTickCount) {
              engineStalled = true;
              console.log(`[cron/futures] Engine heartbeat fresh but STALLED: tickCount ${currentTickCount} unchanged. Taking over.`);
            }
          }

          // Save tick count for next comparison
          await prisma.agentConfig.upsert({
            where: { key: "futures_cron_last_tick_count" },
            update: { value: String(currentTickCount) },
            create: { key: "futures_cron_last_tick_count", value: String(currentTickCount) },
          });
        }

        if (!engineStalled) {
          return Response.json({
            status: "deferred",
            reason: `Real-time engine alive (heartbeat ${ageMinutes.toFixed(1)} min ago, ticks: ${currentTickCount ?? "?"}, yahoo: ${yahooHealth ?? "?"}).`,
            reconciliation,
          });
        }
      } else {
        console.log(`[cron/futures] Real-time engine heartbeat stale (${ageMinutes.toFixed(0)} min). Taking over.`);
      }
    }

    const result = await runFuturesAgent();
    return Response.json({ ...result, reconciliation });
  } catch (error) {
    console.error("[/api/cron/futures]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
