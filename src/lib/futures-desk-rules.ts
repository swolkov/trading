// FUTURES DESK — the pure half. No I/O, no imports from broker or DB modules.
//
// WHAT THIS DESK IS. A TradingView alert fires when one of the registered edge rules triggers on
// real-time CME data; the alert is POSTed to our webhook; this desk sizes the trade off a fixed
// $50k basis and places it on the Tradovate DEMO account with the protective stop attached in the
// same request. It is a paper edge lab: the demo account measures each rule with real broker fills
// and the same 30-trade / t ≥ 2 verdict the crypto and options books use. Nothing here can reach the
// live Tradovate account — every broker call in futures-desk.ts passes mode "paper" explicitly.
//
// WHY THE RULES LIVE ON TRADINGVIEW. Databento was cancelled (Aug 24 2026) and the old engine's
// price path was Databento-only, so the demo had no feed. TradingView supplies real-time CME data
// for ~$20/mo and evaluates the rule; the alert carries everything the desk needs (edge, root,
// side, price, stop). The desk therefore never needs a price feed of its own — the broker holds
// the stop, and the guardian marks positions from the broker's own fills and positions.

export type EdgeKey = "index_daily_mr" | "donchian_60m_long";
export type Side = "long" | "short";

export interface EdgeSpec {
  key: EdgeKey;
  name: string;
  timeframe: string;
  sides: Side[];
  /** Contract roots this rule may trade — the ROOT the chart alert reports (ES, not MES). */
  roots: string[];
  /** The evidence that put the rule on the desk. Shown on the page, verbatim. */
  evidence: string;
  /** Hard time stop in calendar days, enforced by the guardian (null = the rule's own exit only). */
  maxHoldDays: number | null;
  /** Does the rule send its own EXIT alerts (RSI≥50 / channel exit)? The guardian still enforces the stop and time stop. */
  ruleExits: boolean;
}

export const EDGES: readonly EdgeSpec[] = [
  {
    key: "index_daily_mr",
    name: "Index daily mean-reversion — LONG",
    timeframe: "1D",
    sides: ["long"],
    roots: ["ES", "NQ", "YM"],
    evidence:
      "Daily RSI(14) < 30 with close > 200-SMA × 0.92; exit RSI(14) ≥ 50, or 1.5×ATR(14) stop, or 30 days. "
      + "15-yr Databento: ES PF 3.14 · NQ 2.22 · YM 1.79; Yahoo 2000-2026: ES 2.47 · SPY 1.88 · QQQ 1.96 — positive in both halves and every 5-yr block "
      + "(scripts/daily-swing-validation.ts). The best-evidenced rule this repo owns. Gold FAILS with a stop; RTY fails.",
    maxHoldDays: 30,
    ruleExits: true,
  },
  {
    key: "donchian_60m_long",
    name: "60-minute Donchian 100/50 — LONG only",
    timeframe: "60",
    sides: ["long"],
    roots: ["ES", "NQ", "YM", "GC", "SI", "HG"],
    evidence:
      "Close above the prior 100-bar high on 60-minute bars → long at the next open; exit on a close below the prior 50-bar low; 4×ATR(20) stop. "
      + "10 markets 2011-2026: n=3,607, +0.101R/trade, PF 1.17, t=2.93, second half STRONGER than the first (scripts/trend-portfolio.ts). "
      + "Caveats stated as measured: it captured ~57% of buy-and-hold's return (risk-managed beta, not alpha); the SHORT side is significantly negative; "
      + "the 30-minute version ruins the account. CL and NG were net-negative and are excluded.",
    maxHoldDays: null,
    ruleExits: true,
  },
];

export function edgeByKey(key: string): EdgeSpec | null {
  return EDGES.find((e) => e.key === key) ?? null;
}

/** Root → the micro contract the desk actually trades, with its dollar value per 1.00 of price. */
export const MICRO_FOR_ROOT: Record<string, { micro: string; pointValue: number }> = {
  ES: { micro: "MES", pointValue: 5 },
  NQ: { micro: "MNQ", pointValue: 2 },
  YM: { micro: "MYM", pointValue: 0.5 },
  GC: { micro: "MGC", pointValue: 10 },
  SI: { micro: "SIL", pointValue: 1000 },
  HG: { micro: "MHG", pointValue: 2500 },
  RTY: { micro: "M2K", pointValue: 5 },
};

