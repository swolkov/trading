// OPTIONS PAPER BOOK — the I/O half: the table, opening paper positions, marking them from
// real option quotes, resolving them, and the scoreboard queries. The model (universe,
// sleeves, contract selection, caps, signal, exits, verdict) is in options-paper-model.ts
// and is pure.
//
// HOW THIS BOOK MEASURES, and why it is more honest than the July 2026 options research:
// that work priced entries with a Black-Scholes model because no historical options data
// was affordable, which left its verdict arguable. This book never models a price. It buys
// at the quoted ASK and sells at the quoted BID, both from the live NBBO, so the dominant
// cost — the spread — is observed rather than assumed. The trade-off is that it can only
// measure FORWARD, which at two entries per sleeve per month means roughly 15 months to a
// 30-trade verdict. That is stated on the page rather than hidden.
//
// ISOLATION: raw-SQL table (never prisma-managed, so a schema push cannot drop it), config
// keys prefixed `options_paper_`, and no import from any margin-* or kraken-* module. This
// book cannot affect the Kraken margin system.
import { prisma } from "@/lib/db";
import { getDailyBars, getOptionQuotes, type OptionQuote } from "@/lib/alpaca-options";
import {
  OPTIONS_COHORT_SQL, OPTIONS_SIM_VERSION, OPTION_SOURCE_LABELS, OPTION_SOURCE_EQUITY,
  type BookState, type OptionSource,
  dteOf, entryRefusal, exitProceedsUsd, exitReason, groupOf, isExitSignal, optionsVerdict, tStatOf,
} from "@/lib/options-paper-model";

export async function ensureOptionsPaperTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS options_paper_trades (
    id serial PRIMARY KEY,
    time timestamptz DEFAULT now(),
    symbol text NOT NULL,
    corr_group text,
    source text NOT NULL,
    occ text NOT NULL,
    strike double precision,
    expiry text,
    ref_equity double precision,
    entry_delta double precision,
    entry_iv double precision,
    entry_spread_pct double precision,
    entry_ask double precision NOT NULL,
    cost_usd double precision NOT NULL,
    underlying_at_entry double precision,
    mark_usd double precision,
    peak_usd double precision,
    status text DEFAULT 'open',
    exit_bid double precision,
    proceeds_usd double precision,
    pnl double precision,
    pnl_pct double precision,
    reason text,
    resolved_at timestamptz,
    sim_version text
  )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS options_paper_open_idx ON options_paper_trades (status, source)`);
  // ONE open position per (sleeve, underlying, cohort), enforced by the database so two
  // overlapping runs cannot both pass the SELECT check and inflate the sample.
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS options_paper_one_open_idx
    ON options_paper_trades (symbol, source, sim_version) WHERE status='open'`);
}

/** Reference equity per sleeve. Overridable from AgentConfig for the experiment, but the
 *  DEFAULTS are the point of the comparison — change them and the two records stop being
 *  the same rule at two sizes. */
export async function refEquityFor(source: OptionSource): Promise<number> {
  const key = `options_paper_ref_equity_${source.replace("opt-", "")}`;
  const v = await prisma.agentConfig.findUnique({ where: { key } })
    .then((r) => (r?.value ? parseFloat(r.value) : NaN)).catch(() => NaN);
  return Number.isFinite(v) && v > 0 ? v : OPTION_SOURCE_EQUITY[source];
}
/** `options_paper_autotrack=false` stops NEW entries; open positions still resolve. */
export async function autotrackEnabled(): Promise<boolean> {
  const v = await prisma.agentConfig.findUnique({ where: { key: "options_paper_autotrack" } })
    .then((r) => r?.value).catch(() => null);
  return v !== "false";
}

