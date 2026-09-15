// PENDING (CONDITIONAL) PAPER ENTRIES (C5b, Sep 15 2026) — the `swing-retest` twin.
//
// The prompt's "conditional entry": a 4h breakout is not chased at the pierce; it is QUEUED with
// the pierced 20-bar level and opened only if price comes back to that level and holds. The rule,
// registered in docs/KRAKEN-DESK-OPERATING-MODEL.md §4 (corrected in review before the resolver
// ever ran in production):
//
//   arm    — first, a completed 1-min bar must CLOSE above level × (1 + RETEST_BAND): price has
//            left the level. Without this, the first bar after the pierce, still sitting on the
//            level, would "retest" it instantly — that is a chase, not a retest.
//   fill   — once armed, the first completed bar whose low touches ≤ level × (1 + band) AND that
//            closes above the level. The paper row opens at that close, chased 0.1%.
//   fail   — any completed bar that closes below level × (1 − band): the breakout failed.
//   expire — PENDING_TTL_H hours after the pierce with neither.
//
// The resolver runs at the TOP of each margin-scan tick on at most RESOLVE_MAX_SYMBOLS rows, under
// its own RESOLVE_BUDGET_MS wall clock, walking only bars it has not walked (last_checked_t). A
// hole in that walk (first new bar more than 2 min after the last one seen) EXPIRES the row with
// reason 'coverage gap' rather than judging a retest it did not watch. A fill is CLAIMED first
// (status 'filling') so two overlapping ticks can never open the row twice. Its fill rate is the
// twin's first kill rule (< 25% after 40 queued), so every outcome is a row.
import { prisma } from "@/lib/db";
import { ensureMarginTables, getKrakenOHLC, type KrakenBar } from "@/lib/kraken-margin";
import { SIM_VERSION, snapshotShadowSizing } from "@/lib/margin-shadow";

export const RETEST_BAND = 0.005;          // 0.5% either side of the level
export const PENDING_TTL_H = 24;
export const RESOLVE_MAX_SYMBOLS = 10;
export const RESOLVE_BUDGET_MS = 20_000;   // the resolver's own wall clock — the scan's 130 calls come after it
export const OHLC_TIMEOUT_MS = 8_000;
export const COVERAGE_GAP_SEC = 120;       // a first new bar later than this after the last walked one is a hole
const CHASE = 0.001;

export type RetestOutcome = ({ outcome: "fill"; bar: KrakenBar } | { outcome: "fail"; bar: KrakenBar } | { outcome: "none" }) & { armed: boolean };

/**
 * PURE. Walk completed 1-min bars oldest-first from the row's `armed` state and return the first
 * decisive bar plus the armed state after the walk. A bar that closes through the level by more
 * than the band FAILS whatever the state; a close above the band ARMS; an armed touch that closes
 * on the trade's side FILLS. The arming bar itself never fills (price must come BACK).
 */
export function retestTriggered(bars: { t: number; o: number; h: number; l: number; c: number }[], level: number, side: "buy" | "sell", armedInitially = false, band = RETEST_BAND): RetestOutcome {
  let armed = armedInitially;
  if (!(level > 0)) return { outcome: "none", armed };
  const hi = level * (1 + band), lo = level * (1 - band);
  for (const b of bars) {
    if (side === "buy") {
      if (b.c < lo) return { outcome: "fail", bar: b as KrakenBar, armed };
      if (!armed) { if (b.c > hi) armed = true; continue; }
      if (b.l <= hi && b.c > level) return { outcome: "fill", bar: b as KrakenBar, armed };
    } else {
      if (b.c > hi) return { outcome: "fail", bar: b as KrakenBar, armed };
      if (!armed) { if (b.c < lo) armed = true; continue; }
      if (b.h >= lo && b.c < level) return { outcome: "fill", bar: b as KrakenBar, armed };
    }
  }
  return { outcome: "none", armed };
}

