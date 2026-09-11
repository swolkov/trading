import { propGuard } from "@/lib/prop-desk";

// THE PROP GUARDIAN — every 5 minutes (vercel.json), 24/7, for the Tradeify 247 account.
// Snapshot at 22:00 UTC, the two floors, paper's managed exit on every position, max hold,
// re-protection, close settlement, keep-alive. It never opens a strategy trade; margin-scan
// hands entries to propEntry(). The two crons CAN overlap in wall time — prop-desk.ts saves
// state by merge, serialises entries with a lock and counts the day from broker history.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  try {
    const r = await propGuard();
    return Response.json({ ...r, ms: Date.now() - started });
  } catch (e) {
    return Response.json({ ok: false, errors: [String(e).slice(0, 300)], ms: Date.now() - started }, { status: 500 });
  }
}
