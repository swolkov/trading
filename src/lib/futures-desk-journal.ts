// FUTURES DESK — journal completeness and demo realism (E4).
//
// The demo fills at the touch with no slippage and reports no fees, so its own P&L flatters every
// rule. The judged series is `pnl_after_slip_usd` = the demo's P&L minus a per-market slippage
// model (round trip); `pnl_usd` stays the demo's own number so the two can always be compared.
// Entry slip is also MEASURED per trade (signal close vs fill): TradingView's alert arrives on a
// delayed bar close, so the fill is expected to differ — recorded, never hidden.
//
// The pure half (slip, excursions, R, error classes, sessions, the watch card) has no imports beyond
// the rules; `insertTrade` and `updateExcursions` are the I/O and talk to prisma directly so the
// store and this module never import each other.
import { prisma } from "@/lib/db";
import { etDayKey, sizeEntry, usd, type AlertPayload, type DeskLimits, type Side, type SizeOpts } from "@/lib/futures-desk-rules";

// ---- slippage model -----------------------------------------------------------------------------
/** Points paid per side on a market order. ES/NQ/GC were MEASURED (edge-factory, mini fills vs the
 *  signal close); the rest are ASSUMED at roughly one to two ticks and labelled so — a measured
 *  figure replaces each as the desk's own `entry_slip_pts` accumulates. */
export const SLIP_PTS_PER_SIDE: Record<string, { pts: number; source: "measured" | "assumed" }> = {
  ES: { pts: 0.89, source: "measured" },
  NQ: { pts: 11.74, source: "measured" },
  GC: { pts: 0.50, source: "measured" },
  YM: { pts: 4, source: "assumed" },
  SI: { pts: 0.01, source: "assumed" },
  HG: { pts: 0.0025, source: "assumed" },
  RTY: { pts: 0.5, source: "assumed" },
};
export function slipPtsPerSide(root: string): number { return SLIP_PTS_PER_SIDE[root]?.pts ?? 0; }

/** Measured entry slip in points, positive = paid (a long filled above the signal close, a short below). */
export function entrySlipPts(side: Side, signalPrice: number, fill: number): number {
  return side === "long" ? fill - signalPrice : signalPrice - fill;
}
/** The round-trip model in dollars: two sides × slip points × point value × contracts (MNQ 1-lot = $46.96). */
export function slipModelUsd(root: string, qty: number, pointValue: number): number {
  return 2 * slipPtsPerSide(root) * pointValue * qty;
}
export function pnlAfterSlip(pnlUsd: number, slipModelUsdValue: number): number { return pnlUsd - slipModelUsdValue; }

// ---- excursions ---------------------------------------------------------------------------------
export interface Excursion { mfePts: number; maePts: number; bars: number }
export interface Bar { h: number; l: number }

/** Running maximum favourable / adverse excursion in points from the entry (both ≥ 0), folding new
 *  bars into the previous total. A short's favourable side is DOWN. */
