import { runWheelOnce } from "@/lib/wheel-tracker";
import { prisma } from "@/lib/db";

export const maxDuration = 300;

// Wheel forward paper tracker — advances a simulated ~$30K CSP/covered-call book on live option data
// and banks a daily ledger row in the DB. Simulation only: places NO orders, never touches any real
// account. Scheduled weekdays during market hours (see vercel.json). Idempotent per day.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    try {
      await prisma.agentConfig.upsert({
        where: { key: "wheel_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "wheel_cron_last_run", value: new Date().toISOString() },
      });
    } catch {}

    const r = await runWheelOnce();
    return Response.json({
      advanced: r.advanced,
      equity: r.equity,
      return_pct: r.retPct,
      open_puts: r.state.shortPuts.length,
      open_calls: r.state.shortCalls.length,
      share_lots: Object.keys(r.state.shares).length,
      log: r.log,
      ledgerRow: r.ledgerRow,
    });
  } catch (error) {
    console.error("[/api/cron/wheel-track]", error);
    try {
      const { sendNotification } = await import("@/lib/notifications");
      await sendNotification(`CRON CRASH: /api/cron/wheel-track — ${String(error).slice(0, 200)}`, "general");
    } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
