// RISK TIERS — the pure arithmetic behind the live desk's risk ladder (Sep 15 2026).
//
// Three things the operating spec asked for that the executor did not yet say out loud:
//
//   1. DRAWDOWN TIERS. The 15% breaker (margin-watch step 2) is a single trip wire. Between
//      flat and the wire, risk is now scaled DOWN as the account falls from its peak: −5%
//      halves the per-trade risk, −10% quarters it, the breaker still halts at −15%. At the
//      8% A+ ceiling that turns "8.0 → 7.36 → halt" (two losses) into "8.0 → 3.68 → 1.77 →
//      1.73 → halt at −15.2%" (four), and the overshoot of a loss taken at −14.9% falls from
//      −21.7% to −16.6%. It is a slower path to the same wire, never a wider one.
//   2. ONE MULTIPLIER CHAIN. Every live sizing multiplier — conviction, drawdown tier, event
//      window, strategy decay — is applied in liveRiskPctChain and nowhere else, with the 8%
//      ceiling applied last. A1 supplies ddMult, B2 eventMult, C3 decayMult.
//   3. SETUP GRADES are labels on the ladder that already exists (base 4 × conviction 0.5/1/2
//      = 2/4/8 = Normal/Strong/A+), pinned by test to liveRiskPct so the label can never say
//      one number while the sizer uses another.
//
// Plus two small guards: a revenge pause (N losing round trips today → no new entries) and
// liqBufferOk, the explicit form of the liquidation buffer leverageThatFitsStop already
// enforces (inert unless the margin-level floor is disabled — a belt to that brace).
//
// Pure: no I/O, no config reads. The executor and guardian read the keys and call in.
import type { ExposureSummary } from "@/lib/margin-exposure";
import {
  LIVE_RISK_CEILING_PCT,
  LIQ_BUFFER_MULT,
  LIQ_CUSHION,
  LIQ_STOP_ALLOWANCE,
  liveRiskPct,
  type ConvictionTier,
} from "@/lib/margin-live-risk";

export { LIQ_BUFFER_MULT, LIQ_CUSHION, LIQ_STOP_ALLOWANCE };

/** Drawdown from peak (percent) at which risk is scaled, and the multiplier applied. */
export const DD_TIERS = [
  { ddPct: 5, mult: 0.5 },
  { ddPct: 10, mult: 0.25 },
] as const;
/** The breaker's default (kraken_margin_max_drawdown_pct); the executor passes the live value. */
export const DEFAULT_DD_HALT_PCT = 15;
export const DEFAULT_MAX_LOSSES_PER_DAY = 2;

export type DdTier = 0 | 1 | 2 | "halt" | "unknown";
export interface DrawdownTier { dd: number; tier: DdTier; mult: number }

/**
 * Which tier the account is in. `dd` is percent below peak (negative when equity sits above
 * a peak the guardian has not yet raised — tier 0). Non-finite or non-positive inputs are
 * UNKNOWN with multiplier 0: an entry sized on an unreadable peak is an entry sized blind.
 */
export function drawdownTier(peak: number, equity: number, haltPct: number = DEFAULT_DD_HALT_PCT): DrawdownTier {
  if (!Number.isFinite(peak) || !(peak > 0) || !Number.isFinite(equity) || !(equity > 0)) return { dd: NaN, tier: "unknown", mult: 0 };
  const dd = ((peak - equity) / peak) * 100;
  const halt = Number.isFinite(haltPct) && haltPct > 0 ? haltPct : DEFAULT_DD_HALT_PCT;
  if (dd >= halt) return { dd, tier: "halt", mult: 0 };
  if (dd >= DD_TIERS[1].ddPct) return { dd, tier: 2, mult: DD_TIERS[1].mult };
  if (dd >= DD_TIERS[0].ddPct) return { dd, tier: 1, mult: DD_TIERS[0].mult };
  return { dd, tier: 0, mult: 1 };
}

/** A multiplier may only ever REDUCE risk: non-finite or negative → 0 (fail closed), >1 → 1. */
function sanitiseMult(m: number): number {
  if (!Number.isFinite(m) || m < 0) return 0;
  return Math.min(1, m);
}

export interface RiskChainInput {
  basePct: number;
  conviction: ConvictionTier | string | null | undefined;
  ddMult: number;
  eventMult: number;
  decayMult: number;
}

/**
 * THE ONE LIVE MULTIPLIER CHAIN. Percent of equity this trade may risk:
 *
 *   min(LIVE_RISK_CEILING_PCT, liveRiskPct(base, conviction) × ddMult × eventMult × decayMult)
 *
 * The multipliers reduce the CLAMPED ladder value (a fat-fingered base of 6 in a reduced
 * event window risks 4, not 6), and the ceiling is applied again last so nothing here can
 * ever exceed it. Every multiplier is sanitised: unreadable means 0, never 1.
 */
