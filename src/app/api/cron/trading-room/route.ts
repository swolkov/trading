import { roomTick } from "@/lib/trading-room";

// THE TRADING ROOM TICK — every 5 minutes, Sunday evening through Friday (vercel.json): rebuild the level card from
// Yahoo, read Spencer's LIVE Tradovate account (read-only: balance, positions, the day's fills),
// post the morning card to Slack at 08:55 ET, and the 15-minute heads-up before a scheduled print.
// It never places an order — there is no code path from this route to any order endpoint.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  try { const r = await roomTick(); return Response.json({ ...r, ms: Date.now() - started }); }
  catch (e) { return Response.json({ ok: false, notes: [String(e).slice(0, 300)], ms: Date.now() - started }, { status: 500 }); }
}
