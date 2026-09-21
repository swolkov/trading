import { renderReplayPng, replaySignatureOk, replayView } from "@/lib/trading-room-replay";

// THE REPLAY IMAGE — public path (Slack fetches it without a session), gated by an HMAC of the trade id
// under the room's own secret. Read-only; a wrong or missing signature is a 404, never a hint.
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const u = new URL(req.url);
  const id = u.searchParams.get("id")?.trim() ?? "", sig = u.searchParams.get("sig")?.trim() ?? "";
  if (!id || id.length > 120 || !replaySignatureOk(id, sig)) return new Response("not found", { status: 404 });
  try {
    const v = await replayView(id);
    if (!v) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(renderReplayPng(v)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=600" } });
  } catch { return new Response("error", { status: 500 }); }
}
