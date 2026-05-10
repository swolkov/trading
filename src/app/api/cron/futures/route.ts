import { runFuturesAgent } from "@/lib/futures-agent";
import { checkTradovateAuth } from "@/lib/tradovate";

export const maxDuration = 300;

// Futures agent cron — runs every 30 min during futures market hours

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const auth = await checkTradovateAuth();
    if (!auth.authenticated) {
      return Response.json({ status: "skipped", reason: "Tradovate not connected — set env vars" });
    }

    const result = await runFuturesAgent();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/futures]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