/** Modeled commission + exchange + clearing per contract per side on a micro. The demo reports none. */
export const FEE_PER_SIDE_MICRO = 0.85;
/** Per side on a MINI (stage D). ASSUMED at the micro figure — verify on the first mini fill. */
export const FEE_PER_SIDE_MINI = 0.85;
/** The fee model for a ledger row: a row whose symbol is the root's mini pays the mini fee. */
export function feePerSide(symbol: string, root: string): number {
  return MINI_FOR_ROOT[root]?.mini === symbol ? FEE_PER_SIDE_MINI : FEE_PER_SIDE_MICRO;
}

/** Modeled fee per side on a MINI too — no separate mini fee is invented; Stage D is documented as
 *  unreachable in practice (one ES mini at a $500 budget needs a ≤10-pt stop). */
export const MINI_FOR_ROOT: Record<string, { mini: string; pointValue: number }> = {
  ES: { mini: "ES", pointValue: 50 },
  NQ: { mini: "NQ", pointValue: 20 },
  YM: { mini: "YM", pointValue: 5 },
  GC: { mini: "GC", pointValue: 100 },
  SI: { mini: "SI", pointValue: 5000 },
  HG: { mini: "HG", pointValue: 25000 },
  RTY: { mini: "RTY", pointValue: 50 },
};

/** Correlated markets share one cap: the four index micros move together, so do the metals. */
export type Cluster = "index" | "metals";
export const CLUSTER_OF: Record<string, Cluster> = { ES: "index", NQ: "index", YM: "index", RTY: "index", GC: "metals", SI: "metals", HG: "metals" };
export function clusterOf(root: string): Cluster | null { return CLUSTER_OF[root] ?? null; }

/** "$1,000" / "$301.70" — every refusal string uses one formatter so the wording is stable. */
export function usd(n: number, decimals = 0): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

// ---- stages and grades ---------------------------------------------------------------------------
/** A: one micro until earned · B: two · C: five · D: one MINI (needs `futures_desk_stage_d_armed`). */
export type Stage = "A" | "B" | "C" | "D";
export const STAGES: readonly Stage[] = ["A", "B", "C", "D"];
export const STAGE_MAX_CONTRACTS: Record<Stage, number> = { A: 1, B: 2, C: 5, D: 1 };
export const STAGE_UNIT: Record<Stage, "micro" | "mini"> = { A: "micro", B: "micro", C: "micro", D: "mini" };
/** Normal 0.5% / Strong 0.75% / A+ 1.0% of the basis. Locked at Normal until the score is promoted. */
export type Grade = "normal" | "strong" | "aplus";

export interface DeskLimits {
  sizingBasisUsd: number;   // the "$50k account" — sizing is a % of THIS, not of the demo's drifting balance
  riskPct: number;          // % of basis risked per NORMAL trade (the ladder's floor)
  riskPctStrong: number;    // % for a Strong (score ≥ 80, promoted) signal
  riskPctAplus: number;     // % for an A+ (score ≥ 90, promoted) signal — also the per-cluster cap
  maxContracts: number;     // absolute ceiling per trade; the stage cap binds first
  maxPositions: number;     // one per root, at most this many
  maxEntriesPerDay: number;
  dailyLossPausePct: number; // pause new entries for the rest of the day once the day is down this % of basis
  maxOpenRiskPct: number;    // Σ open risk_usd + the new trade's budget may not exceed this % of basis
  drawdownDisablePct: number; // halt the desk (manual re-enable) once equity is down this % from the high
  stage: Stage;
}

export const DEFAULT_LIMITS: DeskLimits = {
  sizingBasisUsd: 50_000,
  riskPct: 0.5,
  riskPctStrong: 0.75,
  riskPctAplus: 1.0,
  maxContracts: 20,
  maxPositions: 6,
  maxEntriesPerDay: 4,
  dailyLossPausePct: 1.5,
  maxOpenRiskPct: 2,
  drawdownDisablePct: 10,
  stage: "A",
};

/** Overrides from AgentConfig, every one clamped so a bad key can only shrink risk: basis 1,000–50,000,
 *  each pct 0.25–1.0, an unreadable stage reads as "A". Pure so the clamps are tested. */
