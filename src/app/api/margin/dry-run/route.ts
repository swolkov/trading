import { prisma } from "@/lib/db";
import { getKrakenMarginHealth } from "@/lib/kraken-margin";
import { dryRunNextOrder } from "@/lib/margin-dry-run";
import { DEFAULT_MAX_LEVERAGE } from "@/lib/margin-live-risk";

// OWNER-ONLY, VALIDATE-ONLY. Asks Kraken whether it would accept the EXACT order this desk
// will send next — full size, real leverage, attached stop — and places nothing.
//
// It reads the live config and the real account, sizes with the executor's own helpers, and
// sends AddOrder with validate=true. A green row means the only thing separating it from a
// filled order is a signal.
//
// ⚠️ Never schedule this: private calls share the rate/nonce budget the guardian and executor
// depend on. Owner-triggered, paced, and read-only by construction.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const cfg = async (k: string) => (await prisma.agentConfig.findUnique({ where: { key: k } }))?.value ?? null;
    const num = async (k: string, d: number) => { const v = await cfg(k); const n = v == null || v === "" ? NaN : parseFloat(v); return Number.isFinite(n) ? n : d; };
    const source = (await cfg("kraken_margin_live_sources")) ?? "";
    const armed = source.split(",").map((s) => s.trim()).filter(Boolean)[0];
    if (!armed) return Response.json({ ok: false, error: "no sleeve is armed — nothing to dry-run" }, { status: 400 });

    const health = await getKrakenMarginHealth();
    const asked = new URL(request.url).searchParams.get("symbols");
    // Default to the three deepest books; any US-margin symbol may be passed explicitly.
    const symbols = (asked ? asked.split(",") : ["BTC/USD", "ETH/USD", "SOL/USD"]).map((s) => s.trim()).filter(Boolean).slice(0, 6);

    const { rows, placedOrders, allOk } = await dryRunNextOrder(symbols, {
      source: armed,
      equity: health.equity,
      freeMargin: health.freeMargin,
      baseRiskPct: await num("kraken_margin_live_max_risk_pct", 3),
      leverageCeiling: await num("kraken_margin_max_leverage", DEFAULT_MAX_LEVERAGE),
      perTradeCapUsd: await num("kraken_margin_per_trade_usd", 0),
    });
    return Response.json({
      ok: true, placedOrders, allOk, source: armed,
      equity: health.equity, freeMargin: health.freeMargin,
      note: allOk
        ? "Kraken would accept every one of these at full size with its stop attached. Nothing was placed."
        : "AT LEAST ONE WOULD BE REJECTED — see krakenSays. Nothing was placed.",
      rows,
      summary: rows.map((r) => `${r.symbol}: ${r.ok ? "OK" : "REJECTED"} — $${Math.round(r.notional).toLocaleString()} (${r.volume}) at ${r.leverage}x, stop ${r.stopPx} (${r.stopPct.toFixed(2)}%), margin $${Math.round(r.marginUsd).toLocaleString()}${r.ok ? "" : ` — ${r.krakenSays}`}`),
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
}
