// PENDING (CONDITIONAL) PAPER ENTRIES (C5b, Sep 15 2026) — the `swing-retest` twin.
//
// The prompt's "conditional entry": a 4h breakout is not chased at the pierce; it is QUEUED with
// the pierced 20-bar level and opened only if price comes back to that level and holds. The rule,
// registered in docs/KRAKEN-DESK-OPERATING-MODEL.md §4 before the first row:
//
//   fill   — the first COMPLETED 1-min bar whose adverse extreme touches the level within the
//            RETEST_BAND (a long: low ≤ level × 1.005) AND that closes on the trade's side of the
//            level (close > level). The paper row opens at that close, chased 0.1% like every entry.
//   fail   — a completed bar closes through the level by more than the band (a long: close < level
//            × 0.995): the breakout failed; no entry.
//   expire — PENDING_TTL_H hours after the pierce with neither.
//
// The resolver runs at the TOP of each margin-scan tick, inside the route's deadline budget, on at
// most RESOLVE_MAX_SYMBOLS symbols per tick, walking only bars it has not walked (last_checked_t).
// Its fill rate is the twin's first kill rule (< 25% after 40 queued), so every outcome is a row.
import { prisma } from "@/lib/db";
import { ensureMarginTables, getKrakenOHLC, type KrakenBar } from "@/lib/kraken-margin";
import { SIM_VERSION, snapshotShadowSizing } from "@/lib/margin-shadow";

export const RETEST_BAND = 0.005;          // 0.5% either side of the level
export const PENDING_TTL_H = 24;
export const RESOLVE_MAX_SYMBOLS = 10;
export const RESOLVE_MIN_BUDGET_MS = 45_000;   // leave the scan its 130 calls
const CHASE = 0.001;

export type RetestOutcome = { outcome: "fill"; bar: KrakenBar } | { outcome: "fail"; bar: KrakenBar } | { outcome: "none" };

/**
 * PURE. Walk completed 1-min bars oldest-first and return the first that fills or fails the
 * retest of `level` for `side`. A bar that both touches and closes through fails (the close is
 * what matters — a wick that reclaims is not a hold).
 */
export function retestTriggered(bars: { t: number; o: number; h: number; l: number; c: number }[], level: number, side: "buy" | "sell", band = RETEST_BAND): RetestOutcome {
  if (!(level > 0)) return { outcome: "none" };
  for (const b of bars) {
    if (side === "buy") {
      if (b.c < level * (1 - band)) return { outcome: "fail", bar: b as KrakenBar };
      if (b.l <= level * (1 + band) && b.c > level) return { outcome: "fill", bar: b as KrakenBar };
    } else {
      if (b.c > level * (1 + band)) return { outcome: "fail", bar: b as KrakenBar };
      if (b.h >= level * (1 - band) && b.c < level) return { outcome: "fill", bar: b as KrakenBar };
    }
  }
  return { outcome: "none" };
}

export interface PendingInput {
  symbol: string; side: "buy" | "sell"; source: string; level: number; leverage: number;
  conviction: string; convictionScore: number | null; note: string;
  stamps: { columns: readonly string[]; values: readonly unknown[] }; btcRegime: string;
}

/** Queue one deferred entry. One pending row per (symbol, source) — a second pierce while one waits is ignored. */
export async function queuePendingEntry(i: PendingInput): Promise<{ queued: boolean; id: number | null; why?: string }> {
  await ensureMarginTables();
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM margin_pending_entries WHERE symbol=$1 AND source=$2 AND status='pending'`, i.symbol, i.source,
  );
  if (Number(n) > 0) return { queued: false, id: null, why: `${i.source} already waiting on ${i.symbol}` };
  const stamps: Record<string, unknown> = {};
  i.stamps.columns.forEach((c, k) => { stamps[c] = i.stamps.values[k] ?? null; });
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO margin_pending_entries (symbol, side, source, level, leverage, conviction, conviction_score, note, stamps, btc_regime, expires_at, status, last_checked_t)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10, now() + ($11 || ' hours')::interval, 'pending', extract(epoch from now())) RETURNING id`,
    i.symbol, i.side, i.source, i.level, i.leverage, i.conviction, i.convictionScore, i.note, JSON.stringify(stamps), i.btcRegime, String(PENDING_TTL_H),
  );
  return { queued: true, id: rows[0]?.id ?? null };
}

interface PendingRow {
  id: number; created_at: Date; symbol: string; side: "buy" | "sell"; source: string; level: number; leverage: number | null;
  conviction: string | null; conviction_score: number | null; note: string | null; stamps: Record<string, unknown> | null;
  btc_regime: string | null; expires_at: Date; last_checked_t: number | null;
}

/** The paper row a filled retest opens: source swing-retest, entry = the fill bar's close chased, time = that bar's close. */
async function openFilledRow(p: PendingRow, bar: KrakenBar): Promise<number | null> {
  const entryPx = p.side === "buy" ? bar.c * (1 + CHASE) : bar.c * (1 - CHASE);
  const stampCols = Object.keys(p.stamps ?? {}).filter((c) => /^[a-z_0-9]+$/.test(c));
  const cols = ["symbol", "side", "leverage", "note", "mark_price", "executed", "validated", "conviction", "conviction_score", "source", "sim_version", "btc_regime", "time", ...stampCols];
  const vals: unknown[] = [p.symbol, p.side, p.leverage ?? 2, `${p.note ?? `auto: ${p.source} breakout 4h`} (retest of $${p.level} filled)`, entryPx, false, false, p.conviction, p.conviction_score, p.source, SIM_VERSION, p.btc_regime, new Date((bar.t + 60) * 1000), ...stampCols.map((c) => (p.stamps as Record<string, unknown>)[c])];
  const placeholders = vals.map((_, k) => (cols[k] === "time" ? `$${k + 1}::timestamptz` : `$${k + 1}`)).join(",");
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(`INSERT INTO tradingview_alerts (${cols.join(", ")}) VALUES (${placeholders}) RETURNING id`, ...vals);
  const id = rows[0]?.id ?? null;
  if (id != null) await snapshotShadowSizing(id, false).catch(() => null);
  return id;
}

