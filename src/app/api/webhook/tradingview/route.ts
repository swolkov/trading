import crypto from "crypto";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { getKrakenPrice } from "@/lib/kraken";
import { executeAlert, type AlertOrder } from "@/lib/margin-executor";

// TradingView alert webhook. TradingView fires a POST with whatever JSON template the
// alert was configured with; ours is:
//   { "secret": "…", "symbol": "BTC/USD", "side": "buy" | "sell" | "close",
//     "leverage": 2, "note": "4h wedge break" }
//
// Auth: shared secret in the BODY (TradingView cannot set headers), compared in
// constant time against the TRADINGVIEW_WEBHOOK_SECRET env var. The route is public
// (TradingView's servers call it) but does nothing without the secret. Every valid
// alert is stored, priced at the live market for later scoring, pushed to Slack, and
// handed to the executor — which is config-gated and defaults to tracked-only.
//
// Abuse containment, in order: body-size cap → JSON shape guard → secret check →
// DB-backed rate limit (survives serverless scale-out) → replay dedupe (an identical
// alert within 2 minutes is logged but NOT executed — TradingView retries on timeout,
// and a retry must never become a second real order).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const ALERTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS tradingview_alerts (
  id serial PRIMARY KEY,
  time timestamptz DEFAULT now(),
  symbol text,
  side text,
  leverage double precision,
  note text,
  mark_price double precision,
  executed boolean DEFAULT false,
  validated boolean DEFAULT false,
  exec_note text
)`;

let tableReady = false;
async function ensureAlertsTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(ALERTS_TABLE_SQL);
  // The shadow evaluator owns the rest of the shadow_* columns; the webhook only writes
  // `source`, so ensure just that one exists here (idempotent) rather than relying on the
  // scan cron having run first on a fresh instance.
  await prisma.$executeRawUnsafe(`ALTER TABLE tradingview_alerts ADD COLUMN IF NOT EXISTS source text`);
  tableReady = true;
}

function secretMatches(provided: unknown): boolean {
  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  if (!secret || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  // Size cap before any parsing.
  const len = Number(request.headers.get("content-length") || "0");
  if (len > 8192) return Response.json({ error: "payload too large" }, { status: 413 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (!secretMatches(b.secret)) {
    // Do not reveal whether the secret is configured.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const symbol = String(b.symbol ?? "").toUpperCase();
  const side = String(b.side ?? "").toLowerCase();
  if (!/^[A-Z0-9]{2,10}\/USD$/.test(symbol) || !["buy", "sell", "close"].includes(side)) {
    return Response.json({ error: "symbol must be XXX/USD and side buy|sell|close" }, { status: 400 });
  }
  const leverage = Number(b.leverage) || undefined;
  const note = String(b.note ?? "").slice(0, 300);

  // Rate limit + replay dedupe, both DB-backed so they hold across serverless
  // instances. Rate limiting happens AFTER auth so junk traffic cannot starve real
  // alerts by burning a shared counter.
  let duplicate = false;
  try {
    await ensureAlertsTable();
    const [{ recent, dupes }] = await prisma.$queryRawUnsafe<{ recent: bigint; dupes: bigint }[]>(
      `SELECT
         count(*) FILTER (WHERE time > now() - interval '60 seconds')::bigint AS recent,
         count(*) FILTER (WHERE time > now() - interval '120 seconds'
                            AND symbol = $1 AND side = $2
                            AND COALESCE(leverage, -1) = COALESCE($3::float, -1)
                            AND note = $4)::bigint AS dupes
       FROM tradingview_alerts`,
      symbol, side, leverage ?? null, note,
    );
    if (Number(recent) >= 30) {
      return Response.json({ error: "rate limited" }, { status: 429 });
    }
    duplicate = Number(dupes) > 0;
  } catch (e) {
    // If the guard itself is unreadable, treat the alert as a duplicate: log it, do
    // not trade on it. Fail closed.
    console.error("[/api/webhook/tradingview] guard failed", e);
    duplicate = true;
  }

  // Price the alert at the live market so tracked-mode alerts can be scored honestly.
  let markPrice: number | null = null;
  try { markPrice = await getKrakenPrice(symbol); } catch { markPrice = null; }

  const alert: AlertOrder = { symbol, side: side as AlertOrder["side"], leverage, note };
  const result = duplicate
    ? { executed: false, validated: false, note: "duplicate alert within 2m — logged, not executed" }
    : await executeAlert(alert);

  try {
    await ensureAlertsTable();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tradingview_alerts (symbol, side, leverage, note, mark_price, executed, validated, exec_note, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual')`,
      symbol, side, leverage ?? null, note, markPrice, result.executed, result.validated, result.note,
    );
    await prisma.agentConfig.upsert({
      where: { key: "tradingview_last_alert" },
      update: { value: new Date().toISOString() },
      create: { key: "tradingview_last_alert", value: new Date().toISOString() },
    });
  } catch (e) {
    console.error("[/api/webhook/tradingview] store failed", e);
  }

  await sendNotification(
    `📡 TradingView: ${side.toUpperCase()} ${symbol}${leverage ? ` ${leverage}x` : ""}` +
    `${markPrice ? ` @ $${markPrice.toLocaleString()}` : ""}${note ? ` — ${note}` : ""}\n` +
    `→ ${result.executed ? "✅ EXECUTED" : result.validated ? "🧪 validated (no money moved)" : "👁 tracked"}: ${result.note}`,
    "margin_results",
  );

  return Response.json({ ok: true, tracked: !result.executed, ...result });
}
