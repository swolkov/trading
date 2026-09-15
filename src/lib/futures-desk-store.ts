// FUTURES DESK — the store: AgentConfig keys, the one JSON state row, the two raw-SQL tables, the
// inbox and ledger reads/writes, and the compare-and-set locks. Extracted from futures-desk.ts
// (E4) so that file keeps to the execution paths. Same isolation rules: raw-SQL tables that a
// schema push cannot drop, `futures_desk_` keys, no import from any margin/kraken/options module.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { dedupeKey, etDayKey, limitsFromConfig, type AlertPayload, type DeskLimits, type Side } from "@/lib/futures-desk-rules";
import { sessionOf } from "@/lib/futures-desk-journal";

export const STATE_KEY = "futures_desk_state";
export const ENTRY_LOCK_KEY = "futures_desk_entry_lock";
export const GUARD_LOCK_KEY = "futures_desk_guard_lock";
export const ENTRY_LOCK_TTL_MS = 120_000;
export const GUARD_LOCK_TTL_MS = 290_000;   // just under the cron route's maxDuration
export const LANE = "futures_demo" as const;

export interface DeskState {
  guardianAt?: string;
  equity?: number;
  equityHigh?: number;
  dayKey?: string;
  dayStartEquity?: number;
  /** Cash balance (realized) and its value at the ET day start — the daily loss budget counts realized + open risk. */
  balance?: number;
  dayStartBalance?: number;
  alerts: Record<string, string>;
  lastError?: string;
  disabledReason?: string;
  /** ET day key of the last MFE/MAE fold (runs once a day after 17:05 ET). */
  excursionDayKey?: string;
}

export interface TradeRow {
  id: number; opened_at: string; edge: string; root: string; micro: string; contract: string; contract_id: number;
  side: Side; qty: number; entry_price: number; stop_price: number; entry_order_id: number | null; stop_order_id: number | null;
  cl_ord_id: string; signal_id: number | null; status: "open" | "closed" | "unknown"; exit_price: number | null;
  exit_order_id: number | null; closed_at: string | null; exit_reason: string | null; pnl_usd: number | null;
  fees_usd: number | null; risk_usd: number; point_value: number; rolled_from: number | null; note: string | null;
  /** Month code of the contract this leg trades (`U6`, `Z6`) — a roll chain reads as one trade across two months. */
  contract_month: string | null;
  /** The sizing stage (A–D) the trade was opened at; readiness for the next stage counts only its own rows. */
  stage: string | null;
  // ---- journal completeness (E4): all nullable, null on rows written before the columns existed.
  signal_price: number | null; entry_slip_pts: number | null; stop_points: number | null; atr_at_entry: number | null;
  session: string | null; regime: string | null; event_mode: string | null; grade: string | null;
  mfe_pts: number | null; mae_pts: number | null; mfe_r: number | null; mae_r: number | null; mfe_source: string | null; mfe_to: string | null;
  bars_held: number | null; error_class: string | null; slip_model_pts: number | null; slip_model_usd: number | null; pnl_after_slip_usd: number | null;
}

// ---- type normalisation at the raw-SQL boundary --------------------------------------------------
const BIGINT_COLS = ["entry_order_id", "stop_order_id", "exit_order_id"];
const DATE_COLS = ["opened_at", "closed_at", "received_at", "bar", "executed_at", "mfe_to"];
export function normaliseRow<T extends object>(row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of BIGINT_COLS) if (typeof out[k] === "bigint") out[k] = Number(out[k]);
  for (const k of DATE_COLS) if (out[k] instanceof Date) out[k] = (out[k] as Date).toISOString();
  return out as T;
}
export async function rawRows<T extends object>(sql: string, ...params: unknown[]): Promise<T[]> {
  const rows = await prisma.$queryRawUnsafe<T[]>(sql, ...params);
  return rows.map(normaliseRow);
}