export function liveRiskPctChain(i: RiskChainInput): number {
  const ladder = liveRiskPct(i.basePct, i.conviction);
  const raw = ladder * sanitiseMult(i.ddMult) * sanitiseMult(i.eventMult) * sanitiseMult(i.decayMult);
  return Math.min(LIVE_RISK_CEILING_PCT, Math.max(0, raw));
}

/** The chain with only the drawdown tier applied (event and decay at 1). */
export function tieredRiskPct(basePct: number, conviction: ConvictionTier | string | null | undefined, ddMult: number): number {
  return liveRiskPctChain({ basePct, conviction, ddMult, eventMult: 1, decayMult: 1 });
}

export type SetupGrade = "Normal" | "Strong" | "A+";
/** The prompt's labels for the ladder that already exists: base 4 × 0.5 / 1 / 2. */
export const SETUP_GRADE_PCT: Record<SetupGrade, number> = { Normal: 2, Strong: 4, "A+": 8 };
export function setupGradeFor(conviction: string | null | undefined): SetupGrade {
  if (conviction === "high") return "A+";
  if (conviction === "med") return "Strong";
  return "Normal";   // low, null, unknown — never grade unverified as A+
}

/**
 * Losing TRADES closed since `dayStartMs` — trades, not FIFO lots. reconstructTrips emits one
 * trip per lot consumed, so a pyramid book (parent + add) closed by one order is two trips
 * sharing a pair and a closing time; they are grouped back into the one close here and
 * judged on their summed net. A group is a LOSS only when it lost more than a scratch:
 * max(0.1% of equity, 25% of the trade's risk to its stop), where the risk is the group's
 * notional × `stopFrac` when the caller knows the container's stop. A breakeven exit that
 * merely paid its fees is not a revenge trigger. An unparseable close time counts as today
 * (fail closed: a trip we cannot date is not evidence of a clean day).
 */
export function losersToday(
  trips: { pair: string; closedAt: string; netPnl: number; entryPrice?: number; volume?: number }[],
  dayStartMs: number,
  equity: number,
  stopFrac: number | null = null,
): number {
  const groups = new Map<string, { net: number; notional: number }>();
  for (const t of trips) {
    const at = Date.parse(t.closedAt);
    if (Number.isFinite(at) && at < dayStartMs) continue;
    const key = `${t.pair}|${Number.isFinite(at) ? at : t.closedAt}`;
    const g = groups.get(key) ?? { net: 0, notional: 0 };
    g.net += Number.isFinite(t.netPnl) ? t.netPnl : 0;
    if (t.entryPrice != null && t.volume != null && t.entryPrice > 0 && t.volume > 0) g.notional += t.entryPrice * t.volume;
    groups.set(key, g);
  }
  const eqFloor = Number.isFinite(equity) && equity > 0 ? 0.001 * equity : 0;
  let n = 0;
  for (const g of groups.values()) {
    const riskUsd = stopFrac != null && Number.isFinite(stopFrac) && stopFrac > 0 ? g.notional * stopFrac : 0;
    const scratch = Math.max(eqFloor, 0.25 * riskUsd);
    if (g.net < -scratch) n++;
  }
  return n;
}

/**
 * The revenge pause. True = refuse the entry. An explicit 0 blocks every entry (the same
 * "0 is a real zero" rule the daily loss cap follows); an unreadable limit blocks too.
 */
export function revengePauseHit(losers: number, maxLosses: number): boolean {
  if (!Number.isFinite(maxLosses) || maxLosses <= 0) return true;
  if (!Number.isFinite(losers)) return true;
  return losers >= maxLosses;
}

/**
 * Is the isolated liquidation distance (0.6/leverage) at least `mult` × the stop?
 * leverageThatFitsStop already guarantees this at every rung it returns; this is the check
 * that holds if leverage ever arrives from somewhere else. Compared with a relative
 * tolerance because the FAST container is an exact tie in floating point
 * (0.6/12 = 0.049999999999999996 against (1/0.6)×0.03 = 0.05).
 */
export function liqBufferOk(stopFrac: number, leverage: number, mult: number = LIQ_BUFFER_MULT): boolean {
  if (!Number.isFinite(stopFrac) || !(stopFrac > 0) || !Number.isFinite(leverage) || !(leverage >= 1) || !Number.isFinite(mult) || !(mult > 0)) return false;
  const liqDistance = LIQ_CUSHION / leverage;
  return liqDistance >= mult * stopFrac * (1 - 1e-9);
}

/** The liquidation distance as a multiple of the stop — for notes and the trade card. */
export function liqBufferMultiple(stopFrac: number, leverage: number): number {
  if (!(stopFrac > 0) || !(leverage >= 1)) return NaN;
  return LIQ_CUSHION / leverage / stopFrac;
}

/**
 * kraken_margin_decay_multiplier (written by the decay rule, C3). Missing/blank = 1. Strict:
 * anything unparseable or outside [0.25, 1] returns null and the caller REFUSES the entry.
 */
