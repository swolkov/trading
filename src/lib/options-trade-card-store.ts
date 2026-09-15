// THE TRADE-CARD LEDGER (D5, Sep 15 2026). One raw-SQL table, `options_trade_cards`, written by
// the research ingest (the top five per run, source `research`) and the live desk (every entry
// attempt and refusal, sources `entry` / `refusal`) AFTER the order decision, `.catch`ed by the
// callers — never on the order's critical path. Read by /api/options/score and the brief.
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import type { OptionsTradeCard } from "./options-trade-card";

let ensured: Promise<void> | null = null;   // once per process; a failed attempt clears so the next write retries
export function ensureOptionsTradeCardsTable(): Promise<void> {
  ensured ??= (async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS options_trade_cards (
      id text PRIMARY KEY, at timestamptz NOT NULL, source text NOT NULL, symbol text NOT NULL, kind text NOT NULL,
      expiry text NOT NULL, score double precision, grade text, action text NOT NULL, payload jsonb NOT NULL)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS options_trade_cards_time ON options_trade_cards(at DESC)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS options_trade_cards_symbol ON options_trade_cards(symbol, at DESC)`);
  })().catch((e) => { ensured = null; throw e; });
  return ensured;
}
export async function saveOptionsTradeCards(cards: OptionsTradeCard[]): Promise<number> {
  if (!cards.length) return 0;
  await ensureOptionsTradeCardsTable();
  for (const c of cards) {
    await prisma.$executeRawUnsafe(`INSERT INTO options_trade_cards(id,at,source,symbol,kind,expiry,score,grade,action,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(id) DO NOTHING`,
      randomUUID(), new Date(c.at), c.source, c.symbol, c.structure, c.expiry, c.confidence.score, c.grade, c.action, JSON.stringify(c));
  }
  return cards.length;
}
export interface StoredTradeCard { id: string; at: string; source: string; symbol: string; kind: string; expiry: string; score: number | null; grade: string | null; action: string; card: OptionsTradeCard }
export async function readOptionsTradeCards(limit = 40, source?: OptionsTradeCard["source"]): Promise<StoredTradeCard[]> {
  const n = Math.min(200, Math.max(1, Math.floor(limit)));
  const rows = await prisma.$queryRawUnsafe<{ id: string; at: Date; source: string; symbol: string; kind: string; expiry: string; score: number | null; grade: string | null; action: string; payload: OptionsTradeCard }[]>(
    source ? `SELECT * FROM options_trade_cards WHERE source=$2 ORDER BY at DESC LIMIT $1` : `SELECT * FROM options_trade_cards ORDER BY at DESC LIMIT $1`, n, ...(source ? [source] : []));
  return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), source: r.source, symbol: r.symbol, kind: r.kind, expiry: r.expiry, score: r.score, grade: r.grade, action: r.action, card: r.payload }));
}
