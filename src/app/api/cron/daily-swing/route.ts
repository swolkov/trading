import { runDailySwing } from "@/lib/daily-swing";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily Index Mean-Reversion — PAPER forward-test cron. Runs once per weekday
// after the US close (21:05 UTC). No broker orders, no engine coupling.
async function handle(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await prisma.agentConfig
      .upsert({
        where: { key: "daily_swing_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "daily_swing_last_run", value: new Date().toISOString() },
      })
      .catch(() => {});
    const result = await runDailySwing();
    return Response.json({ ok: true, result });
  } catch (error) {
    console.error("[/api/cron/daily-swing]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
