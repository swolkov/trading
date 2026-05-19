import { runCryptoAgent } from "@/lib/crypto-agent";
import { prisma } from "@/lib/db";

export const maxDuration = 300;

// Crypto agent cron — runs on schedule to scan and trade crypto 24/7.
// Unlike futures, there's no real-time engine to defer to.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Write heartbeat
    try {
      await prisma.agentConfig.upsert({
        where: { key: "crypto_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "crypto_cron_last_run", value: new Date().toISOString() },
      });
    } catch {}

    const result = await runCryptoAgent();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/crypto]", error);
    try {
      const { sendNotification } = await import("@/lib/notifications");
      await sendNotification(`CRON CRASH: /api/cron/crypto — ${String(error).slice(0, 200)}`, "general");
    } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