export function limitsFromConfig(v: { basis?: string | null; risk?: string | null; strong?: string | null; aplus?: string | null; stage?: string | null }): DeskLimits {
  const num = (x: string | null | undefined, fb: number) => { const n = x == null ? NaN : parseFloat(x); return Number.isFinite(n) ? n : fb; };
  const pct = (x: string | null | undefined, fb: number) => Math.min(1.0, Math.max(0.25, num(x, fb)));
  return {
    ...DEFAULT_LIMITS,
    sizingBasisUsd: Math.min(50_000, Math.max(1_000, num(v.basis, DEFAULT_LIMITS.sizingBasisUsd))),
    riskPct: pct(v.risk, DEFAULT_LIMITS.riskPct), riskPctStrong: pct(v.strong, DEFAULT_LIMITS.riskPctStrong), riskPctAplus: pct(v.aplus, DEFAULT_LIMITS.riskPctAplus),
    stage: STAGES.includes(v.stage as Stage) ? (v.stage as Stage) : "A",
  };
}

export function budgetFor(grade: Grade, limits: DeskLimits): number {
  const pct = grade === "aplus" ? limits.riskPctAplus : grade === "strong" ? limits.riskPctStrong : limits.riskPct;
  return limits.sizingBasisUsd * (pct / 100);
}

/** Normal unless the 0–100 score has been PROMOTED (it ranks at t ≥ 2 on this desk's own record);
 *  a score with no promotion is a stamp, never a size. */
export function gradeFor(a: AlertPayload, promotedScore: boolean): Grade {
  if (!promotedScore || a.score == null) return "normal";
  if (a.score >= 90) return "aplus";
  if (a.score >= 80) return "strong";
  return "normal";
}

// ---- alert payload -------------------------------------------------------------------------
export interface AlertPayload {
  edge: EdgeKey;
  root: string;
  /** `watch` (Pine v2): the rule is close to firing — logged and dry-run sized, never executed. */
  action: "entry" | "exit" | "watch";
  side: Side;
  price: number;
  stop: number | null;
  /** The chart bar the alert fired on (ISO). With edge+root+action it forms the dedupe key. */
  bar: string;
  timeframe: string;
  note: string;
  /** Optional 0–100 opportunity score from the chart (Pine v2). Absent on today's alerts. */
  score?: number;
  // ---- Pine v2 context, all optional — stamps for the journal, never gates. A v1 alert has none.
  atr?: number;
  rsi?: number;
  /** volume ÷ its 20-bar average on the alert bar. */
  volRatio?: number;
  /** close ÷ the prior 20-bar high − 1 (≤ 0 below the high). */
  dist20h?: number;
  /** Daily / 4-hour close above its 50-SMA. */
  d1Up?: boolean;
  h4Up?: boolean;
}

export type ParsedAlert = { ok: true; alert: AlertPayload } | { ok: false; reason: string };

function numberField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

