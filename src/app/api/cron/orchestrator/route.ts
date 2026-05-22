import { runOrchestrator } from "@/lib/orchestrator";
import { prisma } from "@/lib/db";

export const maxDuration = 30;

// ============ ORCHESTRATOR CRON ============
// Runs every 1 minute. The nervous system of the trading brain.
// Reads pending events → triggers workflows → updates session state.
// Lightweight by design — most runs complete in <1s with 0 events.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runOrchestrator();

    // Update heartbeat
    await prisma.agentConfig
      .upsert({
        where: { key: "orchestrator_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "orchestrator_last_run", value: new Date().toISOString() },
      })
      .catch(() => {});

    return Response.json({
      status: "ok",
      ...result,
    });
  } catch (error) {
    console.error("[orchestrator]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
