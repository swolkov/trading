import { deskStatus } from "@/lib/futures-desk-status";

// The Futures Desk page's one read. Per-instance cache of 20s so open admin tabs do not spend
// Tradovate's request budget (the same budget the guardian and the webhook use).
export const dynamic = "force-dynamic";
let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 20_000) return Response.json(cache.body);
  try {
    const body = await deskStatus();
    cache = { at: Date.now(), body };
    return Response.json(body);
  } catch (e) {
    return Response.json({ error: String(e).slice(0, 300) }, { status: 500 });
  }
}