// ---- config / state ------------------------------------------------------------------------------
export async function cfg(key: string): Promise<string | null> {
  return (await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null))?.value ?? null;
}
export async function setKey(key: string, value: string): Promise<void> {
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** Overrides clamped by `limitsFromConfig` (basis 1,000–50,000, pcts 0.25–1.0, unreadable stage → A). */
export async function deskLimits(): Promise<DeskLimits> {
  const [basis, risk, strong, aplus, stage] = await Promise.all(["sizing_basis", "risk_pct", "risk_pct_strong", "risk_pct_aplus", "stage"].map((k) => cfg(`futures_desk_${k}`)));
  return limitsFromConfig({ basis, risk, strong, aplus, stage });
}

export async function deskEnabled(): Promise<boolean> {
  return (await cfg("futures_desk_enabled")) === "true";
}

export async function loadState(): Promise<DeskState> {
  const raw = await cfg(STATE_KEY);
  if (!raw) return { alerts: {} };
  try { const s = JSON.parse(raw); return { alerts: {}, ...s }; } catch { return { alerts: {} }; }
}
export async function saveState(s: DeskState): Promise<void> { await setKey(STATE_KEY, JSON.stringify(s)); }
/** Field-scoped write: load the freshest row, patch, save. */
export async function patchState(patch: (s: DeskState) => void): Promise<void> { const s = await loadState(); patch(s); await saveState(s); }
export async function alertOnce(s: DeskState, key: string, text: string, everyMs = 60 * 60_000): Promise<void> {
  const last = s.alerts[key];
  if (last && Date.now() - Date.parse(last) < everyMs) return;
  await sendNotification(text, LANE).catch(() => {});
  s.alerts[key] = new Date().toISOString();
}

// ---- tables --------------------------------------------------------------------------------------
/** Columns added after the tables shipped — `ADD COLUMN IF NOT EXISTS`, so a deploy migrates itself
 *  and a row written before a column existed simply reads null there. */
const TRADE_COLUMNS: [string, string][] = [
  ["contract_month", "text"], ["stage", "text"],
  ["signal_price", "float8"], ["entry_slip_pts", "float8"], ["stop_points", "float8"], ["atr_at_entry", "float8"],
  ["session", "text"], ["regime", "text"], ["event_mode", "text"], ["grade", "text"],
  ["mfe_pts", "float8"], ["mae_pts", "float8"], ["mfe_r", "float8"], ["mae_r", "float8"], ["mfe_source", "text"], ["mfe_to", "timestamptz"],
  ["bars_held", "int"], ["error_class", "text"], ["slip_model_pts", "float8"], ["slip_model_usd", "float8"], ["pnl_after_slip_usd", "float8"],
];
const SIGNAL_COLUMNS: [string, string][] = [
  ["score", "int"], ["score_json", "text"], ["grade", "text"], ["regime", "text"], ["session", "text"], ["event_mode", "text"], ["checklist_json", "text"], ["error_class", "text"],
];
let tablesReady = false;
export async function ensureDeskTables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS futures_desk_signals (
    id serial PRIMARY KEY, received_at timestamptz DEFAULT now(), dedupe_key text UNIQUE, edge text, root text, action text,
    side text, price double precision, stop double precision, bar timestamptz, timeframe text, note text,
    status text, reason text, executed_at timestamptz, trade_id integer)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS futures_desk_trades (
    id serial PRIMARY KEY, opened_at timestamptz DEFAULT now(), edge text, root text, micro text, contract text, contract_id integer,
    side text, qty integer, entry_price double precision, stop_price double precision, entry_order_id bigint, stop_order_id bigint,
    cl_ord_id text, signal_id integer, status text DEFAULT 'open', exit_price double precision, exit_order_id bigint,
    closed_at timestamptz, exit_reason text, pnl_usd double precision, fees_usd double precision, risk_usd double precision,
    point_value double precision, rolled_from integer, note text)`);
  for (const [col, type] of TRADE_COLUMNS) await prisma.$executeRawUnsafe(`ALTER TABLE futures_desk_trades ADD COLUMN IF NOT EXISTS ${col} ${type}`);
  for (const [col, type] of SIGNAL_COLUMNS) await prisma.$executeRawUnsafe(`ALTER TABLE futures_desk_signals ADD COLUMN IF NOT EXISTS ${col} ${type}`);
  tablesReady = true;
}

// ---- ledger reads --------------------------------------------------------------------------------
export async function openTrades(): Promise<TradeRow[]> {
  await ensureDeskTables();
  return rawRows<TradeRow>(`SELECT * FROM futures_desk_trades WHERE status = 'open' ORDER BY id`);
}
export async function ledgerRows(limit = 60): Promise<TradeRow[]> {
  await ensureDeskTables();
  return rawRows<TradeRow>(`SELECT * FROM futures_desk_trades ORDER BY id DESC LIMIT $1::int`, limit);
}
/** Entries opened today (ET), from the ledger — rolls are not entries. */
export async function entriesToday(): Promise<number> {
  const day = etDayKey(new Date());
  const rows = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
    `SELECT count(*) AS n FROM futures_desk_trades WHERE rolled_from IS NULL AND (opened_at AT TIME ZONE 'America/New_York')::date = $1::date`, day);
  return Number(rows[0]?.n ?? 0);
}
/** Watch alerts already logged today (ET) for a root — the cap is three, excluding the row being judged. */
export async function watchesToday(root: string, excludeId: number): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
    `SELECT count(*) AS n FROM futures_desk_signals WHERE action = 'watch' AND root = $1 AND id <> $2::int AND (received_at AT TIME ZONE 'America/New_York')::date = $3::date`, root, excludeId, etDayKey(new Date()));
  return Number(rows[0]?.n ?? 0);
}

// ---- the inbox -----------------------------------------------------------------------------------
/** The alert's own stamps travel with the row: the score and the Pine v2 context fields (as JSON) and
 *  the ET session it arrived in. Grade and the checklist are stamped later, by the entry path. */
export async function recordSignal(a: AlertPayload, status: string, reason: string): Promise<{ id: number; duplicate: boolean }> {
  await ensureDeskTables();
  const key = dedupeKey(a);
  const ctx = { atr: a.atr, rsi: a.rsi, volRatio: a.volRatio, dist20h: a.dist20h, d1Up: a.d1Up, h4Up: a.h4Up };
  const scoreJson = Object.values(ctx).some((v) => v != null) ? JSON.stringify(ctx) : null;
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO futures_desk_signals (dedupe_key, edge, root, action, side, price, stop, bar, timeframe, note, status, reason, score, score_json, session)
     VALUES ($1,$2,$3,$4,$5,$6::float8,$7::float8,$8::timestamptz,$9,$10,$11,$12,$13::int,$14,$15) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    key, a.edge, a.root, a.action, a.side, a.price, a.stop, a.bar, a.timeframe, a.note, status, reason, a.score ?? null, scoreJson, sessionOf(new Date()));
  if (rows.length) return { id: rows[0].id, duplicate: false };
  const existing = await prisma.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM futures_desk_signals WHERE dedupe_key = $1`, key);
  return { id: existing[0]?.id ?? 0, duplicate: true };
}
export async function markSignal(id: number, status: string, reason: string, tradeId: number | null = null, errorClass: string | null = null): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE futures_desk_signals SET status = $2::text, reason = $3::text, executed_at = CASE WHEN $2::text IN ('executed','refused','error','expired','watch') THEN now() ELSE executed_at END,
     trade_id = COALESCE($4::int, trade_id), error_class = COALESCE($5::text, error_class) WHERE id = $1`, id, status, reason.slice(0, 400), tradeId, errorClass);
}
/** The entry path's stamps on the signal row: the grade it was sized at and the pre-trade checklist. */
export async function stampSignal(id: number, v: { grade?: string; checklistJson?: string }): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE futures_desk_signals SET grade = COALESCE($2::text, grade), checklist_json = COALESCE($3::text, checklist_json) WHERE id = $1`, id, v.grade ?? null, v.checklistJson ?? null);
}
/** Watch rows are a day's context, not an inbox item: after 24 h they expire. */
export async function expireOldWatches(): Promise<number> {
  return prisma.$executeRawUnsafe(`UPDATE futures_desk_signals SET status = 'expired', reason = 'watch older than 24h', executed_at = now() WHERE status = 'watch' AND received_at < now() - interval '24 hours'`);
}

