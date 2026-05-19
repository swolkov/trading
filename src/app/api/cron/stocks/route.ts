import { runStocksAgent } from "@/lib/stocks-agent";
import { prisma } from "@/lib/db";

export const maxDuration = 300;

// Stocks swing agent cron — runs during RTH to scan and manage swing trades.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    try {
      await prisma.agentConfig.upsert({
        where: { key: "stocks_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "stocks_cron_last_run", value: new Date().toISOString() },
      });
    } catch {}

    const result = await runStocksAgent();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/stocks]", error);
    try {
      const { sendNotification } = await import("@/lib/notifications");
      await sendNotification(`CRON CRASH: /api/cron/stocks — ${String(error).slice(0, 200)}`, "general");
    } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