/** Shape guard for the TradingView JSON. Never throws; a bad alert is a refusal with a reason. */
export function parseAlert(body: unknown): ParsedAlert {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "not an object" };
  const b = body as Record<string, unknown>;
  if (b.desk !== "futures") return { ok: false, reason: "desk is not 'futures'" };
  const edge = edgeByKey(String(b.edge ?? ""));
  if (!edge) return { ok: false, reason: `unknown edge '${String(b.edge ?? "")}' — only registered rules trade` };
  const root = String(b.symbol ?? b.root ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!edge.roots.includes(root)) return { ok: false, reason: `${edge.key} does not trade ${root || "(blank)"}` };
  const action = b.action === "exit" ? "exit" : b.action === "entry" ? "entry" : b.action === "watch" ? "watch" : null;
  if (!action) return { ok: false, reason: `action must be entry, exit or watch, got '${String(b.action ?? "")}'` };
  const side: Side | null = b.side === "long" ? "long" : b.side === "short" ? "short" : null;
  if (!side) return { ok: false, reason: `side must be long or short, got '${String(b.side ?? "")}'` };
  if (!edge.sides.includes(side)) return { ok: false, reason: `${edge.key} is ${edge.sides.join("/")}-only` };
  const price = numberField(b.price);
  if (price == null || price <= 0) return { ok: false, reason: "price missing" };
  const stop = numberField(b.stop);
  if (action === "entry" && (stop == null || stop <= 0)) return { ok: false, reason: "entry without a stop is refused — the stop travels with the order" };
  if (action !== "exit" && stop != null && stop > 0) {   // a watch may carry its projected stop; if it does, it is checked like an entry's
    if (side === "long" && stop >= price) return { ok: false, reason: `long stop ${stop} is not below price ${price}` };
    if (side === "short" && stop <= price) return { ok: false, reason: `short stop ${stop} is not above price ${price}` };
  }
  const barRaw = b.bar ?? b.time;
  let bar: string;
  if (typeof barRaw === "number" && Number.isFinite(barRaw)) bar = new Date(barRaw).toISOString();
  else if (typeof barRaw === "string" && !Number.isNaN(Date.parse(barRaw))) bar = new Date(Date.parse(barRaw)).toISOString();
  else if (typeof barRaw === "string" && /^\d{10,13}$/.test(barRaw)) bar = new Date(Number(barRaw.length === 10 ? Number(barRaw) * 1000 : barRaw)).toISOString();
  else return { ok: false, reason: "bar time missing — TradingView must send {{time}}" };
  const timeframe = String(b.timeframe ?? b.tf ?? edge.timeframe);
  const note = typeof b.note === "string" ? b.note.slice(0, 200) : "";
  const score = numberField(b.score);
  const opt: Partial<AlertPayload> = {};
  if (score != null) opt.score = score;
  for (const k of ["atr", "rsi", "volRatio", "dist20h"] as const) { const v = numberField(b[k]); if (v != null) opt[k] = v; }
  for (const k of ["d1Up", "h4Up"] as const) { const v = boolField(b[k]); if (v != null) opt[k] = v; }
  return { ok: true, alert: { edge: edge.key, root, action, side, price, stop: stop && stop > 0 ? stop : null, bar, timeframe, note, ...opt } };
}
/** Pine writes booleans as `true`/`false`; a template may quote them or send 1/0. Anything else is absent. */
function boolField(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}

/** Identical alert (same rule, market, action, bar) = the same event; TradingView retries on timeout. */
export function dedupeKey(a: AlertPayload): string {
  return `${a.edge}|${a.root}|${a.action}|${a.side}|${a.bar}`;
}

// ---- sizing ------------------------------------------------------------------------------
export interface SizeResult {
  ok: boolean;
  reason: string;
  /** The contract symbol traded (a micro at stages A–C, the mini at stage D) — field name kept for the ledger. */
  micro: string;
  contracts: number;
  stopPoints: number;
  riskPerContractUsd: number;
  riskUsd: number;
  riskBudgetUsd: number;
  grade: Grade;
  stage: Stage;
  unit: "micro" | "mini";
  budgetMult: number;
  /** Dollar value per 1.00 of price for the contract actually sized (mini at stage D) — written to the ledger's point_value. */
  pointValue: number;
}

export interface SizeOpts { grade: Grade; stage: Stage; budgetMult: number; stageDArmed?: boolean }

/** Contracts = min(floor(budget / risk per contract), stage cap, maxContracts). Below one contract
 *  the trade is refused, never stretched: a rule whose stop costs more than the budget on one
 *  contract is a rule this basis cannot trade at this risk, and saying so is the honest outcome.
 *  `budgetMult` is the drawdown tier's multiplier (1 / 0.75 / 0.5 / 0.25). */
