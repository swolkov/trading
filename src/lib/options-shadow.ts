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
import { getDailyBars, getOptionQuotes, type OptionQuote } from "@/lib/rh-options-data";
import {
  OPTIONS_COHORT_SQL, OPTIONS_SIM_VERSION, OPTION_SOURCES, OPTION_SOURCE_LABELS, OPTION_SOURCE_EQUITY,
  type BookState, type OptionSource,
  MIN_QUOTE_SIZE,
  canExitAt, dteOf, entryRefusal, exitProceedsUsd, exitReason, groupOf, isExitSignal,
  isQuoteFresh, optionsVerdict, spreadProceedsUsd, tStatOf,
} from "@/lib/options-paper-model";

/** How long past expiry a position may stay open while settlement data is unavailable
 *  before it is written off as unknowable. A transient bars outage on the day a contract
 *  expires must NOT erase a real loss from the record — it just means "try again tomorrow". */
const SETTLE_GRACE_DAYS = 5;

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
  // Added Sep 10 2026 with Level 3. ADD COLUMN IF NOT EXISTS, not a wider CREATE TABLE:
  // the table already exists in production, so a changed CREATE would silently do nothing.
  // `structure` defaults to 'call' so every pre-existing row reads correctly as a naked call.
  for (const col of [
    "structure text NOT NULL DEFAULT 'call'",
    "short_occ text",
    "short_strike double precision",
    "entry_short_bid double precision",
    "exit_short_ask double precision",
    "width_usd double precision",
  ]) {
    await prisma.$executeRawUnsafe(`ALTER TABLE options_paper_trades ADD COLUMN IF NOT EXISTS ${col}`);
  }
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

/**
 * Open one paper position, with every book cap enforced ATOMICALLY.
 *
 * The caps (concurrent count, book premium, monthly entries, one-per-correlation-group) are
 * checked by reading and then inserting, which is only safe if nothing else can insert in
 * between. The unique index alone does not cover this: it blocks a duplicate SYMBOL, not a
 * second DIFFERENT symbol slipping past a shared cap. Two overlapping runs — the daily cron
 * and a manual trigger, say — could otherwise both read "2 open, $600 premium" and both
 * insert, leaving 4 positions and a book over its cap.
 *
 * So the whole check-and-insert runs inside one transaction behind a per-sleeve advisory
 * lock. Concurrent callers serialize on the sleeve; the second one reads the first one's
 * committed state and refuses correctly.
 */
