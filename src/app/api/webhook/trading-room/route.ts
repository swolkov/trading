import crypto from "crypto";
import { parseChartLevels, parseFeed } from "@/lib/trading-room-rules";
import { buildCard, loadFeed, recordChartLevels, recordFeed } from "@/lib/trading-room";

// TRADINGVIEW → THE TRADING ROOM'S TAPE. The Pine study (pine/trading-room-levels.pine) posts one
// JSON message when a 5-minute close breaks a level it draws:
//   { "secret": "…", "room": "trading", "symbol": "MNQ", "kind": "or_up", "price": 24810.25,
//     "level": 24800, "atr": 31.2, "volRatio": 1.8, "bar": 1758290700000, "tf": "5" }
// It is recorded and relayed to Slack. Once per confirmed bar it also posts its whole level set
// ({ "kind": "levels", "pdh": …, "onh": …, "orh": …, "vwap": …, "atrD": … }) — stored per symbol and
// used as the card while fresh, so the admin page shows the chart's own numbers in real time. It is NOT a signal to any executor: this route imports nothing
// from the demo desk, and the room has no order path. Same containment as the desk webhook: body-size
// cap → JSON guard → constant-time secret → rate limit → dedupe on symbol+kind+bar.
export const maxDuration = 30;
export const dynamic = "force-dynamic";

function secretMatches(provided: unknown): boolean {
  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  if (!secret || typeof provided !== "string") return false;
  const a = Buffer.from(provided), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  let text: string;
  try { text = await request.text(); } catch { return Response.json({ error: "unreadable body" }, { status: 400 }); }
  if (text.length > 2048) return Response.json({ error: "payload too large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body !== "object" || body === null) return Response.json({ error: "invalid JSON" }, { status: 400 });
  if (!secretMatches((body as Record<string, unknown>).secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const now = Date.now();
  if ((body as Record<string, unknown>).kind === "levels") {
    const lv = parseChartLevels(body, now);
    if (!lv.ok) return Response.json({ error: lv.reason }, { status: 400 });
    try { await recordChartLevels(lv.levels); await buildCard(now); return Response.json({ status: "levels", symbol: lv.levels.symbol, at: lv.levels.at }); }
    catch (e) { return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
  }
  const parsed = parseFeed(body, now);
  if (!parsed.ok) return Response.json({ error: parsed.reason }, { status: 400 });
  try {
    // Rate limit after auth: three charts × ten kinds cannot legitimately exceed this in a minute.
    const recent = (await loadFeed()).filter((e) => now - Date.parse(e.receivedAt) < 60_000).length;
    if (recent > 30) return Response.json({ error: "rate limited" }, { status: 429 });
    const { duplicate } = await recordFeed(parsed.event);
    return Response.json({ status: duplicate ? "duplicate" : "recorded", event: parsed.event });
  } catch (e) {
    console.error("[/api/webhook/trading-room]", e);
    return Response.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
