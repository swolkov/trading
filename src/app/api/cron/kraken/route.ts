import { runKrakenAccumulator } from "@/lib/kraken-agent";
import { prisma } from "@/lib/db";

export const maxDuration = 60;

// Kraken accumulator cron — buys BTC/ETH on dips and HOLDS. Runs every 2h (crypto is 24/7).
// No real-time engine needed: dips last hours-to-days, and we never sell.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await prisma.agentConfig
      .upsert({
        where: { key: "kraken_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "kraken_cron_last_run", value: new Date().toISOString() },
      })
      .catch(() => {});
    const result = await runKrakenAccumulator();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/kraken]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