export async function openOptionPaperTrade(p: {
  symbol: string; source: OptionSource; occ: string; strike: number; expiry: string;
  ask: number; bid: number; delta: number; iv: number | null; spreadPct: number;
  costUsd: number; underlying: number;
  // Present only for a vertical. `shortBid` is what the short leg was SOLD for at entry,
  // so the opening mark can be computed the same honest way a naked call's is.
  structure?: "call" | "call_spread";
  shortOcc?: string; shortStrike?: number; shortBid?: number; shortAsk?: number; widthUsd?: number;
}): Promise<OpenResult> {
  await ensureOptionsPaperTable();
  const refEquity = await refEquityFor(p.source);
  const group = groupOf(p.symbol);
  return prisma.$transaction(async (tx) => {
    // Serialize entries per sleeve for the life of this transaction.
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `options_paper:${p.source}`);

    const [agg] = await tx.$queryRawUnsafe<{ n: bigint; premium: number | null; groups: string[] | null; dup: bigint }[]>(
      `SELECT count(*)::bigint AS n, COALESCE(sum(cost_usd),0)::float AS premium,
              COALESCE(array_agg(DISTINCT corr_group) FILTER (WHERE corr_group IS NOT NULL), '{}') AS groups,
              count(*) FILTER (WHERE symbol=$2)::bigint AS dup
       FROM options_paper_trades WHERE status='open' AND source=$1 AND ${OPTIONS_COHORT_SQL}`,
      p.source, p.symbol,
    );
    const [mo] = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM options_paper_trades
       WHERE source=$1 AND ${OPTIONS_COHORT_SQL} AND time >= date_trunc('month', now())`, p.source,
    );
    if (Number(agg?.dup ?? 0) > 0) return { opened: false, reason: "already open" } as OpenResult;
    const book: BookState = {
      openCount: Number(agg?.n ?? 0), openPremium: agg?.premium ?? 0,
      entriesThisMonth: Number(mo?.n ?? 0), openGroups: agg?.groups ?? [],
    };
    const refusal = entryRefusal(book, group, refEquity, p.costUsd);
    if (refusal) return { opened: false, reason: refusal } as OpenResult;

    // The opening mark is what the position could be SOLD for right now — the bid — not
    // what was paid for it. Seeding the mark with the cost would show every fresh position
    // as flat when it is in fact already down the spread, which is the single largest cost
    // this book exists to measure.
    // For a vertical the opening mark is what the WHOLE position could be unwound for now:
    // sell the long at its bid AND buy the short back at its ask. Marking only the long leg
    // would show the position miles ahead of reality.
    const isSpread = p.structure === "call_spread";
    const openingMark = isSpread
      ? Math.max(0, (p.bid - (p.shortAsk ?? 0)) * 100)
      : p.bid * 100;
    try {
      await tx.$executeRawUnsafe(
        `INSERT INTO options_paper_trades
          (symbol, corr_group, source, occ, strike, expiry, ref_equity, entry_delta, entry_iv,
           entry_spread_pct, entry_ask, cost_usd, underlying_at_entry, mark_usd, peak_usd, status, sim_version,
           structure, short_occ, short_strike, entry_short_bid, width_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,'open',$15,$16,$17,$18,$19,$20)`,
        p.symbol, group, p.source, p.occ, p.strike, p.expiry, refEquity, p.delta, p.iv,
        p.spreadPct, p.ask, p.costUsd, p.underlying, openingMark, OPTIONS_SIM_VERSION,
        isSpread ? "call_spread" : "call",
        p.shortOcc ?? null, p.shortStrike ?? null, p.shortBid ?? null, p.widthUsd ?? null,
      );
    } catch (e) {
      if (/options_paper_one_open_idx|unique/i.test(String(e))) return { opened: false, reason: "already open" } as OpenResult;
      throw e;
    }
    return { opened: true, costUsd: p.costUsd } as OpenResult;
  });
}

export interface OptionResolution {
  id: number; symbol: string; source: string; occ: string; costUsd: number; proceedsUsd: number;
  pnl: number; pnlPct: number; reason: string;
}
interface OpenRow {
  id: number; time: Date; symbol: string; source: string; occ: string; strike: number | null;
  expiry: string | null; cost_usd: number; peak_usd: number | null;
  structure: string | null; short_occ: string | null; short_strike: number | null; width_usd: number | null;
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
  // DELIBERATELY NOT cohort-filtered. Bumping the sim version starts a new SAMPLE; it does
  // not abandon a position that is still open. An o1 call left unmanaged would never mark
  // again and never hit its stop — the rules changed, the trade did not stop existing.
  // Aggregates stay cohort-scoped, so a legacy position affects the record of its own
  // cohort and nothing else.
  const rows = await prisma.$queryRawUnsafe<OpenRow[]>(
    `SELECT id, time, symbol, source, occ, strike, expiry, cost_usd, peak_usd,
            structure, short_occ, short_strike, width_usd
     FROM options_paper_trades WHERE status='open' ORDER BY time ASC LIMIT 200`,
  );
  if (!rows.length) return [];

  const now = new Date();
  let quotes: Record<string, OptionQuote> = {};
  // Both legs of every vertical, or the position cannot be marked at all.
  const allOccs = [...new Set(rows.flatMap((r) => (r.short_occ ? [r.occ, r.short_occ] : [r.occ])))];
  try { quotes = await getOptionQuotes(allOccs); } catch { /* handled per-row below */ }
  let bars: Record<string, { t: string; c: number; h: number; l: number }[]> = {};
  try { bars = await getDailyBars([...new Set(rows.map((r) => r.symbol))], 120); } catch { /* handled per-row below */ }

  /** Every UPDATE that resolves a position is guarded by `status='open'`, so exactly one
   *  concurrent evaluator can win it. Only the winner reports the closure — otherwise a
   *  losing racer sends a duplicate Slack alert and inflates the run's closed count while
   *  the database (correctly) counts it once. */
  const resolveOnce = async (sql: string, ...args: unknown[]): Promise<boolean> =>
    (await prisma.$executeRawUnsafe(sql, ...args)) > 0;

  const out: OptionResolution[] = [];
  for (const r of rows) {
    const q = quotes[r.occ];
    const dte = r.expiry ? dteOf(r.expiry, now) : 999;
    const symBars = bars[r.symbol] || [];

    // ---- past expiry: settle at intrinsic value against the EXPIRY DAY's close ----
    if (r.expiry && dte <= 0) {
      // The close ON the expiry date decides an option's fate. Using the latest available
      // close instead would settle a Friday expiry off Monday's price — a $14 call that
      // died at Friday's $13 would be paid out on Monday's $20.
      const expiryBar = symBars.find((b) => b.t.slice(0, 10) === r.expiry);
      if (!expiryBar || r.strike == null) {
        // No settlement data yet. A transient bars outage must not erase a real outcome, so
        // wait; only write it off once it is clear the data is never coming.
        if (-dte >= SETTLE_GRACE_DAYS) {
          await resolveOnce(
            `UPDATE options_paper_trades SET status='void', reason=$1, resolved_at=now(), mark_usd=NULL WHERE id=$2 AND status='open'`,
            `voided — expired ${-dte} days ago and no close for ${r.expiry} was ever available to settle it`, r.id);
        }
        continue;
      }
      // A vertical settles at the long leg's intrinsic value CAPPED AT ITS WIDTH — above the
      // short strike the two legs cancel. Settling a spread on the long leg alone would book
      // an unbounded profit that the short leg never allowed.
      const rawIntrinsic = Math.max(0, expiryBar.c - r.strike) * 100;
      const capUsd = r.structure === "call_spread" && r.width_usd != null ? r.width_usd : Infinity;
      const intrinsic = Math.min(rawIntrinsic, capUsd);
      const pnl = intrinsic - r.cost_usd;
      const pnlPct = r.cost_usd > 0 ? pnl / r.cost_usd : 0;
      const won = await resolveOnce(
        `UPDATE options_paper_trades SET status='resolved', exit_bid=$1, proceeds_usd=$2, pnl=$3, pnl_pct=$4,
           reason=$5, resolved_at=now(), mark_usd=NULL WHERE id=$6 AND status='open'`,
        intrinsic / 100, intrinsic, pnl, pnlPct,
        intrinsic > 0
          ? (intrinsic === capUsd
              ? `expired past the short strike — settled at the spread's full width $${(intrinsic / 100).toFixed(2)} off the ${r.expiry} close`
              : `expired in the money — settled at intrinsic $${(intrinsic / 100).toFixed(2)} off the ${r.expiry} close`)
          : `expired worthless — ${r.expiry} close $${expiryBar.c.toFixed(2)} below the $${r.strike} strike`,
        r.id);
      if (won) out.push({ id: r.id, symbol: r.symbol, source: r.source, occ: r.occ, costUsd: r.cost_usd, proceedsUsd: intrinsic, pnl, pnlPct, reason: "expiry" });
      continue;
    }

    // ---- no usable quote this run: leave it open, never guess a mark ----
    // The gate is the same one entry uses: a real bid, real size behind it, quoted recently.
    // A $6.00 bid for zero contracts is not an exit anyone could have taken.
    if (!q || !canExitAt({ bid: q.bid, bidSize: q.bidSize, quoteTs: q.quoteTs }, now)) continue;

    // A vertical needs BOTH legs to be closeable: sell the long at its bid AND buy the short
    // back at its ask. A short leg with no offer is a position you cannot actually exit, so
    // it is left open rather than marked at a price nobody would fill.
    const isSpread = r.structure === "call_spread" && r.short_occ != null;
    const sq = isSpread ? quotes[r.short_occ as string] : undefined;
    if (isSpread) {
      const shortCloseable = !!sq && sq.ask > 0 && sq.askSize >= MIN_QUOTE_SIZE && isQuoteFresh(sq.quoteTs, now);
      if (!shortCloseable) continue;
    }

    const markUsd = isSpread ? Math.max(0, (q.bid - (sq as OptionQuote).ask) * 100) : q.bid * 100;
    const trendExit = symBars.length >= 25 ? isExitSignal(symBars.map((b) => ({ t: b.t, c: b.c, h: b.h, l: b.l }))) : false;
    const reason = exitReason({ trendExit, dte, markUsd, costUsd: r.cost_usd });

    if (!reason) {
      // GREATEST in SQL, not Math.max in JS: two evaluators reading the same stale peak and
      // writing back their own computed values would let the lower one overwrite the higher.
      await prisma.$executeRawUnsafe(
        `UPDATE options_paper_trades SET mark_usd=$1, peak_usd=GREATEST(COALESCE(peak_usd,0), $1) WHERE id=$2 AND status='open'`,
        markUsd, r.id);
      continue;
    }
    const proceeds = isSpread ? spreadProceedsUsd(q.bid, (sq as OptionQuote).ask) : exitProceedsUsd(q.bid);
    const pnl = proceeds - r.cost_usd;
    const pnlPct = r.cost_usd > 0 ? pnl / r.cost_usd : 0;
    const won = await resolveOnce(
      `UPDATE options_paper_trades SET status='resolved', exit_bid=$1, exit_short_ask=$8, proceeds_usd=$2, pnl=$3, pnl_pct=$4,
         reason=$5, resolved_at=now(), peak_usd=GREATEST(COALESCE(peak_usd,0), $6), mark_usd=NULL
       WHERE id=$7 AND status='open'`,
      q.bid, proceeds, pnl, pnlPct, reason, markUsd, r.id, isSpread ? (sq as OptionQuote).ask : null);
    if (won) out.push({ id: r.id, symbol: r.symbol, source: r.source, occ: r.occ, costUsd: r.cost_usd, proceedsUsd: proceeds, pnl, pnlPct, reason });
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
  const byKey = new Map(rows.map((r) => [r.source, r]));
  // ALWAYS return a card for EVERY sleeve, including one that has never traded.
  // `GROUP BY source` only emits rows that exist, so the $1k sleeve — which by design may
  // go long stretches unable to afford any contract — would vanish from the page entirely,
  // taking the whole point of the two-sleeve comparison with it. An empty sleeve is a
  // RESULT ("nothing was affordable"), not an absence, and has to be visible as one.
  return OPTION_SOURCES.map((source) => {
    const r = byKey.get(source);
    const resolved = Number(r?.resolved ?? 0);
    const net = r?.total || 0;
    const t = tStatOf(r?.meanpnl ?? null, r?.stdpnl ?? null, resolved);
    return {
      key: source,
      label: OPTION_SOURCE_LABELS[source],
      refEquity: r?.refequity || OPTION_SOURCE_EQUITY[source],
      resolved, wins: Number(r?.wins ?? 0), hitRate: resolved > 0 ? Number(r?.wins ?? 0) / resolved : null,
      expectancy: resolved > 0 ? net / resolved : null, totalPnl: net,
      open: Number(r?.open ?? 0), openPremium: r?.openprem || 0, openMark: r?.openmark || 0,
      voided: Number(r?.voided ?? 0), days: Number(r?.days ?? 0), tStat: t,
      verdict: optionsVerdict(resolved, net, t, Number(r?.days ?? 0)),
      avgSpreadPct: r?.avgspread ?? null, entriesThisMonth: Number(r?.month ?? 0),
    };
  });
}

