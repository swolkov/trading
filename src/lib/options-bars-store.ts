// THE UNDERLYING BARS INBOX for the options paper book.
//
// The book is measured on the platform it would trade on. Daily bars for every name in the
// universe come from ROBINHOOD (get_equity_historicals, split-adjusted, regular session) and
// today's close is the OFFICIAL settled close (get_equity_quotes), not whatever print a
// third-party feed caught last. Robinhood has no server credentials, so — exactly like the
// option quotes — the scheduled desk session fetches the bars and pushes them here, and the
// app reads only from this table. Nothing in the options book reads Yahoo any more.
//
// Sep 11 2026: the book had been unable to open a position since the Sep 9 port because the
// Yahoo fetch's exclusive end date never returned the current session, and the scan's
// freshness gate requires the newest bar to be today's. Moving the bars behind the same
// push inbox as the quotes puts the whole book on one data path with one freshness story,
// visible on the page.
import { prisma } from "@/lib/db";
import type { DailyBar } from "@/lib/rh-options-data";

export interface StoredBar { day: string; o: number; h: number; l: number; c: number; v: number; official: boolean }

/** A bar older than this, for a symbol the book needs, is reported as stale on the page.
 *  Weekends make ~3 days normal; 4 days means a scheduled run was missed. */
export const MAX_BAR_AGE_DAYS = 4;
/** How much history the signal needs: 200-day average + slack. */
export const BAR_HISTORY_DAYS = 420;

export async function ensureBarsStore(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS options_underlying_bars (
    symbol text NOT NULL,
    day date NOT NULL,
    o double precision NOT NULL,
    h double precision NOT NULL,
    l double precision NOT NULL,
    c double precision NOT NULL,
    v double precision NOT NULL DEFAULT 0,
    official_close boolean NOT NULL DEFAULT false,
    pushed_at timestamptz DEFAULT now(),
    PRIMARY KEY (symbol, day)
  )`);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Upsert bars for one symbol. A bar flagged `official` (today's settled close from
 *  get_equity_quotes) overwrites a provisional one; a provisional bar never overwrites an
 *  official one. Returns rows written. Rejects malformed rows instead of guessing. */
export async function putBars(symbol: string, bars: StoredBar[]): Promise<number> {
  await ensureBarsStore();
  const sym = symbol.toUpperCase().trim();
  let n = 0;
  for (const b of bars) {
    if (!DAY.test(b.day)) continue;
    if (![b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0)) continue;
    if (b.h < b.l || b.c > b.h + 1e-9 || b.c < b.l - 1e-9) continue;
    await prisma.$executeRawUnsafe(
      `INSERT INTO options_underlying_bars (symbol, day, o, h, l, c, v, official_close, pushed_at)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (symbol, day) DO UPDATE SET
         o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v,
         official_close = EXCLUDED.official_close, pushed_at = now()
       WHERE options_underlying_bars.official_close = false OR EXCLUDED.official_close = true`,
      sym, b.day, b.o, b.h, b.l, b.c, b.v ?? 0, !!b.official,
    );
    n++;
  }
  return n;
}

/** Bars for many symbols in the shape the scanner and evaluator consume. `t` is the
 *  session's ISO timestamp at 13:30Z (09:30 ET) so every existing `t.slice(0, 10)` date
 *  comparison keeps working. A symbol with nothing stored is simply absent. */
export async function getStoredBars(symbols: string[], days = BAR_HISTORY_DAYS): Promise<Record<string, DailyBar[]>> {
  await ensureBarsStore();
  if (!symbols.length) return {};
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; day: Date; o: number; h: number; l: number; c: number; v: number }[]>(
    `SELECT symbol, day, o, h, l, c, v FROM options_underlying_bars
     WHERE symbol = ANY($1::text[]) AND day >= (CURRENT_DATE - $2::int)
     ORDER BY symbol, day`,
    syms, days,
  );
  const out: Record<string, DailyBar[]> = {};
  for (const r of rows) {
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    (out[r.symbol] ??= []).push({ t: `${day}T13:30:00.000Z`, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
  }
  return out;
}

export interface BarsWorkItem { symbol: string; fromDay: string; newestStored: string | null }

/** What the desk session must fetch: for each symbol, bars from the day after the newest
 *  stored one (or a full history if none). Always includes today so the official close can
 *  overwrite a provisional bar. */
export async function barsWorklist(symbols: string[], now: Date = new Date()): Promise<BarsWorkItem[]> {
  await ensureBarsStore();
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; newest: Date | null; official: boolean | null }[]>(
    `SELECT symbol, max(day) AS newest, bool_or(official_close) FILTER (WHERE day = (SELECT max(day) FROM options_underlying_bars b2 WHERE b2.symbol = b.symbol)) AS official
     FROM options_underlying_bars b WHERE symbol = ANY($1::text[]) GROUP BY symbol`,
    syms,
  );
  const byKey = new Map(rows.map((r) => [r.symbol, r]));
  const fullFrom = new Date(now.getTime() - BAR_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  return syms.map((symbol) => {
    const r = byKey.get(symbol);
    const newest = r?.newest ? r.newest.toISOString().slice(0, 10) : null;
    // Re-fetch from the newest stored day itself (not the day after) when it is still
    // provisional, so a later official close replaces it.
    const fromDay = !newest ? fullFrom : r?.official ? nextDay(newest) : newest;
    return { symbol, fromDay, newestStored: newest };
  });
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export interface BarsStoreStatus {
  symbols: number; newestDay: string | null; oldestNewestDay: string | null;
  staleSymbols: string[]; stale: boolean;
}

/** Page-facing freshness: the newest bar across the universe, the symbol furthest behind,
 *  and which symbols are past MAX_BAR_AGE_DAYS. `stale` is true when ANY needed symbol is —
 *  a partially fresh universe silently drops signals on the names that are behind. */
export async function barsStoreFreshness(symbols: string[], now: Date = new Date()): Promise<BarsStoreStatus> {
  await ensureBarsStore();
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; newest: Date }[]>(
    `SELECT symbol, max(day) AS newest FROM options_underlying_bars WHERE symbol = ANY($1::text[]) GROUP BY symbol`,
    syms,
  );
  const newestBy = new Map(rows.map((r) => [r.symbol, r.newest.toISOString().slice(0, 10)]));
  const cutoff = new Date(now.getTime() - MAX_BAR_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const staleSymbols = syms.filter((s) => (newestBy.get(s) ?? "0000-00-00") < cutoff);
  const days = [...newestBy.values()].sort();
  return {
    symbols: newestBy.size,
    newestDay: days.at(-1) ?? null,
    oldestNewestDay: days[0] ?? null,
    staleSymbols,
    stale: staleSymbols.length > 0,
  };
}
