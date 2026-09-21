import { replayView } from "@/lib/trading-room-replay";

// One journal row's replay: bars, fills, levels. GET ?id=<trip id>. Read-only.
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id || id.length > 120) return Response.json({ error: "id required" }, { status: 400 });
  try {
    const v = await replayView(id);
    return v ? Response.json(v) : Response.json({ error: "no such trade" }, { status: 404 });
  } catch (e) { return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
}