export const DECAY_MULT_MIN = 0.25;
export function parseDecayMultiplier(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return 1;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < DECAY_MULT_MIN || v > 1) return null;
  return v;
}

/** What the guardian writes to kraken_margin_risk_state each run (display only). `exposure` is
 *  A2's correlated-exposure summary (margin-exposure.ts), folded in by step 3 of the guardian. */
export interface RiskState { at: string; peak: number; equity: number; dd: number; tier: DdTier; mult: number; losersToday: number | null; tiersOn?: boolean; note?: string; exposure?: ExposureSummary & { at: string } }

// ---------- THE REFUSAL STRINGS, built in one place so the executor, the capacity ledger's
// classifier and the tests all read the same words. ----------
export const REFUSAL_RE = {
  ddUnknown: /^entry refused: drawdown tier unknown/,
  ddHalt: /^entry refused: drawdown [\d.]+% from peak .* halt/,
  revenge: /^entry refused: \d+ losing trades today — no revenge trades/,
  decay: /^entry refused: kraken_margin_decay_multiplier .* is outside 0\.25–1/,
  liqBuffer: /^entry refused: liquidation buffer [\d.]+× the stop is under/,
  chainZero: /^entry refused: risk chain sized to 0/,
  eventWindow: /^entry refused: event window — /,
  eventUnreadable: /^entry refused: could not read the event policy/,
  cluster: /^entry refused: all-stops risk \$[\d.]+ \+ \$[\d.]+ would exceed the cluster cap/,
  clusterCapInvalid: /^entry refused: kraken_margin_cluster_risk_cap_pct .* is not a number/,
  anomaly: /^entry refused: kraken_margin_anomaly is set — /,
  anomalyUnreadable: /^entry refused: could not read kraken_margin_anomaly/,
} as const;
export const refusalNote = {
  ddUnknown: (peakRaw: string | null, equity: number) => `entry refused: drawdown tier unknown — failing closed (kraken_margin_equity_peak=${peakRaw ?? "missing"}, equity $${equity.toFixed(0)})`,
  ddHalt: (dd: number, peak: number, haltPct: number) => `entry refused: drawdown ${dd.toFixed(1)}% from peak $${peak.toFixed(0)} is at/over the ${haltPct}% halt — the breaker owns this, not a new entry`,
  revenge: (losers: number, maxLosses: number) => `entry refused: ${losers} losing trades today — no revenge trades (max ${maxLosses})`,
  decay: (raw: string | null) => `entry refused: kraken_margin_decay_multiplier "${raw}" is outside 0.25–1 — failing closed`,
  liqBuffer: (stopFrac: number, leverage: number) => `entry refused: liquidation buffer ${liqBufferMultiple(stopFrac, leverage).toFixed(2)}× the stop is under ${LIQ_BUFFER_MULT.toFixed(2)}× (stop ${(stopFrac * 100).toFixed(2)}% at ${leverage}×) — the margin-level floor is disabled and nothing else holds this line`,
  chainZero: (ddMult: number, eventMult: number, decayMult: number) => `entry refused: risk chain sized to 0 (dd ×${ddMult}, event ×${eventMult}, decay ×${decayMult}) — failing closed`,
  eventWindow: (reason: string) => `entry refused: event window — ${reason}`,
  eventUnreadable: (err: string) => `entry refused: could not read the event policy (${err.slice(0, 60)}) — failing closed`,
  // `headroom` = { haltPct, dd } when the cap is the breaker's headroom (the default); null when the operator set kraken_margin_cluster_risk_cap_pct.
  cluster: (existingUsd: number, newUsd: number, capPct: number, equity: number, headroom: { haltPct: number; dd: number } | null = null) => `entry refused: all-stops risk $${existingUsd.toFixed(0)} + $${newUsd.toFixed(0)} would exceed the cluster cap ${capPct.toFixed(1)}% of equity ($${equity.toFixed(0)})${headroom ? ` (= ${headroom.haltPct.toFixed(0)}% breaker − ${Math.max(0, headroom.dd).toFixed(1)}% drawdown; the cap is breaker headroom, not a slot count)` : " (operator cap kraken_margin_cluster_risk_cap_pct)"} — every open stop hit at once must stay inside it`,
  clusterCapInvalid: (raw: string | null) => `entry refused: kraken_margin_cluster_risk_cap_pct "${raw}" is not a number — failing closed`,
  anomaly: (value: string) => `entry refused: kraken_margin_anomaly is set — ${value.split("\n")[0].slice(0, 160)}${value.includes("\n") ? " (+more)" : ""} — the live book does not match what was authorised; investigate on Kraken, then clear the key`,
  anomalyUnreadable: (err: string) => `entry refused: could not read kraken_margin_anomaly (${err.slice(0, 60)}) — failing closed`,
} as const;
