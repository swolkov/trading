import { buildCard, refreshLive, roomView, saveSettings } from "@/lib/trading-room";

// THE TRADING ROOM — the page's read, and its two writes: his size and daily loss line (contracts,
// daily loss line) and a "refresh now" that rebuilds the card and re-reads the live account.
// Both writes are owner-only through the proxy; neither can reach an order endpoint.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try { return Response.json(await roomView()); }
  catch (e) { return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: { action?: string; contracts?: number; dailyLossUsd?: number | null; maxTradesPerDay?: number | null } = {};
  try { body = await request.json(); } catch { /* empty */ }
  try {
    if (body.action === "refresh") { await buildCard(); await refreshLive(); return Response.json(await roomView()); }
    if (body.action === "settings") {
      const patch: Record<string, unknown> = {};
      if ("contracts" in body) patch.contracts = body.contracts;
      if ("dailyLossUsd" in body) patch.dailyLossUsd = body.dailyLossUsd;
      if ("maxTradesPerDay" in body) patch.maxTradesPerDay = body.maxTradesPerDay;
      await saveSettings(patch);
      return Response.json({ ok: true, ...(await roomView()) });
    }
    return Response.json({ error: "action must be refresh or settings" }, { status: 400 });
  } catch (e) { return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
}
