import { runFuturesAgent } from "@/lib/futures-agent";
import { checkTradovateAuth } from "@/lib/tradovate";
import { prisma } from "@/lib/db";

export const maxDuration = 300;

// Futures agent cron — SAFETY NET for the Railway real-time engine.
// If the real-time engine is alive (heartbeat < 5 min old), this cron defers.
// If the engine is down, this cron takes over position management.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Check if the real-time engine is alive
    const heartbeat = await prisma.agentConfig.findUnique({
      where: { key: "futures_engine_heartbeat" },
    });

    if (heartbeat?.value) {
      const lastBeat = new Date(heartbeat.value).getTime();
      const ageMinutes = (Date.now() - lastBeat) / 60000;

      if (ageMinutes < 5) {
        return Response.json({
          status: "deferred",
          reason: `Real-time engine alive (last heartbeat ${ageMinutes.toFixed(1)} min ago). Cron deferring.`,
        });
      }

      // Engine is stale — take over
      console.log(`[cron/futures] Real-time engine heartbeat stale (${ageMinutes.toFixed(0)} min). Taking over.`);
    }

    const auth = await checkTradovateAuth();
    if (!auth.authenticated) {
      return Response.json({ status: "skipped", reason: "Tradovate not connected" });
    }

    const result = await runFuturesAgent();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/futures]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
