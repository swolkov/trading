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

export interface DeskLimits {
  sizingBasisUsd: number;   // the "$50k account" — sizing is a % of THIS, not of the demo's drifting balance
  riskPct: number;          // % of basis risked per trade (house level 3)
  maxContracts: number;     // hard cap per trade
  maxPositions: number;     // one per root, at most this many
  maxEntriesPerDay: number;
  dailyLossPausePct: number; // pause new entries for the rest of the day once the day is down this % of basis
  drawdownDisablePct: number; // disable the desk (manual re-enable) once equity is down this % from the high
}

export const DEFAULT_LIMITS: DeskLimits = {
  sizingBasisUsd: 50_000,
  riskPct: 3,
  maxContracts: 20,
  maxPositions: 6,
  maxEntriesPerDay: 4,
  dailyLossPausePct: 6,
  drawdownDisablePct: 20,
};

// ---- alert payload -------------------------------------------------------------------------
export interface AlertPayload {
  edge: EdgeKey;
  root: string;
  action: "entry" | "exit";
  side: Side;
  price: number;
  stop: number | null;
  /** The chart bar the alert fired on (ISO). With edge+root+action it forms the dedupe key. */
  bar: string;
  timeframe: string;
  note: string;
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
  const action = b.action === "exit" ? "exit" : b.action === "entry" ? "entry" : null;
  if (!action) return { ok: false, reason: `action must be entry or exit, got '${String(b.action ?? "")}'` };
  const side: Side | null = b.side === "long" ? "long" : b.side === "short" ? "short" : null;
  if (!side) return { ok: false, reason: `side must be long or short, got '${String(b.side ?? "")}'` };
  if (!edge.sides.includes(side)) return { ok: false, reason: `${edge.key} is ${edge.sides.join("/")}-only` };
  const price = numberField(b.price);
  if (price == null || price <= 0) return { ok: false, reason: "price missing" };
  const stop = numberField(b.stop);
  if (action === "entry") {
    if (stop == null || stop <= 0) return { ok: false, reason: "entry without a stop is refused — the stop travels with the order" };
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
  return { ok: true, alert: { edge: edge.key, root, action, side, price, stop: action === "entry" ? stop : stop && stop > 0 ? stop : null, bar, timeframe, note } };
}

/** Identical alert (same rule, market, action, bar) = the same event; TradingView retries on timeout. */
export function dedupeKey(a: AlertPayload): string {
  return `${a.edge}|${a.root}|${a.action}|${a.side}|${a.bar}`;
}

// ---- sizing ------------------------------------------------------------------------------
export interface SizeResult {
  ok: boolean;
  reason: string;
  micro: string;
  contracts: number;
  stopPoints: number;
  riskPerContractUsd: number;
  riskUsd: number;
  riskBudgetUsd: number;
}

/** Contracts = floor(budget / risk per micro). Below one contract the trade is refused, never
 *  stretched: a rule whose stop costs more than the budget on one micro is a rule this basis cannot
 *  trade at this risk, and saying so is the honest outcome. */
export function sizeEntry(a: AlertPayload, limits: DeskLimits): SizeResult {
  const spec = MICRO_FOR_ROOT[a.root];
  const budget = limits.sizingBasisUsd * (limits.riskPct / 100);
  if (!spec) return { ok: false, reason: `no micro contract mapped for ${a.root}`, micro: "", contracts: 0, stopPoints: 0, riskPerContractUsd: 0, riskUsd: 0, riskBudgetUsd: budget };
  const stopPoints = Math.abs(a.price - (a.stop ?? a.price));
  if (!(stopPoints > 0)) return { ok: false, reason: "zero-width stop", micro: spec.micro, contracts: 0, stopPoints, riskPerContractUsd: 0, riskUsd: 0, riskBudgetUsd: budget };
  const perContract = stopPoints * spec.pointValue + 2 * FEE_PER_SIDE_MICRO;
  const raw = Math.floor(budget / perContract);
  const contracts = Math.min(raw, limits.maxContracts);
  if (contracts < 1) return { ok: false, reason: `one ${spec.micro} risks $${perContract.toFixed(0)} against a $${budget.toFixed(0)} budget`, micro: spec.micro, contracts: 0, stopPoints, riskPerContractUsd: perContract, riskUsd: 0, riskBudgetUsd: budget };
  return { ok: true, reason: raw > limits.maxContracts ? `capped at ${limits.maxContracts} contracts` : "", micro: spec.micro, contracts, stopPoints, riskPerContractUsd: perContract, riskUsd: contracts * perContract, riskBudgetUsd: budget };
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
}

export function entryRefusal(a: AlertPayload, ctx: DeskContext, limits: DeskLimits): string | null {
  if (!ctx.enabled) return "desk is disabled";
  if (ctx.guardianFreshMs == null || ctx.guardianFreshMs > 20 * 60_000) return "guardian has not run in the last 20 minutes";
  if (ctx.openRoots.includes(a.root)) return `already holding ${a.root}`;
  if (ctx.openRoots.length >= limits.maxPositions) return `${limits.maxPositions} positions already open`;
  if (ctx.entriesToday >= limits.maxEntriesPerDay) return `${limits.maxEntriesPerDay} entries already today`;
  if (ctx.dayPnlUsd <= -limits.sizingBasisUsd * (limits.dailyLossPausePct / 100)) return `day is down $${Math.abs(ctx.dayPnlUsd).toFixed(0)} — paused until tomorrow`;
  if (ctx.equityHighUsd > 0 && ctx.equityUsd <= ctx.equityHighUsd * (1 - limits.drawdownDisablePct / 100)) return `equity is ${limits.drawdownDisablePct}% off its high — desk disabled pending review`;
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

// ---- P&L and the verdict -----------------------------------------------------------------------
export function tradePnlUsd(side: Side, entry: number, exit: number, qty: number, pointValue: number): number {
  const pts = side === "long" ? exit - entry : entry - exit;
  return pts * pointValue * qty - 2 * qty * FEE_PER_SIDE_MICRO;
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
