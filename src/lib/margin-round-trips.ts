// THE LIVE JOURNAL TABLE (Sep 15 2026) — one row per bot book, keyed by its opening order txid.
//
// reconstructTrips (kraken-margin.ts) stays the P&L TRUTH: it rebuilds every round trip from
// Kraken's own fills, FIFO, and nothing here is ever summed for a scoreboard. This table is the
// JOURNAL — the things a fill cannot tell you: the trade card it was authorised by, its 1R, the
// best and worst prices it saw while open (MFE / MAE in R), the stop level the guardian last
// ledgered, why the guardian closed it, and — once the daily synthesis has matched the fills —
// the real exit, fees, net, hold, the paper twin's P&L at live size and the stop-fill slippage
// against that ledgered level.
//
// Two writers, two phases:
//   A. the guardian, every run, for every open bot book (upsertRoundTripOpen) and when its own
//      close goes through (markRoundTripExit) — best-effort, never before margin_watch_protect_ok
//      is decided, never able to throw out of the protect loop;
//   B. the synthesis, daily, for every CLOSED live fill (upsertRoundTripClose).
import { prisma } from "@/lib/db";
import { ensureMarginTables } from "@/lib/kraken-margin";

export interface RoundTripOpen {
  txid: string; cardId: number | null; pair: string; side: "long" | "short"; source: string | null;
  entryPrice: number; oneR: number; openedAt: string | null;
  peak: number; trough: number; mfeR: number | null; maeR: number | null; lastStopLevel: number | null;
  exitReason?: string | null;
}

/** Phase A: the open book's state this run. Idempotent; exit_reason is only ever SET, never cleared. */
export async function upsertRoundTripOpen(r: RoundTripOpen): Promise<void> {
  await ensureMarginTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO margin_round_trips (txid, card_id, pair, side, source, entry_price, one_r, opened_at, peak, trough, mfe_r, mae_r, last_stop_level, exit_reason, last_seen_at, closed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, $12, $13, $14, now(), false)
     ON CONFLICT (txid) DO UPDATE SET
       card_id = COALESCE(EXCLUDED.card_id, margin_round_trips.card_id),
       source = COALESCE(EXCLUDED.source, margin_round_trips.source),
       one_r = CASE WHEN margin_round_trips.one_r > 0 THEN margin_round_trips.one_r ELSE EXCLUDED.one_r END,
       opened_at = COALESCE(margin_round_trips.opened_at, EXCLUDED.opened_at),
       peak = EXCLUDED.peak, trough = EXCLUDED.trough, mfe_r = EXCLUDED.mfe_r, mae_r = EXCLUDED.mae_r,
       last_stop_level = COALESCE(EXCLUDED.last_stop_level, margin_round_trips.last_stop_level),
       exit_reason = COALESCE(EXCLUDED.exit_reason, margin_round_trips.exit_reason),
       last_seen_at = now()`,
    r.txid, r.cardId, r.pair, r.side, r.source, r.entryPrice, r.oneR, r.openedAt, r.peak, r.trough, r.mfeR, r.maeR, r.lastStopLevel, r.exitReason ?? null,
  );
}

/** Phase A: the guardian's own close went through (time stop, managed-stop breach). */
export async function markRoundTripExit(txid: string, reason: string): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE margin_round_trips SET exit_reason = COALESCE(exit_reason, $2), last_seen_at = now() WHERE txid = $1`, txid, reason.slice(0, 80));
}

export interface RoundTripClose {
  txid: string; exitPrice: number | null; exitAt: string | null; fees: number | null; rollover: number | null;
  netPnl: number | null; holdMinutes: number | null; stopFillSlipBp: number | null; paperPnlAtLiveSize: number | null;
  exitReason?: string | null;
}

/** Phase B: the synthesis has matched the fills. A row the guardian never wrote (a legacy entry) is created bare. */
export async function upsertRoundTripClose(c: RoundTripClose, seed: { pair: string; side: "long" | "short"; source: string | null; entryPrice: number; openedAt: string | null }): Promise<void> {
  await ensureMarginTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO margin_round_trips (txid, pair, side, source, entry_price, one_r, opened_at, peak, trough, exit_price, exit_at, fees, rollover, net_pnl, hold_minutes, stop_fill_slip_bp, paper_pnl_at_live_size, exit_reason, last_seen_at, closed)
     VALUES ($1, $2, $3, $4, $5, 0, $6::timestamptz, $5, $5, $7, $8::timestamptz, $9, $10, $11, $12, $13, $14, $15, now(), true)
     ON CONFLICT (txid) DO UPDATE SET
       exit_price = EXCLUDED.exit_price, exit_at = EXCLUDED.exit_at, fees = EXCLUDED.fees,
       rollover = COALESCE(EXCLUDED.rollover, margin_round_trips.rollover),
       net_pnl = EXCLUDED.net_pnl, hold_minutes = EXCLUDED.hold_minutes,
       stop_fill_slip_bp = COALESCE(EXCLUDED.stop_fill_slip_bp, margin_round_trips.stop_fill_slip_bp),
       paper_pnl_at_live_size = EXCLUDED.paper_pnl_at_live_size,
       exit_reason = COALESCE(margin_round_trips.exit_reason, EXCLUDED.exit_reason),
       last_seen_at = now(), closed = true`,
    c.txid, seed.pair, seed.side, seed.source, seed.entryPrice, seed.openedAt, c.exitPrice, c.exitAt, c.fees, c.rollover, c.netPnl, c.holdMinutes, c.stopFillSlipBp, c.paperPnlAtLiveSize, c.exitReason ?? null,
  );
}

export interface RoundTripJournal { txid: string; cardId: number | null; lastStopLevel: number | null; mfeR: number | null; maeR: number | null; exitReason: string | null }

/** What the synthesis needs per live txid: the ledgered stop level and the excursions. */
export async function loadRoundTripJournal(txids: string[]): Promise<Map<string, RoundTripJournal>> {
  const out = new Map<string, RoundTripJournal>();
  if (!txids.length) return out;
  await ensureMarginTables();
  const rows = await prisma.$queryRawUnsafe<{ txid: string; card_id: number | null; last_stop_level: number | null; mfe_r: number | null; mae_r: number | null; exit_reason: string | null }[]>(
    `SELECT txid, card_id, last_stop_level, mfe_r, mae_r, exit_reason FROM margin_round_trips WHERE txid = ANY($1::text[])`, txids,
  );
  for (const r of rows) out.set(r.txid, { txid: r.txid, cardId: r.card_id, lastStopLevel: r.last_stop_level, mfeR: r.mfe_r, maeR: r.mae_r, exitReason: r.exit_reason });
  return out;
}
