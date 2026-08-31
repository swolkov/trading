import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { getKrakenPrice } from "@/lib/kraken";
import { executeAlert, type AlertOrder } from "@/lib/margin-executor";

// TradingView alert webhook. TradingView fires a POST with whatever JSON template the
// alert was configured with; ours is:
//   { "secret": "…", "symbol": "BTC/USD", "side": "buy" | "sell" | "close",
//     "leverage": 2, "note": "4h wedge break" }
//
// Auth: shared secret in the BODY (TradingView cannot set headers), compared against the
// TRADINGVIEW_WEBHOOK_SECRET env var. The route is public (TradingView's servers call it)
// but does nothing without the secret. Every valid alert is stored, priced at the live
// market for later scoring, pushed to Slack, and handed to the executor — which is
// config-gated and defaults to tracked-only (see margin-executor.ts).
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

// Basic per-instance flood guard (a runaway alert loop on TradingView's side).
let windowStart = 0;
let windowCount = 0;

export async function POST(request: Request) {
  // Rate limit: 30/minute per instance.
  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; windowCount = 0; }
  if (++windowCount > 30) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  if (!secret || body.secret !== secret) {
    // Do not reveal whether the secret is configured.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const symbol = String(body.symbol ?? "").toUpperCase();
  const side = String(body.side ?? "").toLowerCase();
  if (!/^[A-Z0-9]{2,10}\/USD$/.test(symbol) || !["buy", "sell", "close"].includes(side)) {
    return Response.json({ error: "symbol must be XXX/USD and side buy|sell|close" }, { status: 400 });
  }
  const leverage = Number(body.leverage) || undefined;
  const note = String(body.note ?? "").slice(0, 300);

  // Price the alert at the live market so tracked-mode alerts can be scored honestly later.
  let markPrice: number | null = null;
  try { markPrice = await getKrakenPrice(symbol); } catch { markPrice = null; }

  const alert: AlertOrder = { symbol, side: side as AlertOrder["side"], leverage, note };
  const result = await executeAlert(alert);

  try {
    await prisma.$executeRawUnsafe(ALERTS_TABLE_SQL);
    await prisma.$executeRawUnsafe(
      `INSERT INTO tradingview_alerts (symbol, side, leverage, note, mark_price, executed, validated, exec_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
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
    "kraken",
  );

  return Response.json({ ok: true, tracked: !result.executed, ...result });
}
