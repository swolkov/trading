import { deskGuard } from "@/lib/futures-desk";

// THE FUTURES DESK GUARDIAN — every 5 minutes (vercel.json), 24/7, on the Tradovate DEMO account:
// equity + drawdown disable, a working stop on every open position, time stops, contract rolls,
// settlement of closes from the broker's own fills, queued alerts sent at the CME reopen.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  try { const r = await deskGuard(); return Response.json({ ...r, ms: Date.now() - started }); }
  catch (e) { return Response.json({ ok: false, notes: [String(e).slice(0, 300)], ms: Date.now() - started }, { status: 500 }); }
}
