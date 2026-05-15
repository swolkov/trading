import { runWatchdog } from "@/lib/watchdog-agent";

export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runWatchdog();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/watchdog]", error);
    try {
      const { sendNotification } = await import("@/lib/notifications");
      await sendNotification(`CRON CRASH: /api/cron/watchdog — ${String(error).slice(0, 200)}`, "general");
    } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
