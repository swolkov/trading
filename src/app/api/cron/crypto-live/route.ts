import { runCryptoAgent } from "@/lib/crypto-agent";
import { prisma } from "@/lib/db";

export const maxDuration = 300;

// Live crypto cron — same schedule as paper, but routes to Alpaca live account.
// Reads live_crypto_* config keys. Enable with: live_crypto_enabled = "true"

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    try {
      await prisma.agentConfig.upsert({
        where: { key: "live_crypto_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "live_crypto_cron_last_run", value: new Date().toISOString() },
      });
    } catch {}

    const result = await runCryptoAgent(true); // liveMode = true
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/crypto-live]", error);
    try {
      const { sendNotification } = await import("@/lib/notifications");
      await sendNotification(`CRON CRASH: /api/cron/crypto-live — ${String(error).slice(0, 200)}`, "general");
    } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
