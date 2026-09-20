// THE BROKER LEDGER — Tradovate's own cash-balance log for the live account, kept by the room every
// tick and summarized by day. This is the MONEY TRUTH: every paired trade's realized P&L, every
// commission / exchange / NFA / clearing fee, liquidations, subscriptions. Fills can vanish from the
// API after the session; the ledger survives (the broker keeps a few days), so the room stores it.
// Read-only: one GET, no order path.
import { prisma } from "@/lib/db";
import { tradovateRequest } from "@/lib/tradovate";
import { ledgerByDay, ledgerTrades, type LedgerDay, type LedgerRow, type LedgerTrade } from "@/lib/trading-room-ledger-rules";
export type { LedgerDay, LedgerRow, LedgerTrade } from "@/lib/trading-room-ledger-rules";

export async function ensureLedgerTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS trading_room_ledger (
    id bigint PRIMARY KEY, ts timestamptz NOT NULL, trade_date date, type text NOT NULL, delta float8 NOT NULL,
    realized_pnl float8, fill_id bigint, fill_pair_id bigint, received_at timestamptz NOT NULL DEFAULT now())`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS trading_room_ledger_ts ON trading_room_ledger (ts)`);
}

interface RawLog { id: number; timestamp: string; tradeDate?: { year: number; month: number; day: number }; cashChangeType: string; delta: number; realizedPnL?: number; fillId?: number; fillPairId?: number }

/** Pull the broker's log and store what is new. Idempotent on the broker's own row id. */
export async function syncLedger(): Promise<{ seen: number; stored: number }> {
  await ensureLedgerTable();
  const rows = await tradovateRequest("/cashBalanceLog/list", undefined, "live") as RawLog[];
  if (!Array.isArray(rows)) return { seen: 0, stored: 0 };
  let stored = 0;
  for (const r of rows) {
    if (typeof r.id !== "number" || !r.timestamp || !r.cashChangeType) continue;
    const td = r.tradeDate ? `${r.tradeDate.year}-${String(r.tradeDate.month).padStart(2, "0")}-${String(r.tradeDate.day).padStart(2, "0")}` : null;
    const n = await prisma.$executeRawUnsafe(
      `INSERT INTO trading_room_ledger (id, ts, trade_date, type, delta, realized_pnl, fill_id, fill_pair_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      r.id, new Date(r.timestamp), td, String(r.cashChangeType), Number(r.delta) || 0, r.realizedPnL == null ? null : Number(r.realizedPnL), r.fillId ?? null, r.fillPairId ?? null,
    );
    stored += Number(n);
  }
  return { seen: rows.length, stored };
}

interface DbRow { id: number; ts: Date; trade_date: Date | null; type: string; delta: number; realized_pnl: number | null; fill_id: number | null; fill_pair_id: number | null }
export async function ledgerView(days = 60): Promise<{ rows: number; byDay: LedgerDay[]; trades: LedgerTrade[]; since: string | null }> {
  await ensureLedgerTable();
  const since = new Date(Date.now() - days * 24 * 3_600_000);
  const rows = (await prisma.$queryRawUnsafe<DbRow[]>(`SELECT * FROM trading_room_ledger WHERE ts >= $1 ORDER BY ts`, since)).map((r): LedgerRow => ({
    id: Number(r.id), ts: new Date(r.ts).toISOString(), tradeDate: r.trade_date ? new Date(r.trade_date).toISOString().slice(0, 10) : null, type: r.type, delta: Number(r.delta),
    realizedPnl: r.realized_pnl == null ? null : Number(r.realized_pnl), fillId: r.fill_id == null ? null : Number(r.fill_id), fillPairId: r.fill_pair_id == null ? null : Number(r.fill_pair_id),
  }));
  return { rows: rows.length, byDay: ledgerByDay(rows), trades: ledgerTrades(rows), since: rows[0]?.ts ?? null };
}