export async function bookStateFor(source: OptionSource): Promise<BookState> {
  await ensureOptionsPaperTable();
  const [agg] = await prisma.$queryRawUnsafe<{ n: bigint; premium: number | null; groups: string[] | null }[]>(
    `SELECT count(*)::bigint AS n, COALESCE(sum(cost_usd),0)::float AS premium,
            COALESCE(array_agg(DISTINCT corr_group) FILTER (WHERE corr_group IS NOT NULL), '{}') AS groups
     FROM options_paper_trades WHERE status='open' AND source=$1 AND ${OPTIONS_COHORT_SQL}`, source,
  );
  const [mo] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM options_paper_trades
     WHERE source=$1 AND ${OPTIONS_COHORT_SQL} AND time >= date_trunc('month', now())`, source,
  );
  return {
    openCount: Number(agg?.n ?? 0),
    openPremium: agg?.premium ?? 0,
    entriesThisMonth: Number(mo?.n ?? 0),
    openGroups: agg?.groups ?? [],
  };
}

export type OpenResult = { opened: true; costUsd: number } | { opened: false; reason: string };

export async function openOptionPaperTrade(p: {
  symbol: string; source: OptionSource; occ: string; strike: number; expiry: string;
  ask: number; delta: number; iv: number | null; spreadPct: number; costUsd: number; underlying: number;
}): Promise<OpenResult> {
  await ensureOptionsPaperTable();
  const refEquity = await refEquityFor(p.source);
  const book = await bookStateFor(p.source);
  const group = groupOf(p.symbol);
  const [dup] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM options_paper_trades
     WHERE status='open' AND symbol=$1 AND source=$2 AND ${OPTIONS_COHORT_SQL}`, p.symbol, p.source,
  );
  if (Number(dup?.n ?? 0) > 0) return { opened: false, reason: "already open" };
  const refusal = entryRefusal(book, group, refEquity, p.costUsd);
  if (refusal) return { opened: false, reason: refusal };
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO options_paper_trades
        (symbol, corr_group, source, occ, strike, expiry, ref_equity, entry_delta, entry_iv,
         entry_spread_pct, entry_ask, cost_usd, underlying_at_entry, mark_usd, peak_usd, status, sim_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$12,$12,'open',$14)`,
      p.symbol, group, p.source, p.occ, p.strike, p.expiry, refEquity, p.delta, p.iv,
      p.spreadPct, p.ask, p.costUsd, p.underlying, OPTIONS_SIM_VERSION,
    );
  } catch (e) {
    if (/options_paper_one_open_idx|unique/i.test(String(e))) return { opened: false, reason: "already open" };
    throw e;
  }
  return { opened: true, costUsd: p.costUsd };
}

export interface OptionResolution {
  id: number; symbol: string; source: string; occ: string; costUsd: number; proceedsUsd: number;
  pnl: number; pnlPct: number; reason: string;
}
interface OpenRow {
  id: number; time: Date; symbol: string; source: string; occ: string; strike: number | null;
  expiry: string | null; cost_usd: number; peak_usd: number | null;
}

/**
 * Mark every open position from its REAL current bid and resolve the ones that hit an exit.
 *
 * Expiry is handled explicitly rather than left to a missing quote: a contract past its
 * expiry with no quote is settled at INTRINSIC value against the underlying's last close.
 * The July 2026 options agent had exactly this bug — it booked an assigned (in-the-money)
 * expiration as a "worthless win", which silently inflated the scoreboard. A position that
 * cannot be priced at all is marked `void` and excluded from every statistic rather than
 * guessed at.
 */
export async function evaluateOptionsPaper(): Promise<OptionResolution[]> {
  await ensureOptionsPaperTable();
  const rows = await prisma.$queryRawUnsafe<OpenRow[]>(
    `SELECT id, time, symbol, source, occ, strike, expiry, cost_usd, peak_usd
     FROM options_paper_trades WHERE status='open' AND ${OPTIONS_COHORT_SQL} ORDER BY time ASC LIMIT 200`,
  );
  if (!rows.length) return [];

  const now = new Date();
  let quotes: Record<string, OptionQuote> = {};
  try { quotes = await getOptionQuotes(rows.map((r) => r.occ)); } catch { /* handled per-row below */ }
  let bars: Record<string, { t: string; c: number; h: number; l: number }[]> = {};
  try { bars = await getDailyBars([...new Set(rows.map((r) => r.symbol))], 90); } catch { /* trend exit skipped */ }

  const out: OptionResolution[] = [];
  for (const r of rows) {
    const q = quotes[r.occ];
    const dte = r.expiry ? dteOf(r.expiry, now) : 999;
    const symBars = bars[r.symbol] || [];
    const lastClose = symBars.length ? symBars[symBars.length - 1].c : null;

    // --- settle an expired contract at intrinsic value, never at "worthless" by default ---
    if (dte <= 0) {
      if (lastClose == null || r.strike == null) {
        await prisma.$executeRawUnsafe(
          `UPDATE options_paper_trades SET status='void', reason=$1, resolved_at=now(), mark_usd=NULL WHERE id=$2 AND status='open'`,
          "voided — expired and neither an option quote nor an underlying close was available to settle it", r.id);
        continue;
      }
      const intrinsic = Math.max(0, lastClose - r.strike) * 100;
      const pnl = intrinsic - r.cost_usd;
      await prisma.$executeRawUnsafe(
        `UPDATE options_paper_trades SET status='resolved', exit_bid=$1, proceeds_usd=$2, pnl=$3, pnl_pct=$4,
           reason=$5, resolved_at=now(), mark_usd=NULL WHERE id=$6 AND status='open'`,
        intrinsic / 100, intrinsic, pnl, r.cost_usd > 0 ? pnl / r.cost_usd : 0,
        intrinsic > 0 ? `expired in the money — settled at intrinsic $${(intrinsic / 100).toFixed(2)}` : "expired worthless",
        r.id);
      out.push({ id: r.id, symbol: r.symbol, source: r.source, occ: r.occ, costUsd: r.cost_usd, proceedsUsd: intrinsic, pnl, pnlPct: r.cost_usd > 0 ? pnl / r.cost_usd : 0, reason: "expiry" });
      continue;
    }

    // --- unpriceable this run: leave it open, do not guess a mark ---
    if (!q || !(q.bid > 0)) continue;

    const markUsd = q.bid * 100;
    const peak = Math.max(r.peak_usd ?? 0, markUsd);
    const trendExit = symBars.length >= 25 ? isExitSignal(symBars.map((b) => ({ t: b.t, c: b.c, h: b.h, l: b.l }))) : false;
    const reason = exitReason({ trendExit, dte, markUsd, costUsd: r.cost_usd });

    if (!reason) {
      await prisma.$executeRawUnsafe(
        `UPDATE options_paper_trades SET mark_usd=$1, peak_usd=$2 WHERE id=$3 AND status='open'`, markUsd, peak, r.id);
      continue;
    }
    // Exit receives the quoted BID — the same side of the spread a real seller crosses.
    const proceeds = exitProceedsUsd(q.bid);
    const pnl = proceeds - r.cost_usd;
    const pnlPct = r.cost_usd > 0 ? pnl / r.cost_usd : 0;
    await prisma.$executeRawUnsafe(
      `UPDATE options_paper_trades SET status='resolved', exit_bid=$1, proceeds_usd=$2, pnl=$3, pnl_pct=$4,
         reason=$5, resolved_at=now(), peak_usd=$6, mark_usd=NULL WHERE id=$7 AND status='open'`,
      q.bid, proceeds, pnl, pnlPct, reason, peak, r.id);
    out.push({ id: r.id, symbol: r.symbol, source: r.source, occ: r.occ, costUsd: r.cost_usd, proceedsUsd: proceeds, pnl, pnlPct, reason });
  }
  return out;
}

// ---------- Scoreboard ----------
export interface OptionsSleeveStat {
  key: string; label: string; refEquity: number; resolved: number; wins: number; hitRate: number | null;
  expectancy: number | null; totalPnl: number; open: number; openPremium: number; openMark: number;
  voided: number; days: number; tStat: number | null; verdict: string;
  avgSpreadPct: number | null; entriesThisMonth: number;
}
export async function optionsSleeveBreakdown(): Promise<OptionsSleeveStat[]> {
  await ensureOptionsPaperTable();
  const rows = await prisma.$queryRawUnsafe<{
    source: string; refequity: number | null; resolved: bigint; wins: bigint; total: number | null;
    open: bigint; openprem: number | null; openmark: number | null; voided: bigint; days: bigint;
    meanpnl: number | null; stdpnl: number | null; avgspread: number | null; month: bigint;
  }[]>(
    `SELECT source,
       max(ref_equity) AS refequity,
       count(*) FILTER (WHERE status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE status='resolved' AND pnl > 0)::bigint AS wins,
       COALESCE(sum(pnl) FILTER (WHERE status='resolved'),0)::float AS total,
       count(*) FILTER (WHERE status='open')::bigint AS open,
       COALESCE(sum(cost_usd) FILTER (WHERE status='open'),0)::float AS openprem,
       COALESCE(sum(mark_usd) FILTER (WHERE status='open'),0)::float AS openmark,
       count(*) FILTER (WHERE status='void')::bigint AS voided,
       count(DISTINCT date_trunc('day', resolved_at)) FILTER (WHERE status='resolved')::bigint AS days,
       avg(pnl) FILTER (WHERE status='resolved') AS meanpnl,
       stddev_samp(pnl) FILTER (WHERE status='resolved') AS stdpnl,
       avg(entry_spread_pct) AS avgspread,
       count(*) FILTER (WHERE time >= date_trunc('month', now()))::bigint AS month
     FROM options_paper_trades WHERE ${OPTIONS_COHORT_SQL} GROUP BY source`,
  );
  return rows.map((r) => {
    const resolved = Number(r.resolved);
    const net = r.total || 0;
    const t = tStatOf(r.meanpnl, r.stdpnl, resolved);
    return {
      key: r.source,
      label: OPTION_SOURCE_LABELS[r.source as OptionSource] ?? r.source,
      refEquity: r.refequity || OPTION_SOURCE_EQUITY[r.source as OptionSource] || 0,
      resolved, wins: Number(r.wins), hitRate: resolved > 0 ? Number(r.wins) / resolved : null,
      expectancy: resolved > 0 ? net / resolved : null, totalPnl: net,
      open: Number(r.open), openPremium: r.openprem || 0, openMark: r.openmark || 0,
      voided: Number(r.voided), days: Number(r.days), tStat: t,
      verdict: optionsVerdict(resolved, net, t, Number(r.days)),
      avgSpreadPct: r.avgspread, entriesThisMonth: Number(r.month),
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

export interface OptionPaperRow {
  id: number; time: string; symbol: string; source: string; occ: string; strike: number | null;
  expiry: string | null; entryAsk: number; costUsd: number; markUsd: number | null; peakUsd: number | null;
  exitBid: number | null; pnl: number | null; pnlPct: number | null; status: string; reason: string | null;
  entryDelta: number | null; entrySpreadPct: number | null; simVersion: string;
}
export async function recentOptionPaperTrades(limit = 100): Promise<OptionPaperRow[]> {
  await ensureOptionsPaperTable();
  const rows = await prisma.$queryRawUnsafe<{
    id: number; time: Date; symbol: string; source: string; occ: string; strike: number | null;
    expiry: string | null; entry_ask: number; cost_usd: number; mark_usd: number | null; peak_usd: number | null;
    exit_bid: number | null; pnl: number | null; pnl_pct: number | null; status: string | null;
    reason: string | null; entry_delta: number | null; entry_spread_pct: number | null; sim_version: string | null;
  }[]>(
    `SELECT id, time, symbol, source, occ, strike, expiry, entry_ask, cost_usd, mark_usd, peak_usd,
            exit_bid, pnl, pnl_pct, status, reason, entry_delta, entry_spread_pct, sim_version
     FROM options_paper_trades ORDER BY time DESC LIMIT $1`, Math.max(1, Math.min(500, limit)),
  );
  return rows.map((r) => ({
    id: r.id, time: r.time.toISOString(), symbol: r.symbol, source: r.source, occ: r.occ,
    strike: r.strike, expiry: r.expiry, entryAsk: r.entry_ask, costUsd: r.cost_usd,
    markUsd: r.status === "resolved" ? null : r.mark_usd, peakUsd: r.peak_usd,
    exitBid: r.exit_bid, pnl: r.pnl, pnlPct: r.pnl_pct, status: r.status ?? "open", reason: r.reason,
    entryDelta: r.entry_delta, entrySpreadPct: r.entry_spread_pct,
    simVersion: r.sim_version ?? OPTIONS_SIM_VERSION,
  }));
}
