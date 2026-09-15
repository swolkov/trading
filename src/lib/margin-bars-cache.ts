// NATIVE 4h BAR HISTORY (C6, Sep 15 2026). Kraken's public OHLC returns at most 720 bars — 120
// days of 4h — so the desk's own 4h history for the coins it actually trades can never grow past
// that window unless it is kept. This appends every COMPLETE 4h bar of the scan universe to
// margin_bars_4h once a day from the daily synthesis, AFTER the run's stamp and Slack summary
// (fail-soft: a Kraken hiccup costs one day, never the run). In ~4 months it passes the 720-bar
// cap and the walk-forward can be re-run on Kraken's own prices rather than the Binance proxy.
//
// Cheap by construction: each coin asks Kraken only for bars after the newest one already stored
// (`since` = MAX(t)), so a steady-state day is ~6 new bars per coin in ONE multi-row insert; the
// first run backfills the 720-bar window. The whole snapshot stops at SNAPSHOT_BUDGET_MS and says
// so — the next day picks up where it left off.
import { prisma } from "@/lib/db";
import { ensureMarginTables, getKrakenOHLC, type KrakenBar } from "@/lib/kraken-margin";
import { SCAN_UNIVERSE } from "@/lib/kraken-pairs";
import { FOUR_H_SEC } from "@/lib/margin-live-risk";

export const BARS_4H_LAST_KEY = "margin_bars_4h_last";
export const SNAPSHOT_BUDGET_MS = 30_000;

export interface BarsSnapshot { coins: number; inserted: number; errors: string[]; at: string; stoppedForBudget: boolean }

/** Only complete bars (close time ≤ now) with finite prices; never the in-progress one. */
export function completeBars(bars: KrakenBar[], nowSec: number): KrakenBar[] {
  return bars.filter((b) => Number.isFinite(b.t) && b.t + FOUR_H_SEC <= nowSec && [b.o, b.h, b.l, b.c].every(Number.isFinite));
}

/** The `since` for Kraken: the newest stored bar's t (exclusive on Kraken's side), or undefined for a full 720-bar backfill. */
export function sinceFor(maxT: number | null | undefined): number | undefined {
  return maxT != null && Number.isFinite(maxT) && maxT > 0 ? maxT : undefined;
}

export async function newestStoredT(symbol: string): Promise<number | null> {
  const rows = await prisma.$queryRawUnsafe<{ t: number | bigint | null }[]>(`SELECT MAX(t) AS t FROM margin_bars_4h WHERE symbol = $1`, symbol);
  const t = rows[0]?.t;
  return t == null ? null : Number(t);
}

/** One multi-row insert per coin; existing (symbol, t) rows are left as they are. Returns the rows written. */
export async function insertBars4h(symbol: string, bars: KrakenBar[]): Promise<number> {
  if (!bars.length) return 0;
  const values: string[] = []; const params: unknown[] = [symbol];
  bars.forEach((b) => {
    const k = params.length;
    params.push(b.t, b.o, b.h, b.l, b.c, b.v ?? 0);
    values.push(`($1, $${k + 1}, $${k + 2}, $${k + 3}, $${k + 4}, $${k + 5}, $${k + 6})`);
  });
  return prisma.$executeRawUnsafe(`INSERT INTO margin_bars_4h (symbol, t, o, h, l, c, v) VALUES ${values.join(",")} ON CONFLICT (symbol, t) DO NOTHING`, ...params);
}

/** Daily, from runMarginSynthesis, after the run is stamped. Every coin is best-effort; the summary is stored under BARS_4H_LAST_KEY. */
export async function snapshotBars4h(opts: { budgetMs?: number; now?: () => number } = {}): Promise<BarsSnapshot> {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? SNAPSHOT_BUDGET_MS;
  const t0 = now();
  await ensureMarginTables();
  const out: BarsSnapshot = { coins: 0, inserted: 0, errors: [], at: new Date().toISOString(), stoppedForBudget: false };
  for (const coin of SCAN_UNIVERSE) {
    if (now() - t0 >= budget) { out.stoppedForBudget = true; out.errors.push(`stopped after ${out.coins} coins: ${budget / 1000}s budget`); break; }
    const symbol = `${coin}/USD`;
    try {
      const since = sinceFor(await newestStoredT(symbol));
      const bars = await getKrakenOHLC(symbol, 240, since);
      out.inserted += await insertBars4h(symbol, completeBars(bars, now() / 1000).filter((b) => since == null || b.t > since));
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
