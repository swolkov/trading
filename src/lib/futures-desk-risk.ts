// FUTURES DESK — portfolio risk, pure. Open-risk cap, index/metals cluster cap, drawdown tiers and
// the daily loss budget that counts OPEN risk as already spent. No I/O; the guardian feeds it the
// broker's numbers and writes the result to `futures_desk_risk_state` for the page and health.
// Imports run one way (this file → rules) so there is no module cycle.
import { clusterOf, type Cluster, type DeskContext, type DeskLimits, type Side } from "@/lib/futures-desk-rules";

export { CLUSTER_OF, clusterOf, type Cluster } from "@/lib/futures-desk-rules";

export interface OpenRow { root: string; side: Side; risk_usd: number }

/** Σ risk_usd of the open ledger. A rolled leg is closed and its successor open, so a chain counts once. */
export function openRisk(open: { risk_usd: number }[]): number {
  return open.reduce((s, t) => s + (Number.isFinite(t.risk_usd) ? t.risk_usd : 0), 0);
}

export function clusterRisk(open: OpenRow[], cluster: Cluster, side: Side): number {
  return openRisk(open.filter((t) => t.side === side && clusterOf(t.root) === cluster));
}

// ---- drawdown tiers -----------------------------------------------------------------------------
export interface DdTier { tier: 0 | 1 | 2 | 3 | 4; ddPct: number; mult: 1 | 0.75 | 0.5 | 0.25 | 0; label: string }

/** −3% → ×0.75 · −5% → ×0.5 · −7% → ×0.25 (micros only + investigate) · −10% → halted (×0).
 *  No high yet (≤ 0 or non-finite) → tier 0, as the desk behaved before the tiers existed. */
export function ddTier(equity: number, high: number): DdTier {
  if (!(high > 0) || !Number.isFinite(equity)) return { tier: 0, ddPct: 0, mult: 1, label: "normal" };
  const ddPct = -((high - equity) * 100) / high;   // (equity/high − 1)×100 lands on −6.999…; this form is exact at the boundaries
  const eps = 1e-9;
  if (ddPct <= -10 + eps) return { tier: 4, ddPct, mult: 0, label: "halted" };
  if (ddPct <= -7 + eps) return { tier: 3, ddPct, mult: 0.25, label: "micros only + investigate" };
  if (ddPct <= -5 + eps) return { tier: 2, ddPct, mult: 0.5, label: "half budget" };
  if (ddPct <= -3 + eps) return { tier: 1, ddPct, mult: 0.75, label: "three-quarter budget" };
  return { tier: 0, ddPct, mult: 1, label: "normal" };
}

/** What the day may still lose: the budget, plus what is realized so far (negative when down), minus
 *  the open risk already at stake. Negative = spent. */
export function dailyLossRemaining(balance: number, dayStartBalance: number, openRiskUsd: number, limits: Pick<DeskLimits, "sizingBasisUsd" | "dailyLossPausePct">): number {
  // TODO(verify on the demo after deploy): the realized term is totalCashValue − day-start cash. If Tradovate's
  // cash only settles at end of day, this reads 0 intraday — switch the guardian to bal.realizedPnl (deskBalance
  // already returns it) and pass that here as (balance − dayStartBalance).
  return limits.sizingBasisUsd * (limits.dailyLossPausePct / 100) + (balance - dayStartBalance) - openRiskUsd;
}

// ---- the guardian's snapshot ----------------------------------------------------------------------
export interface RiskState {
  dd: number; tier: number; mult: number; openRisk: number;
  clusterRisk: { index_long: number; index_short: number; metals_long: number; metals_short: number };
  dailyLossRemaining: number; at: string;
}

export function riskStateOf(input: { equity: number; equityHigh: number; balance: number; dayStartBalance: number; open: OpenRow[]; limits: DeskLimits; now: Date }): RiskState {
  const t = ddTier(input.equity, input.equityHigh);
  const or = openRisk(input.open);
  return {
    dd: t.ddPct, tier: t.tier, mult: t.mult, openRisk: or,
    clusterRisk: {
      index_long: clusterRisk(input.open, "index", "long"), index_short: clusterRisk(input.open, "index", "short"),
      metals_long: clusterRisk(input.open, "metals", "long"), metals_short: clusterRisk(input.open, "metals", "short"),
    },
    dailyLossRemaining: dailyLossRemaining(input.balance, input.dayStartBalance, or, input.limits),
    at: input.now.toISOString(),
  };
}

/** Tolerant reader for the page and health: bad JSON, a non-object, or any non-finite number → null. */
export function parseRiskState(raw: string | null | undefined): RiskState | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const c = o.clusterRisk as Record<string, unknown> | undefined;
  if (!fin(o.dd) || !fin(o.tier) || !fin(o.mult) || !fin(o.openRisk) || !fin(o.dailyLossRemaining) || typeof o.at !== "string") return null;
  if (!c || typeof c !== "object" || !fin(c.index_long) || !fin(c.index_short) || !fin(c.metals_long) || !fin(c.metals_short)) return null;
  return { dd: o.dd, tier: o.tier, mult: o.mult, openRisk: o.openRisk, clusterRisk: { index_long: c.index_long, index_short: c.index_short, metals_long: c.metals_long, metals_short: c.metals_short }, dailyLossRemaining: o.dailyLossRemaining, at: o.at };
}

// ---- the entry container, built from the guardian's own numbers ---------------------------------
export interface ContextInput {
  enabled: boolean;
  state: { equity?: number; equityHigh?: number; dayKey?: string; dayStartEquity?: number; balance?: number; dayStartBalance?: number; guardianAt?: string; disabledReason?: string };
  open: OpenRow[];
  entriesToday: number;
  limits: DeskLimits;
  alert: { root: string; side: Side };
  newRiskUsd: number;
  now: Date;
  dayKey: string;
}

/** Fail closed on ENTRIES only: until the guardian has stamped a balance and a day-start balance
 *  (the deploy day's first run), no entry can compute its daily budget, so none is placed. Closes,
 *  rolls and re-protection never pass through here. */
export function deskContextOf(i: ContextInput): DeskContext | { refusal: string } {
  const s = i.state;
  if (s.balance == null || s.dayStartBalance == null || !Number.isFinite(s.balance) || !Number.isFinite(s.dayStartBalance)) return { refusal: "risk state not computed yet — waiting for the guardian" };
  const or = openRisk(i.open);
  const cluster = clusterOf(i.alert.root);
  return {
    enabled: i.enabled && !s.disabledReason,
    openRoots: i.open.map((t) => t.root),
    entriesToday: i.entriesToday,
    dayPnlUsd: s.equity != null && s.dayStartEquity != null && s.dayKey === i.dayKey ? s.equity - s.dayStartEquity : 0,
    equityUsd: s.equity ?? 0,
    equityHighUsd: s.equityHigh ?? 0,
    guardianFreshMs: s.guardianAt ? i.now.getTime() - Date.parse(s.guardianAt) : null,
    openRiskUsd: or,
    sameClusterSameSideRiskUsd: cluster ? clusterRisk(i.open, cluster, i.alert.side) : 0,
    dailyLossRemainingUsd: dailyLossRemaining(s.dayKey === i.dayKey ? s.balance : s.dayStartBalance, s.dayStartBalance, or, i.limits),
    ddMult: ddTier(s.equity ?? 0, s.equityHigh ?? 0).mult,
    newRiskUsd: i.newRiskUsd,
  };
}
