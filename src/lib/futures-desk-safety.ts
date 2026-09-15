// FUTURES DESK — kill switches, platform safety, the feed heartbeat and the enforced pre-trade
// checklist (E5). Pure: the guardian and the entry path feed it rows, keys and clocks; it returns
// strings and booleans. Fail closed on ENTRIES only — nothing here is consulted by a close, a roll
// or a re-protect.
import {
  MICRO_FOR_ROOT, MINI_FOR_ROOT, STAGE_MAX_CONTRACTS, cmeOpen, edgeByKey, etDayKey, rollDue, usd,
  type AlertPayload, type DeskLimits, type SizeResult,
} from "@/lib/futures-desk-rules";

// ---- (a) execution errors ------------------------------------------------------------------------
export const EXECUTION_ERRORS_DISABLE_AT = 3;
export const EXECUTION_ERRORS_REASON = "3 execution errors today";
export interface ErrorEvent { at: string; errorClass: string | null }

/** Errors stamped today (ET): signal rows that ended in `error` plus ledger rows classed
 *  unprotected / roll_failed / close_refused. Three in a day disables the desk for a person to look. */
export function executionErrorsToday(rows: ErrorEvent[], dayKey: string): number {
  return rows.filter((r) => r.errorClass != null && Number.isFinite(Date.parse(r.at)) && etDayKey(new Date(r.at)) === dayKey).length;
}

// ---- (b)(c) anomalies ----------------------------------------------------------------------------
export type AnomalyKind = "foreign_position" | "ledger_mismatch" | "equity_jump";
export interface Anomaly { kind: AnomalyKind; detail: string; at: string }
export interface BrokerPosition { contractId: number; netPos: number }
export interface LedgerPosition { contract_id: number; contract: string; side: "long" | "short"; qty: number }

export const EQUITY_JUMP_PCT = 30;
/** A >30% move in equity between two guardian runs with NO fills in between is not trading — it is a
 *  reset, a deposit, a wrong account or a broken read. Entries pause until a person clears it. */
export function equityJump(prev: number | undefined, now: number, fillsSince: number): boolean {
  if (prev == null || !(prev > 0) || !Number.isFinite(now) || fillsSince > 0) return false;
  return Math.abs(now - prev) / prev > EQUITY_JUMP_PCT / 100;
}

/** The first anomaly found, in severity order: a contract the desk did not open, a broker position
 *  that disagrees with its ledger row (qty or side), an equity jump with no fills. Null = clean. */
export function detectAnomaly(i: { positions: BrokerPosition[]; open: LedgerPosition[]; prevEquity?: number; equity: number; fillsSince: number; now: Date }): Anomaly | null {
  const at = i.now.toISOString();
  for (const p of i.positions) if (!i.open.some((t) => t.contract_id === p.contractId)) return { kind: "foreign_position", detail: `foreign position #${p.contractId}`, at };
  for (const t of i.open) {
    const p = i.positions.find((x) => x.contractId === t.contract_id);
    if (!p) continue;   // flat at the broker: the guardian settles it, not an anomaly
    const side = p.netPos > 0 ? "long" : "short";
    if (Math.abs(p.netPos) !== t.qty || side !== t.side) return { kind: "ledger_mismatch", detail: `ledger mismatch on ${t.contract}: broker ${side} ${Math.abs(p.netPos)}, ledger ${t.side} ${t.qty}`, at };
  }
  if (equityJump(i.prevEquity, i.equity, i.fillsSince)) {
    const pct = Math.round(Math.abs(i.equity - (i.prevEquity as number)) * 100 / (i.prevEquity as number));
    return { kind: "equity_jump", detail: `equity jumped ${pct}% (${usd(i.prevEquity as number)} → ${usd(i.equity)}) with no fills`, at };
  }
  return null;
}

/** Tolerant reader of `futures_desk_anomaly`: an empty key is "clear"; junk reads as clear too, because
 *  the guardian rewrites the key on its next run if the condition still holds. */
export function parseAnomaly(raw: string | null | undefined): Anomaly | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || typeof v.kind !== "string" || typeof v.detail !== "string" || typeof v.at !== "string") return null;
    return { kind: v.kind as AnomalyKind, detail: v.detail, at: v.at };
  } catch { return null; }
}
/** The entry refusal while an anomaly is open. Closes, rolls and re-protection never read this. */
export function anomalyRefusal(raw: string | null | undefined): string | null {
  const a = parseAnomaly(raw);
  return a ? `anomaly open: ${a.detail} — entries paused until cleared` : null;
}

// ---- (d) feed heartbeat ---------------------------------------------------------------------------
export const FEED_STALE_AFTER_OPEN_MINUTES = 180;
const STEP_MS = 5 * 60_000;
const LOOKBACK_CAP_MS = 30 * 86_400_000;

/** CME-open minutes between two instants, stepping five minutes (the break and the weekend count for
 *  nothing). The start is capped 30 days back — anything older is stale many times over. */
export function cmeOpenMinutesBetween(aMs: number, bMs: number): number {
  if (!(bMs > aMs)) return 0;
  let mins = 0;
  for (let t = Math.max(aMs, bMs - LOOKBACK_CAP_MS); t < bMs; t += STEP_MS) if (cmeOpen(new Date(t))) mins += 5;
  return mins;
}
/** The heartbeat chart (ES1! 60m) posts every confirmed bar; more than 180 CME-open minutes of silence
 *  means TradingView, the alert or the webhook is down. Never seen = stale. Entries are NOT refused for
 *  this — an alert that arrives is itself proof of the feed — it is a health chip, a Slack and a
 *  checklist warning. */