export function updateExcursion(prev: Excursion | null, side: Side, entry: number, bars: Bar[]): Excursion {
  let mfe = prev?.mfePts ?? 0, mae = prev?.maePts ?? 0;
  for (const b of bars) {
    const fav = side === "long" ? b.h - entry : entry - b.l;
    const adv = side === "long" ? entry - b.l : b.h - entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  return { mfePts: mfe, maePts: mae, bars: (prev?.bars ?? 0) + bars.length };
}
/** Points as a multiple of the initial stop distance; null when the stop distance is unknown or zero. */
export function toR(pts: number | null | undefined, stopPoints: number | null | undefined): number | null {
  if (pts == null || !Number.isFinite(pts) || stopPoints == null || !(stopPoints > 0)) return null;
  return pts / stopPoints;
}

// ---- error classes ------------------------------------------------------------------------------
export type ErrorClass = "partial_fill" | "unprotected" | "roll_failed" | "close_refused" | "queue_expired" | "auth_backoff" | "foreign_position";
export interface ErrorRow { error_class?: string | null; note?: string | null; exit_reason?: string | null; reason?: string | null; status?: string | null }

/** The mistake-tracking class of a row. A stamped `error_class` wins; rows written before the column
 *  existed are classified from their note / exit reason / signal reason. Null = clean. */
export function classifyError(row: ErrorRow): ErrorClass | null {
  const known: ErrorClass[] = ["partial_fill", "unprotected", "roll_failed", "close_refused", "queue_expired", "auth_backoff", "foreign_position"];
  if (row.error_class && known.includes(row.error_class as ErrorClass)) return row.error_class as ErrorClass;
  const text = `${row.note ?? ""} ${row.reason ?? ""}`.toLowerCase();
  if (row.exit_reason === "unprotected" || /could not be protected|unprotect/.test(text)) return "unprotected";
  if (/^partial fill/.test((row.note ?? "").toLowerCase())) return "partial_fill";
  if (/roll .*(failed|not rolled|refused)|not rolled/.test(text)) return "roll_failed";
  if (/close .*refused|close refused/.test(text)) return "close_refused";
  if (/queued for more than|older than 24h/.test(text)) return "queue_expired";
  if (/p-ticket|backoff|rate limit|auth/.test(text)) return "auth_backoff";
  if (/did not open|foreign/.test(text)) return "foreign_position";
  return null;
}

// ---- sessions (ET) ------------------------------------------------------------------------------
/** Time-of-day slice in New York time, for the journal — a stamp, never a gate (E3 reuses it).
 *  overnight 18–02 · european 02–07 · premarket 07–09:30 · open 09:30–10 · morning 10–11:30 ·
 *  midday 11:30–14 · power 14–15:30 · close 15:30–17 · break 17–18 (the CME pause). */
export type Session = "overnight" | "european" | "premarket" | "open" | "morning" | "midday" | "power" | "close" | "break";
export function sessionOf(now: Date): Session {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const m = et.getHours() * 60 + et.getMinutes();
  if (m >= 18 * 60 || m < 2 * 60) return "overnight";
  if (m < 7 * 60) return "european";
  if (m < 9 * 60 + 30) return "premarket";
  if (m < 10 * 60) return "open";
  if (m < 11 * 60 + 30) return "morning";
  if (m < 14 * 60) return "midday";
  if (m < 15 * 60 + 30) return "power";
  if (m < 17 * 60) return "close";
  return "break";
}
/** The MFE/MAE fold runs once per ET day, after 17:05 ET (the session's bars are complete). */
export function excursionJobDue(lastDayKey: string | undefined, now: Date): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours() * 60 + et.getMinutes() >= 17 * 60 + 5 && lastDayKey !== etDayKey(now);
}

// ---- the watch card -----------------------------------------------------------------------------
/** Three watch rows per root per ET day: the 60m rule can hover under its channel for hours. */
export const WATCH_CAP_PER_ROOT_PER_DAY = 3;
export function watchCapReached(watchesTodayForRoot: number): boolean { return watchesTodayForRoot >= WATCH_CAP_PER_ROOT_PER_DAY; }
/** A watch alert is sized as if it were an entry and the result is written as its reason — the desk
 *  learns what it WOULD do without placing anything. */
export function watchCard(a: AlertPayload, limits: DeskLimits, opts: SizeOpts): string {
  const s = sizeEntry(a, limits, opts);
  if (a.stop == null) return `dry run: no stop on the watch alert — unsized`;
  if (!s.ok) return `dry run: ${s.reason}`;
  return `dry run: ${s.contracts}× ${s.micro} · stop ${s.stopPoints} pts · risk ${usd(s.riskUsd, 2)} of ${usd(s.riskBudgetUsd)} (${s.grade} · stage ${s.stage})${s.reason ? ` · ${s.reason}` : ""}`;
}

