import { runOptionsAgent } from "@/lib/options-agent";
import { prisma } from "@/lib/db";

export const maxDuration = 120;

// Options agent cron — scans the universe, scores from research, and trades 7-14 DTE defined-risk
// debit spreads (buy-only) with hard risk caps. Manages open spreads on every tick. Scheduled
// twice-hourly during RTH (see vercel.json). Gated internally by options_enabled + market clock.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await prisma.agentConfig
      .upsert({
        where: { key: "options_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "options_cron_last_run", value: new Date().toISOString() },
      })
      .catch(() => {});
    const result = await runOptionsAgent();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/options]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
