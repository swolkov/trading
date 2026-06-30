import { runDCA } from "@/lib/dca-agent";
import { prisma } from "@/lib/db";

export const maxDuration = 120;

// Long-term DCA cron — buys a fixed $ of the target (SPY) and HOLDS. Buy-only, never sells.
// Scheduled weekly at the US market open so notional/fractional orders can fill.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await prisma.agentConfig
      .upsert({
        where: { key: "dca_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "dca_cron_last_run", value: new Date().toISOString() },
      })
      .catch(() => {});
    const result = await runDCA();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/dca]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
