import crypto from "crypto";
import { prisma } from "@/lib/db";
import { parseAlert } from "@/lib/futures-desk-rules";
import { ensureDeskTables, handleAlert } from "@/lib/futures-desk";

// TRADINGVIEW → FUTURES DESK. A TradingView alert POSTs the JSON its message template carries:
//   { "secret": "…", "desk": "futures", "edge": "index_daily_mr", "symbol": "ES", "action": "entry",
//     "side": "long", "price": 6531.25, "stop": 6470.50, "bar": "2026-09-14T21:00:00Z", "tf": "1D" }
// Auth is the shared secret in the BODY (TradingView cannot set headers), compared in constant time.
// Containment, in order: body-size cap → JSON guard → secret → DB-backed rate limit → the desk's own
// dedupe (edge+market+action+bar is one event; TradingView retries on timeout, and a retry must never
// become a second order). Separate route from the Kraken webhook so the desks share nothing but the secret.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function secretMatches(provided: unknown): boolean {
  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  if (!secret || typeof provided !== "string") return false;
  const a = Buffer.from(provided), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len > 4096) return Response.json({ error: "payload too large" }, { status: 413 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body !== "object" || body === null) return Response.json({ error: "invalid JSON" }, { status: 400 });
  if (!secretMatches((body as Record<string, unknown>).secret)) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Rate limit AFTER auth: junk traffic cannot starve real alerts. 40 alerts a minute is far above
  // nine charts firing at once; a leaked secret still cannot flood the broker.
  try {
    await ensureDeskTables();
    const [{ recent }] = await prisma.$queryRawUnsafe<{ recent: bigint }[]>(`SELECT count(*)::bigint AS recent FROM futures_desk_signals WHERE received_at > now() - interval '60 seconds'`);
    if (Number(recent) > 40) return Response.json({ error: "rate limited" }, { status: 429 });
  } catch { return Response.json({ error: "inbox unavailable — alert not accepted" }, { status: 503 }); }

  const parsed = parseAlert(body);
  if (!parsed.ok) return Response.json({ error: parsed.reason }, { status: 400 });
  try {
    const out = await handleAlert(parsed.alert);
    return Response.json(out);
  } catch (e) {
    console.error("[/api/webhook/tradingview-futures]", e);
    return Response.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
