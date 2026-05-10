import { runFuturesAgent } from "@/lib/futures-agent";
import { checkAuth } from "@/lib/ibkr";

export const maxDuration = 300;

// Futures agent cron — runs every 30 min during futures market hours
// Futures trade nearly 24 hours (Sun 6pm - Fri 5pm ET) with a 1hr break

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Check if IBKR is connected before running
    const auth = await checkAuth();
    if (!auth.authenticated) {
      return Response.json({ status: "skipped", reason: "IBKR not connected" });
    }

    const result = await runFuturesAgent();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/futures]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