export function sizeEntry(a: AlertPayload, limits: DeskLimits, opts: SizeOpts): SizeResult {
  const { grade, stage, budgetMult } = opts;
  const unit = STAGE_UNIT[stage];
  const spec = unit === "mini" ? MINI_FOR_ROOT[a.root] : MICRO_FOR_ROOT[a.root];
  const symbol = spec ? ("micro" in spec ? spec.micro : spec.mini) : "";
  const budget = budgetFor(grade, limits) * budgetMult;
  const base = { micro: symbol, contracts: 0, stopPoints: 0, riskPerContractUsd: 0, riskUsd: 0, riskBudgetUsd: budget, grade, stage, unit, budgetMult, pointValue: spec?.pointValue ?? 0 };
  if (stage === "D" && !opts.stageDArmed) return { ...base, ok: false, reason: "stage D (minis) is not armed — refused" };
  if (!spec) return { ...base, ok: false, reason: `no ${unit} contract mapped for ${a.root}` };
  const stopPoints = Math.abs(a.price - (a.stop ?? a.price));
  if (!(stopPoints > 0)) return { ...base, ok: false, reason: "zero-width stop", stopPoints };
  const perContract = stopPoints * spec.pointValue + 2 * (unit === "mini" ? FEE_PER_SIDE_MINI : FEE_PER_SIDE_MICRO);
  const raw = Math.floor(budget / perContract);
  const cap = Math.min(STAGE_MAX_CONTRACTS[stage], limits.maxContracts);
  const contracts = Math.min(raw, cap);
  if (contracts < 1) return { ...base, ok: false, reason: `one ${symbol} risks ${usd(perContract, 2)} against a ${usd(budget, Number.isInteger(budget) ? 0 : 2)} budget (${grade} · stage ${stage}) — refused, never stretched`, stopPoints, riskPerContractUsd: perContract };
  return { ...base, ok: true, reason: raw > cap ? `capped at ${cap} contracts (stage ${stage})` : "", contracts, stopPoints, riskPerContractUsd: perContract, riskUsd: contracts * perContract };
}

// ---- stage readiness -----------------------------------------------------------------------------
export interface ReadinessRow { status: string; pnl_usd: number | null; stage?: string | null }
export interface Readiness { ok: boolean; reasons: string[]; resolved: number; net: number; profitFactor: number; maxDrawdownUsd: number }

/** Gross wins ÷ gross losses; Infinity when nothing was lost (and something was won). */
export function profitFactor(pnls: number[]): number {
  const wins = pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0);
  const losses = pnls.filter((p) => p < 0).reduce((s, p) => s - p, 0);
  if (losses === 0) return wins > 0 ? Infinity : 0;
  return wins / losses;
}