// ---- safety reads/writes (E5) ------------------------------------------------------------------------
export const ANOMALY_KEY = "futures_desk_anomaly";
export const FEED_SEEN_KEY = "futures_desk_feed_seen_at";
/** The heartbeat chart's proof of life — a timestamp only, never a signal row. */
export async function noteFeedSeen(): Promise<void> { await setKey(FEED_SEEN_KEY, new Date().toISOString()); }
/** Execution errors of the last two days, for the daily count: signal rows that ended in `error`, plus
 *  ledger rows classed roll_failed / close_refused / unprotected — an unprotected ENTRY is already its
 *  signal's error, so it is not counted twice. An open row with a class is dated now (the problem is live). */
export async function executionErrorEvents(): Promise<{ at: string; errorClass: string | null }[]> {
  const rows = await prisma.$queryRawUnsafe<{ at: Date | string; error_class: string | null }[]>(
    `SELECT received_at AS at, COALESCE(error_class, 'entry_error') AS error_class FROM futures_desk_signals WHERE status = 'error' AND received_at > now() - interval '2 days'
     UNION ALL
     SELECT CASE WHEN t.status = 'open' THEN now() ELSE COALESCE(t.closed_at, t.opened_at) END AS at, t.error_class FROM futures_desk_trades t
     WHERE t.error_class IN ('roll_failed', 'close_refused', 'unprotected') AND COALESCE(t.closed_at, now()) > now() - interval '2 days'
       AND NOT EXISTS (SELECT 1 FROM futures_desk_signals s WHERE s.trade_id = t.id AND s.status = 'error')`);
  return rows.map((r) => ({ at: r.at instanceof Date ? r.at.toISOString() : String(r.at), errorClass: r.error_class }));
}
/** Ledger rows opened or closed since an instant — "fills since the last guardian run" for the equity-jump check. */
export async function ledgerChangesSince(iso: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT count(*) AS n FROM futures_desk_trades WHERE opened_at > $1::timestamptz OR closed_at > $1::timestamptz`, iso);
  return Number(rows[0]?.n ?? 0);
}

// ---- locks (compare-and-set on an AgentConfig row) --------------------------------------------------
/** Is the lock currently held (a fresh token)? The guardian skips the foreign/mismatch anomaly while an
 *  entry is in flight — its fill exists before its ledger row does. */
export async function lockHeld(key: string, ttlMs: number): Promise<boolean> {
  try { const row = await prisma.agentConfig.findUnique({ where: { key } }); const at = Number(row?.value?.split("@")[1] || 0); return !!row?.value && Date.now() - at < ttlMs; } catch { return false; }
}
export async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key } });
    if (!row) { try { await prisma.agentConfig.create({ data: { key, value: `${token}@${now}` } }); return token; } catch { return null; } }
    const at = Number(row.value.split("@")[1] || 0);
    if (row.value && now - at < ttlMs) return null;
    const r = await prisma.agentConfig.updateMany({ where: { key, value: row.value }, data: { value: `${token}@${now}` } });
    return r.count === 1 ? token : null;
  } catch { return null; }
}
export async function releaseLock(key: string, token: string): Promise<void> {
  try { const row = await prisma.agentConfig.findUnique({ where: { key } }); if (row?.value?.startsWith(token)) await setKey(key, ""); } catch { /* TTL */ }
}
