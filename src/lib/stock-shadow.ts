// STOCK PAPER BOOK — the I/O half: the table, opening paper trades, the 1-minute candle
// walk that resolves them, and the scoreboard queries. The model (universe, sleeves,
// sizing, costs, verdict) is in stock-paper-model.ts and is pure.
//
// Measurement mirrors margin-shadow.ts on purpose (sequential walk, stop-first within a
// bar, gap-aware fills at the bar open, in-progress bar touch-only, per-trade seen_t so
// no bar is scored twice, breakeven at +1R then a 1R trail). Differences are the stock
// facts: regular-session bars only, no rollover, margin interest instead, no commission.
import { prisma } from "@/lib/db";
import { getStockBars } from "@/lib/stock-bars";
import {
  STOCK_COHORT_SQL, STOCK_SIM_VERSION, STOCK_SOURCE_LABELS,
  stockCostFrac, stockEntryPrice, stockExitParams, stockNotional, stockRiskFraction, stockTimeStopHit, stockVerdict, tStatOf,
} from "@/lib/stock-paper-model";

// Raw-SQL table (like tradingview_alerts / kraken_my_trades): NEVER prisma-managed, so a
// schema push can't drop it. Created on first use.
export async function ensureStockPaperTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS stock_paper_trades (
    id serial PRIMARY KEY,
    time timestamptz DEFAULT now(),
    symbol text NOT NULL,
    side text NOT NULL,
    source text NOT NULL,
    timeframe text,
    conviction text,
    conviction_score double precision,
    entry double precision NOT NULL,
    notional double precision NOT NULL,
    stop double precision,
    peak double precision,
    seen_t double precision,
    status text DEFAULT 'open',
    exit double precision,
    pnl double precision,
    fees double precision,
    unrealized double precision,
    reason text,
    resolved_at timestamptz,
    sim_version text
  )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS stock_paper_trades_open_idx ON stock_paper_trades (status, symbol)`);
  // ONE open trade per (sleeve, symbol, cohort), enforced by the database — two
  // overlapping invocations (a manual run beside the schedule) both pass the SELECT
  // check; only one of them can win this index. The loser's insert throws and is
  // reported as "already open", so the sample can never be inflated by duplicates.
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS stock_paper_one_open_idx ON stock_paper_trades (symbol, source, sim_version) WHERE status='open'`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS stock_scan_signals (
    id serial PRIMARY KEY,
    ts timestamptz DEFAULT now(),
    symbol text,
    timeframe text,
    kind text,
    detail text,
    price double precision
  )`);
}

// Config: reference equity + base risk for sizing. Defaults ≈ a $5k book, like the crypto
// desk, so the two records read on the same dollar scale. `stock_paper_autotrack=false`
// stops NEW paper entries (open ones still resolve).
async function cfgNum(key: string, fallback: number): Promise<number> {
  const v = await prisma.agentConfig.findUnique({ where: { key } })
    .then((r) => (r?.value ? parseFloat(r.value) : NaN)).catch(() => NaN);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
export async function stockSizingParams(): Promise<{ refEquity: number; baseRiskPct: number }> {
  return {
    refEquity: await cfgNum("stock_paper_ref_equity", 5000),
    baseRiskPct: await cfgNum("stock_paper_max_risk_pct", 3),
  };
}

// Open ONE paper trade per (source, symbol) at a time — entries can't stack within a
// sleeve. Returns false when one is already open. Entry pays the 0.05% chase.
export async function openStockPaperTrade(p: {
  symbol: string; source: string; timeframe: string; conviction: string; score: number; signalPrice: number;
}): Promise<boolean> {
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM stock_paper_trades WHERE symbol=$1 AND source=$2 AND status='open' AND ${STOCK_COHORT_SQL}`,
    p.symbol, p.source,
  );
  if (Number(n) > 0) return false;
  const { refEquity, baseRiskPct } = await stockSizingParams();
  const entry = stockEntryPrice(p.signalPrice);
  const notional = stockNotional(p.source, refEquity, stockRiskFraction(baseRiskPct, p.conviction));
  if (!(entry > 0) || !(notional > 0)) return false;
  const { oneRPct } = stockExitParams(p.source);
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_paper_trades (symbol, side, source, timeframe, conviction, conviction_score, entry, notional, stop, peak, status, sim_version)
       VALUES ($1,'buy',$2,$3,$4,$5,$6,$7,$8,$6,'open',$9)`,
      p.symbol, p.source, p.timeframe, p.conviction, p.score, entry, notional, entry * (1 - oneRPct), STOCK_SIM_VERSION,
    );
  } catch (e) {
    // Unique-index race (see ensureStockPaperTable): another run opened it first.
    if (/stock_paper_one_open_idx|unique/i.test(String(e))) return false;
    throw e;
  }
  return true;
}

export interface StockResolution {
  id: number; symbol: string; source: string; entry: number; exit: number; pnl: number; pnlPct: number; reason: string; conviction: string | null;
}
interface OpenRow {
  id: number; time: Date; symbol: string; source: string; entry: number; notional: number;
  stop: number | null; peak: number | null; seen_t: number | null; conviction: string | null;
}

// Walk every open paper trade over the 1-minute bars it has lived through since the last
// run and resolve the ones that hit a stop or the time limit. Long-only, so dir = +1.
export async function evaluateStockPaper(): Promise<StockResolution[]> {
  await ensureStockPaperTable();
  const { refEquity } = await stockSizingParams();
  const rows = await prisma.$queryRawUnsafe<OpenRow[]>(
    `SELECT id, time, symbol, source, entry, notional, stop, peak, seen_t, conviction
     FROM stock_paper_trades WHERE status='open' AND entry > 0 ORDER BY time ASC LIMIT 300`,
  );
  if (!rows.length) return [];

  // One Yahoo call per symbol for 1-minute bars back to the OLDEST unscored moment among
  // that symbol's trades (a trade opened at yesterday's close needs today's open bars),
  // never less than the last 2 hours. Yahoo's 1-minute history reaches back 7 days, so
  // the request is floored there — and any trade whose unscored moment is OLDER than that
  // floor has a COVERAGE GAP (the cron was down for a week): bars it lived through are
  // gone, so its outcome cannot be known. Such a trade is VOIDED (excluded from every
  // statistic, shown in the log with the reason) rather than walked from the wrong
  // starting point and scored as if nothing happened in between.
  const nowS = Date.now() / 1000;
  const YAHOO_1M_FLOOR_S = nowS - 6.5 * 24 * 3600;
  const bySym: Record<string, OpenRow[]> = {};
  for (const r of rows) (bySym[r.symbol] ||= []).push(r);
  const barsBySym: Record<string, { t: number; o: number; h: number; l: number; c: number }[]> = {};
  const price: Record<string, number> = {};
  const unscoredFrom = (r: OpenRow) => r.seen_t ?? r.time.getTime() / 1000;
  for (const [sym, trades] of Object.entries(bySym)) {
    const oldest = Math.min(...trades.map(unscoredFrom).filter((t) => t >= YAHOO_1M_FLOOR_S));
    if (!Number.isFinite(oldest)) continue;   // every trade on this symbol is gapped — voided below
    const since = Math.max(YAHOO_1M_FLOOR_S, Math.min(oldest - 60, nowS - 2 * 3600));
    try {
      const bars = await getStockBars(sym, "1m", since * 1000);
      if (bars.length) { barsBySym[sym] = bars; price[sym] = bars[bars.length - 1].c; }
    } catch { /* skip this symbol this run */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  const resolved: StockResolution[] = [];
  for (const r of rows) {
    const entry = r.entry;
    const { oneRPct } = stockExitParams(r.source);
    const oneR = entry * oneRPct;
    const ageH = (Date.now() - r.time.getTime()) / 3600_000;
    const timeStopLabel = r.source === "stock-swing" ? "time stop (~10 sessions)" : "time stop (next close)";
    const timeStopHit = stockTimeStopHit(r.source, r.time, new Date());
    const now = price[r.symbol];

    if (unscoredFrom(r) < YAHOO_1M_FLOOR_S - 60) {
      await prisma.$executeRawUnsafe(
        `UPDATE stock_paper_trades SET status='void', reason=$1, resolved_at=now(), unrealized=NULL WHERE id=$2 AND status='open'`,
        `voided — coverage gap: no evaluation for ${(ageH / 24).toFixed(0)} days, 1-minute history unavailable`, r.id,
      );
      continue;
    }

    if (!(now > 0)) {
      // Unpriceable this run: still honor the time stop so nothing sits open forever.
      if (timeStopHit) {
        const feeFrac = stockCostFrac(r.notional, refEquity, ageH);
        const pnl = -feeFrac * r.notional;
        const affected = await prisma.$executeRawUnsafe(
          `UPDATE stock_paper_trades SET status='resolved', exit=$1, pnl=$2, fees=$3, reason=$4, resolved_at=now(), unrealized=NULL WHERE id=$5 AND status='open'`,
          entry, pnl, feeFrac * r.notional, `${timeStopLabel} (no price)`, r.id,
        );
        if (affected > 0) resolved.push({ id: r.id, symbol: r.symbol, source: r.source, entry, exit: entry, pnl, pnlPct: -feeFrac, reason: `${timeStopLabel} (no price)`, conviction: r.conviction });
      }
      continue;
    }

    // Bars this trade has lived through and not yet scored. Drop the entry bar (its low is
    // pre-break by construction); the newest bar is in-progress → touch-only, not seen.
    const tOpen = r.time.getTime() / 1000;
    const seenT = r.seen_t ?? 0;
    const tb = (barsBySym[r.symbol] ?? []).filter((b) => b.t >= tOpen && b.t >= seenT);
    const doneBars = tb.slice(0, -1);
    const liveBar = tb.length ? tb[tb.length - 1] : null;
    const nextSeenT = liveBar ? liveBar.t : seenT;

    let peak = r.peak ?? entry;
    let stopPx = r.stop ?? entry - oneR;
    let exit: number | null = null;
    let reason = "";
    const ratchet = () => {
      if ((peak - entry) / oneR >= 1) {
        stopPx = Math.max(stopPx, Math.max(entry, peak - oneR));   // breakeven, then trail 1R; never loosen
      }
    };
    for (const b of doneBars) {
      if (b.l <= stopPx) {
        exit = Math.min(stopPx, b.o);   // gap-aware: an open below the stop fills at the open
        reason = (peak - entry) / oneR >= 1 ? "trailing stop" : "initial stop";
        break;
      }
      peak = Math.max(peak, b.h);
      ratchet();
    }
    if (exit == null && liveBar && liveBar.l <= stopPx) {
      exit = Math.min(stopPx, liveBar.o);
      reason = (peak - entry) / oneR >= 1 ? "trailing stop" : "initial stop";
    }
    if (exit == null && tb.length === 0) {
      peak = Math.max(peak, now);
      ratchet();
      if (now <= stopPx) { exit = Math.min(stopPx, now); reason = (peak - entry) / oneR >= 1 ? "trailing stop" : "initial stop"; }
    }
    if (exit == null && timeStopHit) { exit = now; reason = timeStopLabel; }

    if (exit == null) {
      const uNet = (now - entry) / entry - stockCostFrac(r.notional, refEquity, ageH);
      await prisma.$executeRawUnsafe(
        `UPDATE stock_paper_trades SET peak=$1, stop=$2, unrealized=$3, seen_t=$4 WHERE id=$5 AND status='open'`,
        peak, stopPx, uNet * r.notional, nextSeenT, r.id,
      );
      continue;
    }

    const grossPct = (exit - entry) / entry;
    const feeFrac = stockCostFrac(r.notional, refEquity, ageH);
    const netPct = grossPct - feeFrac;
    const pnl = netPct * r.notional;
    const affected = await prisma.$executeRawUnsafe(
      `UPDATE stock_paper_trades SET status='resolved', exit=$1, pnl=$2, fees=$3, reason=$4, resolved_at=now(), peak=$5, stop=$6, unrealized=NULL WHERE id=$7 AND status='open'`,
      exit, pnl, feeFrac * r.notional, reason, peak, stopPx, r.id,
    );
    if (affected === 0) continue;
    resolved.push({ id: r.id, symbol: r.symbol, source: r.source, entry, exit, pnl, pnlPct: netPct, reason, conviction: r.conviction });
  }
  return resolved;
}

// ---------- Scoreboard ----------
export interface StockScore {
  resolved: number; wins: number; hitRate: number | null; totalPnl: number; fees: number;
  avgWin: number; avgLoss: number; open: number; openUnrealized: number;
  voided: number;   // outcome unknowable (coverage gap) — excluded from every statistic, shown so it is never silent
  byConviction: { tier: string; resolved: number; wins: number; hitRate: number | null; totalPnl: number }[];
}
export async function stockScore(): Promise<StockScore> {
  await ensureStockPaperTable();
  const [agg] = await prisma.$queryRawUnsafe<{ resolved: bigint; wins: bigint; total: number | null; fees: number | null; open: bigint; voided: bigint; openfloat: number | null; avgwin: number | null; avgloss: number | null }[]>(
    `SELECT
       count(*) FILTER (WHERE status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE status='resolved' AND pnl > 0)::bigint AS wins,
       COALESCE(sum(pnl) FILTER (WHERE status='resolved'),0)::float AS total,
       COALESCE(sum(fees) FILTER (WHERE status='resolved'),0)::float AS fees,
       count(*) FILTER (WHERE status='open')::bigint AS open,
       count(*) FILTER (WHERE status='void')::bigint AS voided,
       COALESCE(sum(unrealized) FILTER (WHERE status='open'),0)::float AS openfloat,
       avg(pnl) FILTER (WHERE status='resolved' AND pnl > 0) AS avgwin,
       avg(pnl) FILTER (WHERE status='resolved' AND pnl <= 0) AS avgloss
     FROM stock_paper_trades WHERE ${STOCK_COHORT_SQL}`,
  );
  const tiers = await prisma.$queryRawUnsafe<{ tier: string; resolved: bigint; wins: bigint; total: number | null }[]>(
    `SELECT COALESCE(conviction,'untagged') AS tier, count(*)::bigint AS resolved,
       count(*) FILTER (WHERE pnl > 0)::bigint AS wins, COALESCE(sum(pnl),0)::float AS total
     FROM stock_paper_trades WHERE status='resolved' AND ${STOCK_COHORT_SQL} GROUP BY 1`,
  );
  const order: Record<string, number> = { high: 0, med: 1, low: 2 };
  const resolved = Number(agg.resolved);
  return {
    resolved, wins: Number(agg.wins), hitRate: resolved > 0 ? Number(agg.wins) / resolved : null,
    totalPnl: agg.total || 0, fees: agg.fees || 0, avgWin: agg.avgwin || 0, avgLoss: agg.avgloss || 0,
    open: Number(agg.open), openUnrealized: agg.openfloat || 0, voided: Number(agg.voided),
    byConviction: tiers.map((t) => ({ tier: t.tier, resolved: Number(t.resolved), wins: Number(t.wins), hitRate: Number(t.resolved) > 0 ? Number(t.wins) / Number(t.resolved) : null, totalPnl: t.total || 0 }))
      .sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9)),
  };
}

export interface StockStrategyStat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null; expectancy: number | null;
  totalPnl: number; grossPnl: number; fees: number; open: number; peakedGreen: number; days: number; tStat: number | null; verdict: string;
}
export async function stockStrategyBreakdown(): Promise<StockStrategyStat[]> {
  await ensureStockPaperTable();
  const rows = await prisma.$queryRawUnsafe<{
    source: string; resolved: bigint; wins: bigint; total: number | null; fees: number | null; open: bigint;
    peaked: bigint; days: bigint; meanpnl: number | null; stdpnl: number | null;
  }[]>(
    `SELECT source,
       count(*) FILTER (WHERE status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE status='resolved' AND pnl > 0)::bigint AS wins,
       COALESCE(sum(pnl) FILTER (WHERE status='resolved'),0)::float AS total,
       COALESCE(sum(fees) FILTER (WHERE status='resolved'),0)::float AS fees,
       count(*) FILTER (WHERE status='open')::bigint AS open,
       count(*) FILTER (WHERE status='resolved' AND peak IS NOT NULL AND peak > entry)::bigint AS peaked,
       count(DISTINCT date_trunc('day', resolved_at)) FILTER (WHERE status='resolved')::bigint AS days,
       avg(pnl) FILTER (WHERE status='resolved') AS meanpnl,
       stddev_samp(pnl) FILTER (WHERE status='resolved') AS stdpnl
     FROM stock_paper_trades WHERE ${STOCK_COHORT_SQL} GROUP BY source`,
  );
  return rows.map((r) => {
    const resolved = Number(r.resolved);
    const net = r.total || 0;
    const t = tStatOf(r.meanpnl, r.stdpnl, resolved);
    return {
      key: r.source,
      label: STOCK_SOURCE_LABELS[r.source as keyof typeof STOCK_SOURCE_LABELS] ?? r.source,
      resolved, wins: Number(r.wins), hitRate: resolved > 0 ? Number(r.wins) / resolved : null,
      expectancy: resolved > 0 ? net / resolved : null,
      totalPnl: net, grossPnl: net + (r.fees || 0), fees: r.fees || 0, open: Number(r.open),
      peakedGreen: Number(r.peaked), days: Number(r.days), tStat: t,
      verdict: stockVerdict(resolved, net, t, Number(r.days)),
    };
  }).sort((a, b) => b.resolved - a.resolved);
}

export interface StockPaperRow {
  id: number; time: string; symbol: string; source: string; timeframe: string | null; conviction: string | null;
  entry: number; notional: number; exit: number | null; pnl: number | null; unrealized: number | null;
  fees: number | null; status: string; reason: string | null; stop: number | null; peak: number | null;
}
export async function recentStockPaperTrades(limit = 100): Promise<StockPaperRow[]> {
  await ensureStockPaperTable();
  const rows = await prisma.$queryRawUnsafe<{
    id: number; time: Date; symbol: string; source: string; timeframe: string | null; conviction: string | null;
    entry: number; notional: number; exit: number | null; pnl: number | null; unrealized: number | null;
    fees: number | null; status: string | null; reason: string | null; stop: number | null; peak: number | null;
  }[]>(
    `SELECT id, time, symbol, source, timeframe, conviction, entry, notional, exit, pnl, unrealized, fees, status, reason, stop, peak
     FROM stock_paper_trades ORDER BY time DESC LIMIT $1`,
    Math.max(1, Math.min(500, limit)),
  );
  return rows.map((r) => ({
    id: r.id, time: r.time.toISOString(), symbol: r.symbol, source: r.source, timeframe: r.timeframe, conviction: r.conviction,
    entry: r.entry, notional: r.notional, exit: r.exit, pnl: r.pnl,
    unrealized: r.status === "resolved" ? null : r.unrealized, fees: r.fees,
    status: r.status ?? "open", reason: r.reason, stop: r.stop, peak: r.peak,
  }));
}
