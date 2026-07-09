import { prisma } from "@/lib/db";

// Password-gated arm/disarm for the Meme Lab live bot. Human-authorized, mirrors the Kraken go-live button.
//  action "arm"    → meme_live_enabled=true, meme_live_validate=false  (REAL money)
//  action "dryrun" → meme_live_enabled=true, meme_live_validate=true   (build+sign, no send)
//  action "off"    → meme_live_enabled=false                            (paper only)
const LIVE_PASSWORD = (process.env.LIVE_TRADING_PASSWORD || "").trim();

export async function POST(request: Request) {
  try {
    const { password, action } = await request.json();
    if (!LIVE_PASSWORD || !password || String(password).trim() !== LIVE_PASSWORD) {
      return Response.json({ error: "Wrong password" }, { status: 401 });
    }
    const set = async (k: string, v: string) => prisma.agentConfig.upsert({ where: { key: k }, update: { value: v }, create: { key: k, value: v } });
    if (action === "arm") { await set("meme_live_enabled", "true"); await set("meme_live_validate", "false"); }
    else if (action === "dryrun") { await set("meme_live_enabled", "true"); await set("meme_live_validate", "true"); }
    else if (action === "off") { await set("meme_live_enabled", "false"); }
    else return Response.json({ error: "bad action" }, { status: 400 });
    return Response.json({ ok: true, action });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