export interface OptionPaperRow {
  id: number; time: string; symbol: string; source: string; occ: string; strike: number | null;
  expiry: string | null; entryAsk: number; costUsd: number; markUsd: number | null; peakUsd: number | null;
  exitBid: number | null; pnl: number | null; pnlPct: number | null; status: string; reason: string | null;
  entryDelta: number | null; entrySpreadPct: number | null; simVersion: string;
  /** 'call' or 'call_spread'. The short leg and the width are null for a naked call. */
  structure: string; shortStrike: number | null; widthUsd: number | null;
}
export async function recentOptionPaperTrades(limit = 100): Promise<OptionPaperRow[]> {
  await ensureOptionsPaperTable();
  const rows = await prisma.$queryRawUnsafe<{
    id: number; time: Date; symbol: string; source: string; occ: string; strike: number | null;
    expiry: string | null; entry_ask: number; cost_usd: number; mark_usd: number | null; peak_usd: number | null;
    exit_bid: number | null; pnl: number | null; pnl_pct: number | null; status: string | null;
    reason: string | null; entry_delta: number | null; entry_spread_pct: number | null; sim_version: string | null;
    structure: string | null; short_strike: number | null; width_usd: number | null;
  }[]>(
    `SELECT id, time, symbol, source, occ, strike, expiry, entry_ask, cost_usd, mark_usd, peak_usd,
            exit_bid, pnl, pnl_pct, status, reason, entry_delta, entry_spread_pct, sim_version,
            structure, short_strike, width_usd
     FROM options_paper_trades ORDER BY time DESC LIMIT $1`, Math.max(1, Math.min(500, limit)),
  );
  return rows.map((r) => ({
    id: r.id, time: r.time.toISOString(), symbol: r.symbol, source: r.source, occ: r.occ,
    strike: r.strike, expiry: r.expiry, entryAsk: r.entry_ask, costUsd: r.cost_usd,
    markUsd: r.status === "resolved" ? null : r.mark_usd, peakUsd: r.peak_usd,
    exitBid: r.exit_bid, pnl: r.pnl, pnlPct: r.pnl_pct, status: r.status ?? "open", reason: r.reason,
    entryDelta: r.entry_delta, entrySpreadPct: r.entry_spread_pct,
    simVersion: r.sim_version ?? OPTIONS_SIM_VERSION,
    structure: r.structure ?? "call", shortStrike: r.short_strike, widthUsd: r.width_usd,
  }));
}

