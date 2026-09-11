import { propStatus } from "@/lib/prop-desk";

// The Prop Desk page's one read. Per-instance cache of 20s so open admin tabs do not spend
// the account's 10 req/s read budget — the guardian and executor read DXtrade uncached.
export const dynamic = "force-dynamic";

let cache: { at: number; value: Awaited<ReturnType<typeof propStatus>> } | null = null;
const TTL_MS = 20_000;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < TTL_MS) return Response.json({ ...cache.value, cachedMs: Date.now() - cache.at });
    const value = await propStatus();
    cache = { at: Date.now(), value };
    return Response.json({ ...value, cachedMs: 0 });
  } catch (e) {
    return Response.json({ configured: false, brokerError: String(e).slice(0, 200) }, { status: 500 });
  }
}
