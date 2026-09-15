// NATIVE 4h BAR HISTORY (C6, Sep 15 2026). Kraken's public OHLC returns at most 720 bars — 120
// days of 4h — so the desk's own 4h history for the coins it actually trades can never grow past
// that window unless it is kept. This appends every COMPLETE 4h bar of the scan universe to
// margin_bars_4h once a day from the daily synthesis (fail-soft: a Kraken hiccup costs one day,
// never the run). In ~4 months it passes the 720-bar cap and the walk-forward can be re-run on
// Kraken's own prices rather than the Binance proxy (scripts/lib/bars.ts).
import { prisma } from "@/lib/db";
import { ensureMarginTables, getKrakenOHLC, type KrakenBar } from "@/lib/kraken-margin";
import { SCAN_UNIVERSE } from "@/lib/kraken-pairs";
import { FOUR_H_SEC } from "@/lib/margin-live-risk";

export const BARS_4H_LAST_KEY = "margin_bars_4h_last";

export interface BarsSnapshot { coins: number; inserted: number; errors: string[]; at: string }

/** Upsert every complete 4h bar Kraken returns for `symbol`; returns how many rows were new. */
export async function upsertBars4h(symbol: string, bars: KrakenBar[], nowSec: number = Date.now() / 1000): Promise<number> {
  const complete = bars.filter((b) => Number.isFinite(b.t) && b.t + FOUR_H_SEC <= nowSec && [b.o, b.h, b.l, b.c].every(Number.isFinite));
  let inserted = 0;
  for (const b of complete) {
    const n = await prisma.$executeRawUnsafe(
      `INSERT INTO margin_bars_4h (symbol, t, o, h, l, c, v) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (symbol, t) DO UPDATE SET h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v
       WHERE margin_bars_4h.c IS DISTINCT FROM EXCLUDED.c`,
      symbol, b.t, b.o, b.h, b.l, b.c, b.v ?? 0,
    );
    inserted += n > 0 ? 1 : 0;
  }
  return inserted;
}

/** Daily, from runMarginSynthesis. Every coin is best-effort; the summary is stored under BARS_4H_LAST_KEY. */
export async function snapshotBars4h(): Promise<BarsSnapshot> {
  await ensureMarginTables();
  const out: BarsSnapshot = { coins: 0, inserted: 0, errors: [], at: new Date().toISOString() };
  for (const coin of SCAN_UNIVERSE) {
    const symbol = `${coin}/USD`;
    try {
      const bars = await getKrakenOHLC(symbol, 240);
      out.inserted += await upsertBars4h(symbol, bars);
      out.coins++;
    } catch (e) { out.errors.push(`${coin}: ${String(e).slice(0, 60)}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  await prisma.agentConfig.upsert({ where: { key: BARS_4H_LAST_KEY }, update: { value: JSON.stringify(out) }, create: { key: BARS_4H_LAST_KEY, value: JSON.stringify(out) } }).catch(() => {});
  return out;
}

/** The stored 4h history for a symbol, oldest first. */
export async function loadBars4h(symbol: string, sinceSec = 0): Promise<KrakenBar[]> {
  await ensureMarginTables();
  return prisma.$queryRawUnsafe<KrakenBar[]>(`SELECT t, o, h, l, c, v FROM margin_bars_4h WHERE symbol = $1 AND t >= $2 ORDER BY t`, symbol, sinceSec);
}
