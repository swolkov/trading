import { runTradingAgent } from "@/lib/auto-trader";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";

export const maxDuration = 300; // 5 minutes max for Vercel

export async function GET(request: Request) {
  // Verify cron secret to prevent unauthorized access
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runTradingAgent();
    // Write heartbeat for watchdog monitoring
    await prisma.agentConfig.upsert({
      where: { key: "trade_last_run" },
      update: { value: new Date().toISOString() },
      create: { key: "trade_last_run", value: new Date().toISOString() },
    }).catch(() => {});
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/trade]", error);
    try { await sendNotification(`🚨 TRADE CRON CRASH: ${error instanceof Error ? error.message : "Unknown"}`, "general"); } catch {}
    return Response.json(
      { error: error instanceof Error ? error.message : "Agent failed" },
      { status: 500 }
    );
  }
}

// Also allow POST for manual triggers from the UI (requires auth)
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runTradingAgent();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/trade POST]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Agent failed" },
      { status: 500 }
    );
  }
}