export interface PendingResolveResult { checked: number; filled: string[]; failed: string[]; expired: string[]; errors: string[] }

/** Runs at the top of each scan tick. Walks new completed 1-min bars for ≤ RESOLVE_MAX_SYMBOLS pending rows, inside the deadline. */
export async function resolvePendingEntries(opts: { deadlineMs?: number; now?: number } = {}): Promise<PendingResolveResult> {
  const out: PendingResolveResult = { checked: 0, filled: [], failed: [], expired: [], errors: [] };
  await ensureMarginTables();
  const nowMs = opts.now ?? Date.now();
  // Expiry first — it needs no bars and must not wait behind the rate limit.
  const expired = await prisma.$queryRawUnsafe<{ id: number; symbol: string; source: string }[]>(
    `UPDATE margin_pending_entries SET status='expired', resolved_at=now(), reason='no retest within ${PENDING_TTL_H}h'
     WHERE status='pending' AND expires_at <= $1::timestamptz RETURNING id, symbol, source`, new Date(nowMs),
  );
  for (const e of expired) out.expired.push(`${e.symbol} ${e.source}`);
  const rows = await prisma.$queryRawUnsafe<PendingRow[]>(
    `SELECT id, created_at, symbol, side, source, level, leverage, conviction, conviction_score, note, stamps, btc_regime, expires_at, last_checked_t
     FROM margin_pending_entries WHERE status='pending' ORDER BY created_at ASC LIMIT $1`, RESOLVE_MAX_SYMBOLS,
  );
  for (const p of rows) {
    if (opts.deadlineMs != null && opts.deadlineMs - Date.now() < RESOLVE_MIN_BUDGET_MS) { out.errors.push("pending resolver: out of route budget"); break; }
    try {
      const since = Math.max(p.created_at.getTime() / 1000, p.last_checked_t ?? 0) - 60;
      const raw = await getKrakenOHLC(p.symbol, 1, since);
      const dedup = raw.filter((b, i) => i === raw.length - 1 || raw[i + 1].t !== b.t);
      // Completed bars only, and only those after the pierce and after the last walk: the in-progress
      // bar's close can still change, and no bar is judged twice.
      const nowSec = nowMs / 1000;
      const bars = dedup.filter((b) => b.t + 60 <= nowSec && b.t >= p.created_at.getTime() / 1000 && b.t > (p.last_checked_t ?? 0) && b.t + 60 <= p.expires_at.getTime() / 1000);
      out.checked++;
      const r = retestTriggered(bars, p.level, p.side);
      const lastT = bars.length ? bars[bars.length - 1].t : (p.last_checked_t ?? 0);
      if (r.outcome === "fill") {
        const alertId = await openFilledRow(p, r.bar);
        await prisma.$executeRawUnsafe(`UPDATE margin_pending_entries SET status='filled', resolved_at=now(), fill_px=$2, fill_t=$3, alert_id=$4, last_checked_t=$5, reason='retest held' WHERE id=$1 AND status='pending'`, p.id, r.bar.c, r.bar.t, alertId, r.bar.t);
        out.filled.push(`${p.symbol} ${p.source}`);
      } else if (r.outcome === "fail") {
        await prisma.$executeRawUnsafe(`UPDATE margin_pending_entries SET status='failed', resolved_at=now(), fill_t=$2, last_checked_t=$3, reason='closed ${(RETEST_BAND * 100).toFixed(1)}% through the level' WHERE id=$1 AND status='pending'`, p.id, r.bar.t, r.bar.t);
        out.failed.push(`${p.symbol} ${p.source}`);
      } else if (bars.length) {
        await prisma.$executeRawUnsafe(`UPDATE margin_pending_entries SET last_checked_t=$2 WHERE id=$1 AND status='pending'`, p.id, lastT);
      }
    } catch (e) { out.errors.push(`${p.symbol}: ${String(e).slice(0, 80)}`); }
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

export interface PendingSummary { source: string; queued: number; pending: number; filled: number; failed: number; expired: number; fillRate: number | null }

/** The queue's tally per source — the first kill rule of swing-retest reads `fillRate` at ≥40 queued. */
export async function pendingSummary(): Promise<PendingSummary[]> {
  await ensureMarginTables();
  const rows = await prisma.$queryRawUnsafe<{ source: string; status: string; n: bigint }[]>(`SELECT source, status, count(*)::bigint AS n FROM margin_pending_entries GROUP BY 1, 2`);
  const by = new Map<string, PendingSummary>();
  for (const r of rows) {
    const s = by.get(r.source) ?? { source: r.source, queued: 0, pending: 0, filled: 0, failed: 0, expired: 0, fillRate: null };
    const n = Number(r.n);
    s.queued += n;
    if (r.status === "pending") s.pending += n; else if (r.status === "filled") s.filled += n; else if (r.status === "failed") s.failed += n; else if (r.status === "expired") s.expired += n;
    by.set(r.source, s);
  }
  for (const s of by.values()) { const done = s.filled + s.failed + s.expired; s.fillRate = done > 0 ? s.filled / done : null; }
  return [...by.values()];
}
