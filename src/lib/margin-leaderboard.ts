// MULTI-STRATEGY LEADERBOARD + THE EXPLICIT LIVE GATE (C2, Sep 15 2026).
//
// strategyBreakdown() is one SQL aggregate per sleeve and its verdict path is test-pinned, so
// this is a WRAPPER: the same rows the scoreboard counts (RECORD_SQL), loaded once in resolve
// order and handed to the pure metrics (margin-metrics.ts) — Sharpe, Sortino, profit factor,
// max drawdown, R-multiples, MFE/MAE, the rolling decay read — and to promotionVerdict, the
// operating spec's live gate written out as an ordered list of named gates so the page, the
// weekly memo and the arm switch all read the same words. It changes nothing; it reports.
import { prisma } from "@/lib/db";
import { LIVE_RESCALE_SQL, RECORD_SQL, ensureShadowColumns, exitParams, strategyBreakdown, type StrategyStat } from "@/lib/margin-shadow";
import { rollingVerdict, sleeveMetrics, type RollingState, type SleeveMetrics, type SleeveRow } from "@/lib/margin-metrics";
import { LIVE_RISK_DEFAULT_PCT, liveContainerFor, parseLiveRiskBasePct } from "@/lib/margin-live-risk";
import { DEFAULT_DD_HALT_PCT } from "@/lib/margin-risk-tiers";
import { RETIRED_AUTO_SOURCES } from "@/lib/margin-auto-plans";

// ---- Rows ----------------------------------------------------------------------------------

interface LeaderboardParams { liveRiskPct: number; paperRiskPct: number; refEquity: number; breakerPct: number }
/** The same keys strategyBreakdown reads (its readers are private to margin-shadow), same defaults. */
async function leaderboardParams(): Promise<LeaderboardParams> {
  const num = async (key: string) => prisma.agentConfig.findUnique({ where: { key } })
    .then((r) => (r?.value ? parseFloat(r.value) : NaN)).catch(() => NaN);
  const [live, paper, eq, breaker] = await Promise.all([
    num("kraken_margin_live_max_risk_pct"), num("kraken_margin_max_risk_pct"), num("kraken_shadow_ref_equity"), num("kraken_margin_max_drawdown_pct"),
  ]);
  return {
    liveRiskPct: parseLiveRiskBasePct(Number.isFinite(live) ? live : LIVE_RISK_DEFAULT_PCT),
    paperRiskPct: Number.isFinite(paper) && paper > 0 ? paper : 3,
    refEquity: Number.isFinite(eq) && eq > 0 ? eq : 5000,
    breakerPct: Number.isFinite(breaker) && breaker > 0 ? breaker : DEFAULT_DD_HALT_PCT,
  };
}

type RawRow = {
  id: number; source: string; side: string; time: Date; shadow_resolved_at: Date | null; mark_price: number | null;
  shadow_exit: number | null; shadow_pnl: number | null; live_pnl: number | null; shadow_fees: number | null;
  shadow_notional: number | null; shadow_stop_frac: number | null; shadow_peak: number | null; shadow_trough: number | null;
  leverage: number | null; shadow_reason: string | null; conviction: string | null;
};

/**
 * Every resolved row of the record (RECORD_SQL), oldest resolution first, with the live-priced
 * P&L beside the paper one. One R in dollars = notional × the stop fraction — the stored
 * shadow_stop_frac when a sleeve set one (C5's ATR twin), else the container's fixed stop from
 * exitParams. Legacy rows without a frozen notional have riskUsd 0 and land in the "no R" bucket.
 */
