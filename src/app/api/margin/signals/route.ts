import { prisma } from "@/lib/db";

// Recent scanner signals for the cockpit's live-signals strip.
export const dynamic = "force-dynamic";

interface Row { ts: Date; coin: string; timeframe: string; kind: string; detail: string; price: number }

export async function GET() {
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS margin_scan_signals (
      id serial PRIMARY KEY, ts timestamptz DEFAULT now(), coin text, timeframe text, kind text, detail text, price double precision)`);
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT ts, coin, timeframe, kind, detail, price FROM margin_scan_signals
       WHERE ts > now() - interval '24 hours' ORDER BY ts DESC LIMIT 60`,
    );
    return Response.json({ signals: rows.map((r) => ({ ...r, ts: r.ts.toISOString() })) });
  } catch (error) {
    console.error("[/api/margin/signals]", error);
    return Response.json({ signals: [], error: String(error) });
  }
}
