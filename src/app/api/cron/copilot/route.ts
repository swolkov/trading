import { copilotMinute } from "@/lib/copilot";
import { pageCronCrash } from "@/lib/notifications";

// THE CO-PILOT — every minute, Sunday evening through Friday (vercel.json), four polls 15 seconds apart. Reads Spencer's
// LIVE Tradovate position through the room's session and talks in Slack. It never places an order: there is no code path
// from this route to any order endpoint, and it never logs in on its own (the room's token or nothing).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  try { const r = await copilotMinute(started); return Response.json({ ...r, ms: Date.now() - started }); }
  catch (e) { await pageCronCrash("copilot", e); return Response.json({ ran: false, error: String(e).slice(0, 300), ms: Date.now() - started }, { status: 500 }); }
}