/** Largest peak-to-trough dip of the cumulative P&L, in resolve order. */
export function maxDrawdown(pnls: number[]): number {
  let cum = 0, peak = 0, dd = 0;
  for (const p of pnls) { cum += p; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return dd;
}

/** The next stage is EARNED: ≥ 30 resolved at this stage, net > 0, PF ≥ 1.2, max drawdown ≤ 3% of
 *  basis. Every failing reason is reported, not just the first. Rows arrive already merged by roll chain. */
export function stageReadiness(rows: ReadinessRow[], stage: Stage, limits: DeskLimits): Readiness {
  // A row stamped with another stage (or a legacy null — sized before the ladder) does not count toward this one.
  const pnls = rows.filter((r) => r.status === "closed" && r.pnl_usd != null && (r.stage === undefined || r.stage === stage)).map((r) => r.pnl_usd as number);
  const resolved = pnls.length;
  const net = pnls.reduce((s, p) => s + p, 0);
  const pf = profitFactor(pnls);
  const dd = maxDrawdown(pnls);
  const ddCap = limits.sizingBasisUsd * 0.03;
  const reasons: string[] = [];
  if (resolved < 30) reasons.push(`only ${resolved} of 30 resolved at stage ${stage}`);
  if (!(net > 0)) reasons.push(`net is ${net < 0 ? "−" : ""}${usd(net)} — must be positive`);
  if (!(pf >= 1.2)) reasons.push(`profit factor ${Number.isFinite(pf) ? pf.toFixed(2) : "∞"} is below 1.2`);
  if (dd > ddCap) reasons.push(`max drawdown ${usd(dd)} exceeds 3% of basis (${usd(ddCap)})`);
  return { ok: reasons.length === 0, reasons, resolved, net, profitFactor: pf, maxDrawdownUsd: dd };
}

/** Round to the contract's tick so the broker cannot reject the stop as "Illegal Price". */
export function roundToTick(px: number, tick: number): number {
  if (!(tick > 0)) return px;
  const decimals = Math.max(0, Math.min(10, Math.ceil(-Math.log10(tick)) + 1));
  return Number((Math.round(px / tick) * tick).toFixed(decimals));
}

// ---- refusals (the container) -----------------------------------------------------------------
export interface DeskContext {
  enabled: boolean;
  openRoots: string[];
  entriesToday: number;
  dayPnlUsd: number;
  equityUsd: number;
  equityHighUsd: number;
  guardianFreshMs: number | null;
  /** Σ risk_usd of the open ledger (a rolled leg is closed, its successor open — no double count). */
  openRiskUsd: number;
  /** Σ risk_usd of open positions in the alert's cluster on the alert's side. */
  sameClusterSameSideRiskUsd: number;
  /** basis × dailyLossPausePct + (balance − day-start balance) − open risk; negative = spent. */
  dailyLossRemainingUsd: number;
  /** The drawdown tier's budget multiplier (1 / 0.75 / 0.5 / 0.25 / 0). */
  ddMult: number;
  /** The budget this entry would risk — the worst case, before sizing rounds down. */
  newRiskUsd: number;
  // ---- the calendar (E3): what the guardian last wrote to `futures_desk_event_policy`, read back.
  /** normal / reduced / paused; null when the key is missing or unreadable (a refusal, never "normal"). */
  eventMode: "normal" | "reduced" | "paused" | null;
  /** Age of the policy row; null when missing. Older than 20 minutes refuses. */
  eventPolicyAgeMs: number | null;
  /** `FOMC rate decision 14:00 ET — paused until 14:30` while paused. */
  eventWindow: string | null;
  /** The composed budget multiplier the entry is sized at: drawdown tier × event (0.5 when reduced). */
  budgetMult: number;
  /** A CME holiday closing entries right now (closed day, or after an early close) — null on a normal day. */
  cmeHoliday: string | null;
}

/** The guardian writes the event policy every run (5 min); an entry needs one younger than this. */
export const EVENT_POLICY_FRESH_MS = 20 * 60_000;

/** `−$620` / `+$30` — the Unicode minus the desk's Slack lines already use. */
function signedUsd(n: number): string { return `${n < 0 ? "−" : "+"}${usd(n)}`; }

export function entryRefusal(a: AlertPayload, ctx: DeskContext, limits: DeskLimits): string | null {
  if (!ctx.enabled) return "desk is disabled";
  if (ctx.guardianFreshMs == null || ctx.guardianFreshMs > 20 * 60_000) return "guardian has not run in the last 20 minutes";
  if (ctx.eventPolicyAgeMs == null || ctx.eventPolicyAgeMs > EVENT_POLICY_FRESH_MS) return "event calendar not checked in the last 20 minutes";
  if (ctx.eventMode === "paused") return `event window: ${ctx.eventWindow ?? "tier-1 print within 30 minutes"}`;
  if (ctx.cmeHoliday) return ctx.cmeHoliday;
  if (ctx.openRoots.includes(a.root)) return `already holding ${a.root}`;
  if (ctx.openRoots.length >= limits.maxPositions) return `${limits.maxPositions} positions already open`;
  if (ctx.entriesToday >= limits.maxEntriesPerDay) return `${limits.maxEntriesPerDay} entries already today`;
  if (ctx.dayPnlUsd <= -limits.sizingBasisUsd * (limits.dailyLossPausePct / 100)) return `day is down $${Math.abs(ctx.dayPnlUsd).toFixed(0)} — paused until tomorrow`;
  if (ctx.equityHighUsd > 0 && ctx.equityUsd <= ctx.equityHighUsd * (1 - limits.drawdownDisablePct / 100)) return `equity is ${limits.drawdownDisablePct}% off its high — desk halted pending review`;
  // The 2% cap is a ceiling the book stays UNDER: $750 open + a $250 entry = $1,000 is refused (three $250 positions at stage A).
  const cap = limits.sizingBasisUsd * (limits.maxOpenRiskPct / 100);
  if (ctx.openRiskUsd + ctx.newRiskUsd >= cap) return `open risk ${usd(ctx.openRiskUsd)} + ${usd(ctx.newRiskUsd)} would use up the ${limits.maxOpenRiskPct}% cap (${usd(cap)})`;
  const cluster = clusterOf(a.root);
  const clusterCap = budgetFor("aplus", limits);
  if (cluster && ctx.sameClusterSameSideRiskUsd + ctx.newRiskUsd > clusterCap) return `${cluster} ${a.side}s already risk ${usd(ctx.sameClusterSameSideRiskUsd)} — adding ${usd(ctx.newRiskUsd)} exceeds the ${usd(clusterCap)} cluster cap`;
  const dailyCap = limits.sizingBasisUsd * (limits.dailyLossPausePct / 100);
  if (ctx.dailyLossRemainingUsd < ctx.newRiskUsd) {
    const realized = ctx.dailyLossRemainingUsd + ctx.openRiskUsd - dailyCap;   // remaining = cap + realized − openRisk
    return `daily loss limit reached: ${signedUsd(realized)} realized and ${usd(ctx.openRiskUsd)} open risk against ${usd(dailyCap)}`;
  }
  return null;
}

// ---- CME hours ---------------------------------------------------------------------------------
/** CME Globex equity/metals: open Sun 18:00 ET → Fri 17:00 ET with a daily 17:00–18:00 ET break.
 *  A market order during the break is rejected or sits until the reopen at whatever price, so the
 *  desk QUEUES alerts that land there and the guardian sends them at the reopen. */
export function cmeOpen(now: Date): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0 Sun … 6 Sat
  const mins = et.getHours() * 60 + et.getMinutes();
  if (day === 6) return false;
  if (day === 0) return mins >= 18 * 60;
  if (day === 5) return mins < 17 * 60;
  return mins < 17 * 60 || mins >= 18 * 60;
}