/** PURE. The walk must be contiguous: the first new completed bar may open at most COVERAGE_GAP_SEC after the last one walked. */
export function coverageGap(firstNewBarT: number | undefined, lastCheckedT: number | null | undefined, gapSec = COVERAGE_GAP_SEC): boolean {
  if (firstNewBarT == null || lastCheckedT == null || !(lastCheckedT > 0)) return false;
  return firstNewBarT > lastCheckedT + gapSec;
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
    `SELECT count(*)::bigint AS n FROM margin_pending_entries WHERE symbol=$1 AND source=$2 AND status IN ('pending','filling')`, i.symbol, i.source,
  );
  if (Number(n) > 0) return { queued: false, id: null, why: `${i.source} already waiting on ${i.symbol}` };
  const stamps: Record<string, unknown> = {};
  i.stamps.columns.forEach((c, k) => { stamps[c] = i.stamps.values[k] ?? null; });
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO margin_pending_entries (symbol, side, source, level, leverage, conviction, conviction_score, note, stamps, btc_regime, expires_at, status, last_checked_t, armed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10, now() + ($11 || ' hours')::interval, 'pending', extract(epoch from now()), false) RETURNING id`,
    i.symbol, i.side, i.source, i.level, i.leverage, i.conviction, i.convictionScore, i.note, JSON.stringify(stamps), i.btcRegime, String(PENDING_TTL_H),
  );
  return { queued: true, id: rows[0]?.id ?? null };
}

interface PendingRow {
  id: number; created_at: Date; symbol: string; side: "buy" | "sell"; source: string; level: number; leverage: number | null;
  conviction: string | null; conviction_score: number | null; note: string | null; stamps: Record<string, unknown> | null;
  btc_regime: string | null; expires_at: Date; last_checked_t: number | null; armed: boolean | null;
}

/** The paper row a filled retest opens: source swing-retest, entry = the fill bar's close chased, time = that bar's close. Sized STRICTLY; throws if sizing config is unusable. */
async function openFilledRow(p: PendingRow, bar: KrakenBar): Promise<number> {
  const entryPx = p.side === "buy" ? bar.c * (1 + CHASE) : bar.c * (1 - CHASE);
  const stampCols = Object.keys(p.stamps ?? {}).filter((c) => /^[a-z_0-9]+$/.test(c));
  const cols = ["symbol", "side", "leverage", "note", "mark_price", "executed", "validated", "conviction", "conviction_score", "source", "sim_version", "btc_regime", "time", ...stampCols];
  const vals: unknown[] = [p.symbol, p.side, p.leverage ?? 2, `${p.note ?? `auto: ${p.source} breakout 4h`} (retest of $${p.level} filled)`, entryPx, false, false, p.conviction, p.conviction_score, p.source, SIM_VERSION, p.btc_regime, new Date((bar.t + 60) * 1000), ...stampCols.map((c) => (p.stamps as Record<string, unknown>)[c])];
  const placeholders = vals.map((_, k) => (cols[k] === "time" ? `$${k + 1}::timestamptz` : `$${k + 1}`)).join(",");
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(`INSERT INTO tradingview_alerts (${cols.join(", ")}) VALUES (${placeholders}) RETURNING id`, ...vals);
  const id = rows[0]?.id;
  if (id == null) throw new Error("alert row not created");
  try {
    await snapshotShadowSizing(id, true);   // strict: unusable sizing config throws, and the row is withdrawn below
  } catch (e) {
    await prisma.$executeRawUnsafe(`DELETE FROM tradingview_alerts WHERE id=$1 AND shadow_notional IS NULL AND COALESCE(shadow_status,'open')='open'`, id).catch(() => {});
    throw e;
  }
  return id;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export interface PendingResolveResult { checked: number; filled: string[]; failed: string[]; expired: string[]; errors: string[]; stoppedForBudget: boolean }

/** Runs at the top of each scan tick. Walks new completed 1-min bars for ≤ RESOLVE_MAX_SYMBOLS pending rows under its own wall clock. */
export async function resolvePendingEntries(opts: { budgetMs?: number; now?: number } = {}): Promise<PendingResolveResult> {
  const out: PendingResolveResult = { checked: 0, filled: [], failed: [], expired: [], errors: [], stoppedForBudget: false };
  const t0 = Date.now();
  const budget = opts.budgetMs ?? RESOLVE_BUDGET_MS;
  await ensureMarginTables();
  const nowMs = opts.now ?? Date.now();
  // Expiry first — it needs no bars and must not wait behind the rate limit.
  const expired = await prisma.$queryRawUnsafe<{ id: number; symbol: string; source: string }[]>(
    `UPDATE margin_pending_entries SET status='expired', resolved_at=now(), reason='no retest within ${PENDING_TTL_H}h'
     WHERE status='pending' AND expires_at <= $1::timestamptz RETURNING id, symbol, source`, new Date(nowMs),
  );
  for (const e of expired) out.expired.push(`${e.symbol} ${e.source}`);
  const rows = await prisma.$queryRawUnsafe<PendingRow[]>(
    `SELECT id, created_at, symbol, side, source, level, leverage, conviction, conviction_score, note, stamps, btc_regime, expires_at, last_checked_t, armed
     FROM margin_pending_entries WHERE status='pending' ORDER BY created_at ASC LIMIT $1`, RESOLVE_MAX_SYMBOLS,
  );
  for (const p of rows) {
    if (Date.now() - t0 >= budget) { out.stoppedForBudget = true; out.errors.push(`pending resolver: stopped after ${out.checked} rows (${budget / 1000}s budget)`); break; }
    try {
      const since = Math.max(p.created_at.getTime() / 1000, p.last_checked_t ?? 0) - 60;
      const raw = await withTimeout(getKrakenOHLC(p.symbol, 1, since), OHLC_TIMEOUT_MS, `${p.symbol} 1-min OHLC`);
      const dedup = raw.filter((b, i) => i === raw.length - 1 || raw[i + 1].t !== b.t);
      // Completed bars only, and only those after the pierce and after the last walk: the in-progress
      // bar's close can still change, and no bar is judged twice.
      const nowSec = nowMs / 1000;
      const bars = dedup.filter((b) => b.t + 60 <= nowSec && b.t >= p.created_at.getTime() / 1000 && b.t > (p.last_checked_t ?? 0) && b.t + 60 <= p.expires_at.getTime() / 1000);
      out.checked++;
      if (!bars.length) continue;
      if (coverageGap(bars[0].t, p.last_checked_t)) {
        // A hole in the walk: whatever happened inside it was not watched. Never judge a retest blind.
        await prisma.$executeRawUnsafe(`UPDATE margin_pending_entries SET status='expired', resolved_at=now(), reason='coverage gap' WHERE id=$1 AND status='pending'`, p.id);
        out.expired.push(`${p.symbol} ${p.source} (coverage gap)`);
        continue;
      }
      const r = retestTriggered(bars, p.level, p.side, p.armed === true);
      const lastT = bars[bars.length - 1].t;
      if (r.outcome === "fill") {
        // CLAIM first: only the tick that flips pending → filling opens the row.
        const claimed = await prisma.$queryRawUnsafe<{ id: number }[]>(`UPDATE margin_pending_entries SET status='filling' WHERE id=$1 AND status='pending' RETURNING id`, p.id);
        if (!claimed.length) continue;
        let alertId: number;
        try { alertId = await openFilledRow(p, r.bar); }
        catch (e) {
          // Withdraw the claim: the row stays pending and the next tick retries (sizing config, DB).
          await prisma.$executeRawUnsafe(`UPDATE margin_pending_entries SET status='pending', armed=$2 WHERE id=$1 AND status='filling'`, p.id, r.armed).catch(() => {});
          throw e;
        }
        await prisma.$executeRawUnsafe(`UPDATE margin_pending_entries SET status='filled', resolved_at=now(), fill_px=$2, fill_t=$3, alert_id=$4, last_checked_t=$5, armed=true, reason='retest held' WHERE id=$1 AND status='filling'`, p.id, r.bar.c, r.bar.t, alertId, r.bar.t);
        out.filled.push(`${p.symbol} ${p.source}`);
      } else if (r.outcome === "fail") {
        await prisma.$executeRawUnsafe(`UPDATE margin_pending_entries SET status='failed', resolved_at=now(), fail_t=$2, last_checked_t=$3, armed=$4, reason='closed ${(RETEST_BAND * 100).toFixed(1)}% through the level' WHERE id=$1 AND status='pending'`, p.id, r.bar.t, r.bar.t, r.armed);
        out.failed.push(`${p.symbol} ${p.source}`);
      } else {
        await prisma.$executeRawUnsafe(`UPDATE margin_pending_entries SET last_checked_t=$2, armed=$3 WHERE id=$1 AND status='pending'`, p.id, lastT, r.armed);
      }
    } catch (e) { out.errors.push(`${p.symbol}: ${String(e).slice(0, 80)}`); }
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

export interface PendingSummary { source: string; queued: number; pending: number; filled: number; failed: number; expired: number; fillRate: number | null }

/** The queue's tally per source — the first kill rule of swing-retest reads `fillRate` at ≥40 queued (read by hand from the statistics file; nothing acts on it automatically). */
export async function pendingSummary(): Promise<PendingSummary[]> {
  await ensureMarginTables();
  const rows = await prisma.$queryRawUnsafe<{ source: string; status: string; n: bigint }[]>(`SELECT source, status, count(*)::bigint AS n FROM margin_pending_entries GROUP BY 1, 2`);
  const by = new Map<string, PendingSummary>();
  for (const r of rows) {
    const s = by.get(r.source) ?? { source: r.source, queued: 0, pending: 0, filled: 0, failed: 0, expired: 0, fillRate: null };
    const n = Number(r.n);
    s.queued += n;
    if (r.status === "pending" || r.status === "filling") s.pending += n; else if (r.status === "filled") s.filled += n; else if (r.status === "failed") s.failed += n; else if (r.status === "expired") s.expired += n;
    by.set(r.source, s);
  }
  for (const s of by.values()) { const done = s.filled + s.failed + s.expired; s.fillRate = done > 0 ? s.filled / done : null; }
  return [...by.values()];
}