/**
 * Naked calls versus verticals, within the current cohort.
 *
 * This exists because the vertical is a COMPROMISE, not an upgrade: it caps the winner, and
 * this book's whole exit design says capping winners is what turns a trend rule negative.
 * The compromise was accepted so that a $3,500 book could reach a liquid contract at all.
 * Whether it was worth it is an empirical question, and this is the number that answers it —
 * so nobody has to assume.
 */
export interface StructureStat {
  structure: string; resolved: number; wins: number; hitRate: number | null;
  totalPnl: number; avgPnlPct: number | null; open: number; openPremium: number;
}
export async function optionsStructureBreakdown(): Promise<StructureStat[]> {
  await ensureOptionsPaperTable();
  const rows = await prisma.$queryRawUnsafe<{
    structure: string | null; resolved: bigint; wins: bigint; total: number | null;
    avgpct: number | null; open: bigint; openprem: number | null;
  }[]>(
    `SELECT COALESCE(structure,'call') AS structure,
       count(*) FILTER (WHERE status='resolved')::bigint            AS resolved,
       count(*) FILTER (WHERE status='resolved' AND pnl > 0)::bigint AS wins,
       COALESCE(sum(pnl) FILTER (WHERE status='resolved'),0)::float AS total,
       avg(pnl_pct) FILTER (WHERE status='resolved')                AS avgpct,
       count(*) FILTER (WHERE status='open')::bigint                AS open,
       COALESCE(sum(cost_usd) FILTER (WHERE status='open'),0)::float AS openprem
     FROM options_paper_trades WHERE ${OPTIONS_COHORT_SQL} GROUP BY 1 ORDER BY 1`,
  );
  return rows.map((r) => {
    const resolved = Number(r.resolved);
    return {
      structure: r.structure ?? "call",
      resolved, wins: Number(r.wins),
      hitRate: resolved > 0 ? Number(r.wins) / resolved : null,
      totalPnl: r.total ?? 0,
      avgPnlPct: r.avgpct == null ? null : Number(r.avgpct),
      open: Number(r.open), openPremium: r.openprem ?? 0,
    };
  });
}