/** Day key in ET — the desk's "today" for entry counts and the daily loss pause. */
export function etDayKey(now: Date): string {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}

// ---- rolls -------------------------------------------------------------------------------------
/** The guardian's roll trigger, extracted so it can be pinned: roll once the expiry (first notice
 *  for metals) is closer than (guardDays − 1) days. Unknown expiry never rolls. */
export function rollDue(expiryIso: string | null, nowMs: number, guardDays: number): boolean {
  if (!expiryIso) return false;
  const exp = Date.parse(expiryIso);
  if (!Number.isFinite(exp)) return false;
  return exp - nowMs < (guardDays - 1) * 86_400_000;
}

export interface RollPlan { id: number; contract: string; micro: string; expiry: string; rollOn: string; daysUntilRoll: number; daysToExpiry: number }

/** Positions whose month expires within 5 days: when each rolls (≈ expiry − (guardDays − 1) days).
 *  `expiries` is keyed by trade id; a missing/unparseable expiry is skipped (nothing to plan).
 *  `daysUntilRoll` may be negative — the roll is overdue (CME was closed when it came due). */
export function rollPreview<T extends { id: number; contract: string; micro: string }>(
  open: T[], expiries: Record<number, string | null | undefined>, now: Date, guardDaysOf: (micro: string) => number,
): RollPlan[] {
  const out: RollPlan[] = [];
  for (const t of open) {
    const iso = expiries[t.id];
    const exp = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(exp)) continue;
    const daysToExpiry = (exp - now.getTime()) / 86_400_000;
    if (daysToExpiry > 5) continue;
    const rollOnMs = exp - (guardDaysOf(t.micro) - 1) * 86_400_000;
    out.push({ id: t.id, contract: t.contract, micro: t.micro, expiry: new Date(exp).toISOString(), rollOn: new Date(rollOnMs).toISOString(), daysUntilRoll: (rollOnMs - now.getTime()) / 86_400_000, daysToExpiry });
  }
  return out;
}

/** "Sep 16" in ET — for roll-plan notes and the day-before Slack. */
export function etShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

// ---- P&L and the verdict -----------------------------------------------------------------------
export function tradePnlUsd(side: Side, entry: number, exit: number, qty: number, pointValue: number, feePerSideUsd = FEE_PER_SIDE_MICRO): number {
  const pts = side === "long" ? exit - entry : entry - exit;
  return pts * pointValue * qty - 2 * qty * feePerSideUsd;
}

export function tStatOf(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  return mean / (sd / Math.sqrt(n));
}

/** Same wording and thresholds as the crypto and options books, so "REAL EDGE" means one thing. */
export function deskVerdict(resolved: number, net: number, tStat: number | null, days: number): string {
  if (resolved === 0) return "NO DATA — waiting for the first resolved trade";
  if (resolved < 30) return `TOO EARLY — ${resolved} of 30 resolved`;
  if (days < 7) return "TOO EARLY — fewer than 7 days of trades";
  if (net <= 0) return "NO EDGE — net negative after fees";
  if (tStat != null && tStat >= 2) return "REAL EDGE — significant";
  if (tStat != null && tStat >= 1) return "PROMISING — not yet significant";
  return "NOISE — positive but not distinguishable from zero";
}