// ---- I/O: the ledger INSERT (entry and roll share it) ----------------------------------------------
export interface NewTradeRow {
  openedAt?: string; edge: string; root: string; micro: string; contract: string; contractId: number; side: Side; qty: number;
  entryPrice: number; stopPrice: number; entryOrderId: number; stopOrderId: number | null; clOrdId: string; signalId: number | null;
  riskUsd: number; pointValue: number; rolledFrom: number | null; note: string | null; contractMonth: string; stage: string | null;
  signalPrice: number | null; entrySlipPts: number | null; stopPoints: number; atrAtEntry: number | null; session: string | null;
  regime: string | null; eventMode: string | null; grade: string | null; errorClass: string | null; slipModelPts: number; slipModelUsd: number;
}
export async function insertTrade(v: NewTradeRow): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO futures_desk_trades (opened_at, edge, root, micro, contract, contract_id, side, qty, entry_price, stop_price, entry_order_id, stop_order_id, cl_ord_id, signal_id, status,
       risk_usd, point_value, rolled_from, note, contract_month, stage, signal_price, entry_slip_pts, stop_points, atr_at_entry, session, regime, event_mode, grade, error_class, slip_model_pts, slip_model_usd)
     VALUES (COALESCE($1::timestamptz, now()),$2,$3,$4,$5,$6::int,$7,$8::int,$9::float8,$10::float8,$11::bigint,$12::bigint,$13,$14::int,'open',
       $15::float8,$16::float8,$17::int,$18,$19,$20,$21::float8,$22::float8,$23::float8,$24::float8,$25,$26,$27,$28,$29,$30::float8,$31::float8) RETURNING id`,
    v.openedAt ?? null, v.edge, v.root, v.micro, v.contract, v.contractId, v.side, v.qty, v.entryPrice, v.stopPrice, v.entryOrderId, v.stopOrderId, v.clOrdId, v.signalId,
    v.riskUsd, v.pointValue, v.rolledFrom, v.note, v.contractMonth, v.stage, v.signalPrice, v.entrySlipPts, v.stopPoints, v.atrAtEntry, v.session, v.regime, v.eventMode, v.grade, v.errorClass, v.slipModelPts, v.slipModelUsd);
  return rows[0].id;
}

// ---- I/O: the MFE/MAE fold from delayed Yahoo bars ----------------------------------------------------
/** Yahoo's continuous front-month symbols. In roll week the front month jumps, so an excursion on
 *  the old month carries the calendar spread — labelled by `mfe_source`, never corrected. */
export const YAHOO_FOR_ROOT: Record<string, string> = { ES: "ES=F", NQ: "NQ=F", YM: "YM=F", GC: "GC=F", SI: "SI=F", HG: "HG=F", RTY: "RTY=F" };
const YAHOO_DEADLINE_MS = 30_000;
const BACKFILL_AFTER_MS = 5 * 86_400_000;

interface ExcursionRow { id: number; root: string; side: Side; entry_price: number; stop_points: number | null; opened_at: Date | string; closed_at: Date | string | null; mfe_pts: number | null; mae_pts: number | null; bars_held: number | null; mfe_source: string | null; mfe_to: Date | string | null }
type YBar = { t: number; h: number; l: number };
type BarKind = "1h" | "1d";
const iso = (d: Date | string | null): string | null => (d == null ? null : d instanceof Date ? d.toISOString() : d);
/** Resolve to `fallback` once `ms` has passed; the timer is cleared either way so nothing lingers. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); });
  return Promise.race([p, clock]).finally(() => clearTimeout(timer));
}
async function yahooBars(sym: string, kind: BarKind): Promise<YBar[]> {
  const y = await import("@/lib/yahoo");
  if (kind === "1h") return (await y.getIntradayBars(sym, "1h", "5d")).map((x) => ({ t: x.t * 1000, h: x.h, l: x.l }));
  return (await y.getHistoricalBars(sym, 60)).map((x) => ({ t: Date.parse(x.t), h: x.h, l: x.l }));
}

/** Fold the bars since each row's last fold (or its open) into mfe/mae/bars_held. Open rows, and rows
 *  closed in the last 7 days whose fold has not yet reached their close, are folded from 1h bars (5-day
 *  window); a row first seen more than 5 days old is backfilled from daily bars and stays labelled
 *  `yahoo_1d`. Every distinct (symbol, kind) is fetched once, all in parallel, under ONE 30-second
 *  deadline; a market whose bars did not arrive is a note and is skipped for the day. Fail-soft. */
export async function updateExcursions(now = new Date(), loadBars: (sym: string, kind: BarKind) => Promise<YBar[]> = yahooBars): Promise<string[]> {
  const notes: string[] = [];
  const rows = await prisma.$queryRawUnsafe<ExcursionRow[]>(
    `SELECT id, root, side, entry_price, stop_points, opened_at, closed_at, mfe_pts, mae_pts, bars_held, mfe_source, mfe_to FROM futures_desk_trades
     WHERE status = 'open' OR (status = 'closed' AND closed_at > now() - interval '7 days' AND (mfe_to IS NULL OR mfe_to < closed_at)) ORDER BY id`);
  if (!rows.length) return notes;
  const plan = rows.map((r) => {
    const openedMs = Date.parse(iso(r.opened_at)!);
    const backfill = r.mfe_to == null && now.getTime() - openedMs > BACKFILL_AFTER_MS;
    const kind: BarKind = backfill || r.mfe_source === "yahoo_1d" ? "1d" : "1h";
    return { r, openedMs, kind, sym: YAHOO_FOR_ROOT[r.root] as string | undefined };
  });
  // One fetch per distinct (symbol, kind), all at once, one deadline; results land in the map as they arrive.
  const results = new Map<string, YBar[]>();
  const keys = [...new Set(plan.filter((p) => p.sym).map((p) => `${p.sym}|${p.kind}`))];
  await withTimeout(Promise.all(keys.map(async (k) => { const [sym, kind] = k.split("|") as [string, BarKind]; results.set(k, await loadBars(sym, kind).catch(() => [])); })), YAHOO_DEADLINE_MS, undefined);
  let folded = 0;
  for (const { r, openedMs, kind, sym } of plan) {
    if (!sym) { notes.push(`excursions: no Yahoo symbol for ${r.root}`); continue; }
    const all = results.get(`${sym}|${kind}`);
    if (!all) { notes.push(`excursions: ${kind} bars for ${sym} did not arrive within ${YAHOO_DEADLINE_MS / 1000}s`); continue; }
    if (!all.length) { notes.push(`excursions: no ${kind} bars for ${sym}`); continue; }
    const closedMs = r.closed_at ? Date.parse(iso(r.closed_at)!) : now.getTime();
    const fromMs = r.mfe_to ? Date.parse(iso(r.mfe_to)!) : openedMs;
    const fresh = all.filter((b) => b.t > fromMs && b.t <= closedMs && b.h > 0 && b.l > 0);
    if (!fresh.length) continue;
    const prev: Excursion | null = r.mfe_pts != null ? { mfePts: r.mfe_pts, maePts: r.mae_pts ?? 0, bars: r.bars_held ?? 0 } : null;
    const ex = updateExcursion(prev, r.side, r.entry_price, fresh);
    const to = new Date(Math.max(...fresh.map((b) => b.t))).toISOString();
    await prisma.$executeRawUnsafe(
      `UPDATE futures_desk_trades SET mfe_pts = $2::float8, mae_pts = $3::float8, mfe_r = $4::float8, mae_r = $5::float8, bars_held = $6::int, mfe_source = $7::text, mfe_to = $8::timestamptz WHERE id = $1`,
      r.id, ex.mfePts, ex.maePts, toR(ex.mfePts, r.stop_points), toR(ex.maePts, r.stop_points), ex.bars, kind === "1d" ? "yahoo_1d" : "yahoo_1h_delayed", to);
    folded++;
  }
  if (folded) notes.push(`excursions: folded ${folded} row(s)`);
  return notes;
}
