import { prisma } from "@/lib/db";
import {
  DEFAULT_MAX_LEVERAGE, LIVE_MAX_HOLD_H, LIVE_STOP_DEFAULT_PCT,
  effectiveMaxLeverage, leverageCapForEquity, liveNotional, liveRiskPct, parseLiveRiskBasePct,
} from "@/lib/margin-live-risk";

// WHAT LIVE WOULD ACTUALLY DO, computed from the same config keys and the same helpers the
// executor and guardian read — beside what PAPER does — so the admin page can show, per
// item, whether live mirrors the record. Every number here is derived, never typed in.
// NO private Kraken call from a display route: the guardian and the executor share the
// API key, and Kraken rejects a nonce that arrives out of order — a page refresh must never
// be able to knock out a protective cancel. Equity comes from the guardian's last run.
export const dynamic = "force-dynamic";

let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < 20_000) return Response.json(cache.body);
    const keys = [
      "kraken_margin_auto", "kraken_margin_validate_only", "kraken_margin_disarmed_dd",
      "kraken_margin_live_max_risk_pct", "kraken_margin_stop_pct", "kraken_margin_trail_pct", "kraken_margin_max_leverage",
      "kraken_margin_per_trade_usd", "kraken_margin_max_hold_h", "kraken_margin_max_positions", "kraken_margin_max_trades_per_day",
      "kraken_margin_trust_alert_conviction",
      "kraken_shadow_ref_equity", "kraken_margin_max_risk_pct",
    ];
    const rows = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
    const c: Record<string, string> = {};
    for (const r of rows) c[r.key] = r.value;
    const num = (k: string, d: number) => { const v = parseFloat(c[k] ?? ""); return Number.isFinite(v) ? v : d; };

    let equity: number | null = null;
    let equityAt: string | null = null;
    try {
      const [st, run] = await Promise.all([
        prisma.agentConfig.findUnique({ where: { key: "margin_watch_state" } }),
        prisma.agentConfig.findUnique({ where: { key: "margin_watch_last_run" } }),
      ]);
      const parsed = st?.value ? (JSON.parse(st.value) as { lastEquity?: number }) : null;
      equity = parsed?.lastEquity != null && Number.isFinite(parsed.lastEquity) && parsed.lastEquity > 0 ? parsed.lastEquity : null;
      equityAt = run?.value ?? null;
    } catch { equity = null; }

    const live = {
      armed: c.kraken_margin_auto === "true" && c.kraken_margin_validate_only === "false",
      auto: c.kraken_margin_auto === "true",
      validateOnly: c.kraken_margin_validate_only !== "false",
      ddBreakerTripped: c.kraken_margin_disarmed_dd === "true",
      baseRiskPct: parseLiveRiskBasePct(num("kraken_margin_live_max_risk_pct", 3)),
      stopPct: num("kraken_margin_stop_pct", LIVE_STOP_DEFAULT_PCT),
      trailPct: num("kraken_margin_trail_pct", 0),
      maxHoldH: num("kraken_margin_max_hold_h", LIVE_MAX_HOLD_H),
      perTradeCapUsd: num("kraken_margin_per_trade_usd", 0),
      maxLeverageCeiling: num("kraken_margin_max_leverage", DEFAULT_MAX_LEVERAGE),
      maxPositions: num("kraken_margin_max_positions", 3),
      maxTradesPerDay: num("kraken_margin_max_trades_per_day", 6),
      trustAlertConviction: c.kraken_margin_trust_alert_conviction === "true",
    };
    const paper = {
      refEquity: num("kraken_shadow_ref_equity", 5000),
      baseRiskPct: num("kraken_margin_max_risk_pct", 3),
      stopPct: 3,          // selective's oneR (margin-shadow exitParams)
      maxHoldH: 48,        // MAX_HOLD_H
      exit: "breakeven at +1R, then trail 1R behind the peak",
    };
    const eq = equity ?? 0;
    const rung = effectiveMaxLeverage(live.maxLeverageCeiling, eq);
    const tiers = (["low", "med", "high"] as const).map((tier) => {
      const riskPct = liveRiskPct(live.baseRiskPct, tier);
      const stopFrac = (live.trailPct > 0 ? live.trailPct : live.stopPct) / 100;
      return {
        tier, riskPct,
        riskUsd: eq > 0 ? (eq * riskPct) / 100 : null,
        notionalUsd: eq > 0 ? liveNotional(eq, riskPct / 100, stopFrac, rung, live.perTradeCapUsd) : null,
      };
    });
    const ladder = [
      { from: 0, cap: leverageCapForEquity(1) },
      { from: 10_000, cap: leverageCapForEquity(10_000) },
      { from: 20_000, cap: leverageCapForEquity(20_000) },
    ];
    const aligned = {
      stop: Math.abs(live.stopPct - paper.stopPct) < 1e-9 && live.trailPct === 0,
      risk: Math.abs(live.baseRiskPct - paper.baseRiskPct) < 1e-9,
      hold: Math.abs(live.maxHoldH - paper.maxHoldH) < 1e-9,
      sizing: live.perTradeCapUsd === 0,
      exit: live.trailPct === 0,   // the guardian's managed exit is paper's; a Kraken trailing-stop would not be
    };
    const body = { live, paper, equity, equityAt, leverageRung: rung, ladder, tiers, aligned, allAligned: Object.values(aligned).every(Boolean), at: new Date().toISOString() };
    cache = { at: Date.now(), body };
    return Response.json(body);
  } catch (error) {
    console.error("[/api/margin/executor-config]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