export async function loadSleeveRows(opts: { source?: string } = {}): Promise<SleeveRow[]> {
  await ensureShadowColumns();
  const p = await leaderboardParams();
  const args: unknown[] = [p.liveRiskPct, p.paperRiskPct];
  let where = `shadow_status='resolved' AND ${RECORD_SQL}`;
  if (opts.source) { args.push(opts.source); where += ` AND COALESCE(source,'manual') = $3`; }
  const rows = await prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT id, COALESCE(source,'manual') AS source, side, time, shadow_resolved_at, mark_price, shadow_exit, shadow_pnl,
       shadow_pnl * ${LIVE_RESCALE_SQL} AS live_pnl,
       shadow_fees, shadow_notional, shadow_stop_frac, shadow_peak, shadow_trough, leverage, shadow_reason, conviction
     FROM tradingview_alerts
     WHERE ${where}
     ORDER BY shadow_resolved_at, id`,
    ...args,
  );
  return rows.map((r) => {
    const entry = r.mark_price ?? 0;
    const lev = r.leverage || 2;
    const { oneR } = exitParams(r.source === "manual" ? null : r.source, lev, entry);
    const stopFrac = r.shadow_stop_frac != null && r.shadow_stop_frac > 0 ? r.shadow_stop_frac : entry > 0 ? oneR / entry : 0;
    const notional = r.shadow_notional ?? 0;
    return {
      id: r.id, source: r.source, side: r.side,
      time: r.time.toISOString(), resolvedAt: (r.shadow_resolved_at ?? r.time).toISOString(),
      entry, exit: r.shadow_exit, pnl: r.shadow_pnl ?? 0, livePnl: r.live_pnl ?? r.shadow_pnl ?? 0, fees: r.shadow_fees ?? 0,
      notional, riskUsd: notional * stopFrac,
      peak: r.shadow_peak, trough: r.shadow_trough,
      oneR: r.shadow_stop_frac != null && r.shadow_stop_frac > 0 ? entry * r.shadow_stop_frac : oneR,
      reason: r.shadow_reason, conviction: r.conviction,
    };
  });
}

// ---- The gate (pure) ------------------------------------------------------------------------

export const PROMOTION_MIN_RESOLVED = 30;
export const PROMOTION_MIN_T = 2;
export const PROMOTION_MIN_DAYS = 7;
export const PROMOTION_MIN_PF = 1.2;

export interface PromotionInput {
  source: string;
  forwardResolved: number;      // resolved trades entered under the rule as it stands
  liveNet: number;              // net at live sizing
  tStat: number | null;         // on the live-priced series
  days: number;                 // distinct resolution days
  maxDDPct: number | null;      // live series' max drawdown ÷ kraken_shadow_ref_equity (fraction)
  breakerPct: number;           // kraken_margin_max_drawdown_pct (percent)
  profitFactor: number | null;
  rolling: RollingState;
  hasContainer: boolean;        // liveContainerFor(source) != null — the guardian can mirror it
  retired?: boolean;
}
export interface PromotionGate { name: string; ok: boolean; value: string; target: string }
export type PromotionStage = "gathering" | "not paying" | "promising" | "PAPER-ONLY" | "PROMOTE-READY" | "REDUCE" | "retired";
export interface PromotionVerdict { ready: boolean; stage: PromotionStage; gates: PromotionGate[]; failed: string[]; note: string }

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
const pfText = (pf: number | null) => (pf == null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2));

/**
 * THE LIVE GATE, in order. Every gate is evaluated (the page shows all of them), `ready` needs
 * all of them, and the stage names the first thing that is missing:
 *   gathering (sample) → not paying (net) → promising (t / days / drawdown / PF short) →
 *   REDUCE (the rolling record is DECAYING — C3 halves live risk) → PAPER-ONLY (everything
 *   green but no guardian-mirrored container) → PROMOTE-READY.
 * Sharpe is deliberately NOT a gate (see margin-metrics.ts): overlapping trades inflate it.
 */
export function promotionVerdict(i: PromotionInput): PromotionVerdict {
  const ddPct = i.maxDDPct != null ? i.maxDDPct * 100 : null;
  const gates: PromotionGate[] = [
    { name: "Forward resolved trades", ok: i.forwardResolved >= PROMOTION_MIN_RESOLVED, value: String(i.forwardResolved), target: String(PROMOTION_MIN_RESOLVED) },
    { name: "Net at live sizing", ok: i.forwardResolved > 0 && i.liveNet > 0, value: money(i.liveNet), target: "> $0" },
    { name: "Confidence (t)", ok: i.tStat != null && i.tStat >= PROMOTION_MIN_T, value: i.tStat == null ? "—" : i.tStat.toFixed(2), target: PROMOTION_MIN_T.toFixed(2) },
    { name: "Distinct days", ok: i.days >= PROMOTION_MIN_DAYS, value: String(i.days), target: String(PROMOTION_MIN_DAYS) },
    { name: "Max drawdown (live series)", ok: ddPct != null && ddPct <= i.breakerPct, value: ddPct == null ? "—" : `${ddPct.toFixed(1)}%`, target: `≤ ${i.breakerPct}% (the breaker)` },
    { name: "Profit factor", ok: i.profitFactor != null && i.profitFactor >= PROMOTION_MIN_PF, value: pfText(i.profitFactor), target: `≥ ${PROMOTION_MIN_PF.toFixed(1)}` },
    { name: "Rolling record", ok: i.rolling !== "DECAYING", value: i.rolling, target: "not DECAYING" },
    { name: "Live container", ok: i.hasContainer, value: i.hasContainer ? "guardian-mirrored" : "none", target: "guardian-mirrored" },
  ];
  const failed = gates.filter((g) => !g.ok).map((g) => g.name);
  const ok = (n: number) => gates[n].ok;
  let stage: PromotionStage;
  if (i.retired) stage = "retired";
  else if (!ok(0)) stage = "gathering";
  else if (!ok(1)) stage = "not paying";
  else if (!ok(6)) stage = "REDUCE";
  else if (!ok(2) || !ok(3) || !ok(4) || !ok(5)) stage = "promising";
  else if (!ok(7)) stage = "PAPER-ONLY";
  else stage = "PROMOTE-READY";
  const ready = stage === "PROMOTE-READY";
  const note = ready ? "Real edge — gate open"
    : stage === "PAPER-ONLY" ? "PAPER-ONLY — needs a guardian-mirrored container"
    : stage === "REDUCE" ? "REDUCE — the rolling-30 record is decaying"
    : stage === "retired" ? "retired"
    : `${gates.filter((g) => g.ok).length} of ${gates.length} green`;
  return { ready, stage, gates, failed, note };
}

// ---- The leaderboard ------------------------------------------------------------------------

export interface RollingSummary { state: RollingState; window: number; welchT: number | null; note: string; lastN: number; lastExpectancy: number | null; priorExpectancy: number | null; lastNet: number }
export interface LeaderboardRow extends StrategyStat {
  metrics: SleeveMetrics;        // live-priced series
  paperMetrics: SleeveMetrics;   // the same rows as scored
  rolling: RollingSummary;
  promotion: PromotionVerdict;
}

export function summariseRolling(v: ReturnType<typeof rollingVerdict>): RollingSummary {
  return { state: v.state, window: v.window, welchT: v.welchT, note: v.note, lastN: v.last.n, lastExpectancy: v.last.expectancy, priorExpectancy: v.prior?.expectancy ?? null, lastNet: v.last.net };
}

/** strategyBreakdown + per-row metrics + the gate, sorted ready first, then by Sharpe. Retired sleeves keep their rows. */
export async function leaderboard(): Promise<LeaderboardRow[]> {
  const [stats, rows, p] = await Promise.all([strategyBreakdown(), loadSleeveRows(), leaderboardParams()]);
  const bySource = new Map<string, SleeveRow[]>();
  for (const r of rows) {
    const list = bySource.get(r.source) ?? [];
    list.push(r);
    bySource.set(r.source, list);
  }
  const out: LeaderboardRow[] = stats.map((s) => {
    const sleeveRows = bySource.get(s.key) ?? [];
    const metrics = sleeveMetrics(sleeveRows, { series: "live", refEquity: p.refEquity });
    const paperMetrics = sleeveMetrics(sleeveRows, { series: "paper", refEquity: p.refEquity });
    const rolling = rollingVerdict(sleeveRows, undefined, { series: "live", refEquity: p.refEquity });
    const promotion = promotionVerdict({
      source: s.key, forwardResolved: s.forwardResolved, liveNet: s.liveNet, tStat: s.tStat, days: s.days,
      maxDDPct: metrics.maxDDPct, breakerPct: p.breakerPct, profitFactor: metrics.profitFactor,
      rolling: rolling.state, hasContainer: liveContainerFor(s.key) != null,
      retired: RETIRED_AUTO_SOURCES.has(s.key) || s.verdict.startsWith("retired"),
    });
    return { ...s, metrics, paperMetrics, rolling: summariseRolling(rolling), promotion };
  });
  return out.sort((a, b) => {
    if (a.promotion.ready !== b.promotion.ready) return a.promotion.ready ? -1 : 1;
    return (b.metrics.sharpe ?? -Infinity) - (a.metrics.sharpe ?? -Infinity);
  });
}