export function feedStale(seenAtIso: string | null | undefined, nowMs: number): boolean {
  const seen = seenAtIso ? Date.parse(seenAtIso) : NaN;
  if (!Number.isFinite(seen)) return true;
  return cmeOpenMinutesBetween(seen, nowMs) > FEED_STALE_AFTER_OPEN_MINUTES;
}

// ---- (e) the pre-trade checklist -------------------------------------------------------------------
export const DEMO_HOST = "demo.tradovateapi.com";
/** The host `tradovate.ts` resolves for a mode (`getBaseUrl`: live → live.tradovateapi.com, anything else → demo). */
export function hostForMode(mode: string): string { return mode === "live" ? "live.tradovateapi.com" : DEMO_HOST; }
export const EVENT_POLICY_FRESH_MS = 20 * 60_000;

export interface ChecklistContext {
  /** The broker host the desk's client will hit — asserted, not assumed. */
  brokerHost: string;
  /** The desk's own front-month pick for this micro (`deskContract`) — the contract must be it. */
  frontMonth: string | null;
  /** Expiry (first notice for metals) of the contract about to trade, and the roll guard for it. */
  expiryIso: string | null;
  guardDays: number;
  openRoots: string[];
  /** `futures_desk_event_policy` raw. MISSING = warning until E3 writes it; present and stale = failure. */
  eventPolicyRaw: string | null;
  feedSeenAt: string | null;
  now: Date;
}
export interface Checklist { ok: boolean; failures: string[]; warnings: string[] }

function eventPolicyAge(raw: string | null, nowMs: number): number | null {
  try { const v = JSON.parse(raw ?? "null") as { at?: unknown }; const at = typeof v?.at === "string" ? Date.parse(v.at) : NaN; return Number.isFinite(at) ? nowMs - at : null; } catch { return null; }
}

/** Every failure is listed; the entry path refuses on the FIRST and stores the whole thing as
 *  `checklist_json` on the signal row. Order = severity: wrong account, wrong rule, wrong month, roll
 *  window, wrong symbol, stage cap, stop, budget, duplicate root, event calendar. */
export function preTradeChecklist(a: AlertPayload, ctx: ChecklistContext, contract: { name: string }, size: SizeResult, limits: DeskLimits): Checklist {
  const failures: string[] = [], warnings: string[] = [];
  if (ctx.brokerHost !== DEMO_HOST) failures.push(`account is not the demo (host must be ${DEMO_HOST})`);
  const edge = edgeByKey(a.edge);
  if (!edge || !edge.roots.includes(a.root)) failures.push(`${a.root} is not a root of ${a.edge}`);
  if (ctx.frontMonth && contract.name !== ctx.frontMonth) failures.push(`contract ${contract.name} is not the desk's front month (${ctx.frontMonth})`);
  if (rollDue(ctx.expiryIso, ctx.now.getTime(), ctx.guardDays)) {
    const days = Math.max(0, Math.round((Date.parse(ctx.expiryIso as string) - ctx.now.getTime()) / 86_400_000));
    failures.push(`${contract.name} is inside its roll window (expires in ${days} day${days === 1 ? "" : "s"})`);
  }
  const expected = size.unit === "mini" ? MINI_FOR_ROOT[a.root]?.mini : MICRO_FOR_ROOT[a.root]?.micro;
  if (!expected || size.micro !== expected || !contract.name.startsWith(expected)) failures.push(`${size.unit} symbol ${size.micro || "(none)"} does not match ${size.unit === "mini" ? "MINI_FOR_ROOT" : "MICRO_FOR_ROOT"}`);
  const cap = Math.min(STAGE_MAX_CONTRACTS[limits.stage], limits.maxContracts);
  if (size.contracts > cap) failures.push(`qty ${size.contracts} exceeds the stage ${limits.stage} cap of ${cap}`);
  const stopOk = a.stop != null && a.stop > 0 && (a.side === "long" ? a.stop < a.price : a.stop > a.price);
  if (!stopOk) failures.push("stop missing or on the wrong side of price");
  if (size.riskUsd > size.riskBudgetUsd + 1e-9) failures.push(`risk ${usd(size.riskUsd, 2)} exceeds the ${usd(size.riskBudgetUsd, Number.isInteger(size.riskBudgetUsd) ? 0 : 2)} budget`);
  if (ctx.openRoots.includes(a.root)) failures.push(`already holding ${a.root}`);
  // E3 writes `futures_desk_event_policy` every guardian run. Until it lands the key does not exist, so a
  // MISSING key is a warning; once E3 is merged, change the `else` below to push the same string as a failure.
  const age = eventPolicyAge(ctx.eventPolicyRaw, ctx.now.getTime());
  if (ctx.eventPolicyRaw && (age == null || age > EVENT_POLICY_FRESH_MS)) failures.push("event calendar not checked in the last 20 minutes");
  else if (!ctx.eventPolicyRaw) warnings.push("event calendar not checked in the last 20 minutes (no policy key yet — E3)");
  if (feedStale(ctx.feedSeenAt, ctx.now.getTime())) warnings.push(`feed heartbeat stale (last seen ${ctx.feedSeenAt ?? "never"}) — this alert is itself proof of the feed`);
  return { ok: failures.length === 0, failures, warnings };
}
