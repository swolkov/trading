import { OPTIONS_PAPER_RETIRED } from "@/lib/options-operation";
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
import { assessAssignment, worstLevel } from "@/lib/options-assignment";
import { getDailyBars, getOptionQuotes, type OptionQuote } from "@/lib/rh-options-data";
import {
  OPTIONS_COHORT_SQL, OPTIONS_SIM_VERSION, OPTION_SOURCES, OPTION_SOURCE_LABELS, OPTION_SOURCE_EQUITY,
  type BookState, type OptionSource,
  MIN_QUOTE_SIZE,
  type StoredStructure,
  canExitAt, creditCloseCostUsd, dteOf, entryRefusal, exitProceedsUsd, exitReason, groupOf,
  isCreditStructure, isPutStructure, isQuoteFresh, optionsVerdict, positionMarkUsd,
  settleAtExpiry, spreadProceedsUsd, tStatOf, trendExitFor,
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
    "credit_usd double precision NOT NULL DEFAULT 0",
    "entry_crossing_usd double precision",
    "assignment_level text",
    "assignment_note text",
    "underlying_last double precision",
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
  if (OPTIONS_PAPER_RETIRED) return false;
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
  // `costUsd` is CAPITAL AT RISK, not "what was paid": the debit for a debit position, the
  // collateral (width minus credit) for a credit one. Every book cap, every percentage and
  // pnl_pct is measured against it, so both kinds of position are sized on the same basis.
  structure?: StoredStructure;
  creditUsd?: number;
  /** Half the quoted spread on EVERY leg — what getting in actually cost. `entry_spread_pct`
   *  only ever described the long leg, which on a credit spread is the cheap protective one,
   *  so on its own it understates a two-legged entry. */
  crossingUsd?: number;
  shortOcc?: string; shortStrike?: number; shortBid?: number; shortAsk?: number; widthUsd?: number;
}): Promise<OpenResult> {
  if (OPTIONS_PAPER_RETIRED) return { opened: false, reason: "Options paper trading retired by owner" };
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
    // One mark definition for both kinds — see positionMarkUsd. A fresh position is marked at
    // what it could be UNWOUND for right now, which is already down the round trip. Seeding it
    // at cost would hide the single largest expense this book exists to measure.
    const creditUsd = p.creditUsd ?? 0;
    const openingMark = positionMarkUsd({
      structure: p.structure ?? "call",
      capitalAtRiskUsd: p.costUsd, creditUsd,
      longBid: p.bid, shortAsk: p.shortOcc ? (p.shortAsk ?? 0) : null,
    });
    try {
      await tx.$executeRawUnsafe(
        `INSERT INTO options_paper_trades
          (symbol, corr_group, source, occ, strike, expiry, ref_equity, entry_delta, entry_iv,
           entry_spread_pct, entry_ask, cost_usd, underlying_at_entry, mark_usd, peak_usd, status, sim_version,
           structure, short_occ, short_strike, entry_short_bid, width_usd, credit_usd, entry_crossing_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,'open',$15,$16,$17,$18,$19,$20,$21,$22)`,
        p.symbol, group, p.source, p.occ, p.strike, p.expiry, refEquity, p.delta, p.iv,
        p.spreadPct, p.ask, p.costUsd, p.underlying, openingMark, OPTIONS_SIM_VERSION,
        p.structure ?? "call",
        p.shortOcc ?? null, p.shortStrike ?? null, p.shortBid ?? null, p.widthUsd ?? null, creditUsd,
        p.crossingUsd ?? null,
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
  structure: string | null; short_occ: string | null; short_strike: number | null;
  width_usd: number | null; credit_usd: number | null;
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
  if (OPTIONS_PAPER_RETIRED) return [];
  await ensureOptionsPaperTable();
  // DELIBERATELY NOT cohort-filtered. Bumping the sim version starts a new SAMPLE; it does
  // not abandon a position that is still open. An o1 call left unmanaged would never mark
  // again and never hit its stop — the rules changed, the trade did not stop existing.
  // Aggregates stay cohort-scoped, so a legacy position affects the record of its own
  // cohort and nothing else.
  const rows = await prisma.$queryRawUnsafe<OpenRow[]>(
    `SELECT id, time, symbol, source, occ, strike, expiry, cost_usd, peak_usd,
            structure, short_occ, short_strike, width_usd, COALESCE(credit_usd, 0) AS credit_usd
     FROM options_paper_trades WHERE status='open' ORDER BY time ASC LIMIT 200`,
  );
  if (!rows.length) return [];

  const now = new Date();
  // Reference equity per sleeve, fetched once: the exercise-capital check needs to know what
  // the account could actually pay for if a long leg were auto-exercised.
  const sleeveEquity = new Map<string, number>();
  for (const src of new Set(rows.map((r) => r.source))) {
    sleeveEquity.set(src, await refEquityFor(src as OptionSource).catch(() => 0));
  }
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
      // One settlement function for both kinds — see settleAtExpiry. A debit vertical is the
      // long leg's intrinsic CAPPED AT ITS WIDTH (above the short strike the legs cancel); a
      // credit vertical keeps its credit unless the close comes through the short strike.
      const settled = settleAtExpiry({
        structure: r.structure, longStrike: r.strike, shortStrike: r.short_strike,
        widthUsd: r.width_usd, close: expiryBar.c,
        capitalAtRiskUsd: r.cost_usd, creditUsd: r.credit_usd ?? 0,
      });
      const intrinsic = settled.valueUsd;
      const pnl = settled.pnlUsd;
      const pnlPct = r.cost_usd > 0 ? pnl / r.cost_usd : 0;
      const won = await resolveOnce(
        `UPDATE options_paper_trades SET status='resolved', exit_bid=$1, proceeds_usd=$2, pnl=$3, pnl_pct=$4,
           reason=$5, resolved_at=now(), mark_usd=NULL WHERE id=$6 AND status='open'`,
        intrinsic / 100, intrinsic, pnl, pnlPct,
        isCreditStructure(r.structure)
          ? (pnl >= 0
              ? `expired above the short $${r.short_strike} strike — kept the $${(r.credit_usd ?? 0).toFixed(2)} credit, ${r.expiry} close $${expiryBar.c.toFixed(2)}`
              : `expired through the short $${r.short_strike} strike — ${r.expiry} close $${expiryBar.c.toFixed(2)}`)
          : intrinsic > 0
            ? (r.width_usd != null && intrinsic >= r.width_usd
                ? `expired past the short strike — settled at the spread's full width $${(intrinsic / 100).toFixed(2)} off the ${r.expiry} close`
                : `expired in the money — settled at intrinsic $${(intrinsic / 100).toFixed(2)} off the ${r.expiry} close`)
            : `expired worthless — ${r.expiry} close $${expiryBar.c.toFixed(2)} below the $${r.strike} strike`,
        r.id);
      if (won) out.push({ id: r.id, symbol: r.symbol, source: r.source, occ: r.occ, costUsd: r.cost_usd, proceedsUsd: intrinsic, pnl, pnlPct, reason: "expiry" });
      continue;
    }

    // ---- no usable quote this run: leave it open, never guess a mark ----
    //
    // WHAT "CLOSEABLE" MEANS DEPENDS ON WHICH SIDE OF THE TRADE WE ARE ON.
    //
    // DEBIT: we SELL the long to get out, so it needs a real bid with real size behind it.
    // A $6.00 bid for zero contracts is not an exit anyone could have taken.
    //
    // CREDIT: we BUY THE SHORT BACK to get out. That is the leg that costs money and the one
    // that must be quoted. The long is only protection, and on a WINNING credit spread it
    // decays toward worthless — bid $0.00, no size. Demanding a live bid there would freeze
    // the position exactly when it is working: it would stop marking, never reach its 21-day
    // exit, and drift into expiry week, which is the assignment and pin risk this book exists
    // to avoid. So on a credit position the long only has to be QUOTED RECENTLY. A zero bid
    // is a real price for a worthless option, and closing at it is the conservative
    // assumption.
    const hasShort = r.short_occ != null;
    const isCredit = isCreditStructure(r.structure);
    const sq = hasShort ? quotes[r.short_occ as string] : undefined;

    if (!q || !isQuoteFresh(q.quoteTs, now)) continue;
    if (!isCredit && !canExitAt({ bid: q.bid, bidSize: q.bidSize, quoteTs: q.quoteTs }, now)) continue;
    if (hasShort) {
      const shortCloseable = !!sq && sq.ask > 0 && sq.askSize >= MIN_QUOTE_SIZE && isQuoteFresh(sq.quoteTs, now);
      if (!shortCloseable) continue;
    }

    const markUsd = positionMarkUsd({
      structure: r.structure, capitalAtRiskUsd: r.cost_usd, creditUsd: r.credit_usd ?? 0,
      longBid: q.bid, shortAsk: hasShort ? (sq as OptionQuote).ask : null,
    });

    // ASSIGNMENT AND EXERCISE. Every one of these findings describes a place the book's own
    // rules say a position should never be — the 21-day floor is what normally prevents all
    // of them. So a HIGH finding is not a routine exit signal, it is evidence that the floor
    // did not fire, which on this desk means the scheduled agent stopped running. Closing on
    // it is the backstop, not the plan; "the broker will probably handle it" is exactly what
    // this refuses to rely on.
    //
    // Ex-dividend is not plumbed: it drives early assignment of short CALLS, and the only
    // credit structure enabled today is a short PUT. The check is ready if that changes.
    const spotNow = symBars.length ? symBars[symBars.length - 1].c : 0;
    const risks = spotNow > 0 && r.strike != null
      ? assessAssignment({
          longStrike: r.strike,
          // Leg TYPE, not direction: a put credit spread is bullish but its legs are puts.
          longIsCall: !isPutStructure(r.structure),
          shortStrike: r.short_strike, shortMid: sq ? (sq.bid + sq.ask) / 2 : null,
          spot: spotNow, dte, contracts: 1,
          accountEquityUsd: sleeveEquity.get(r.source) ?? 0,
        })
      : [];
    const riskLevel = worstLevel(risks);
    // The BEARISH sleeves exit on a 25-session HIGH, the bullish ones on a 25-session low.
    // Using the long rule on a short position would hold it through exactly the move that
    // kills it.
    const trendExit = symBars.length >= 25
      ? trendExitFor(r.source, symBars.map((b) => ({ t: b.t, c: b.c, h: b.h, l: b.l })))
      : false;
    // The book's own rules first; assignment risk only as the backstop, so when it IS the
    // recorded reason that fact is itself the diagnostic.
    const reason = exitReason({ trendExit, dte, markUsd, costUsd: r.cost_usd })
      ?? (riskLevel === "high" ? ("assignment risk" as const) : null);

    if (!reason) {
      // GREATEST in SQL, not Math.max in JS: two evaluators reading the same stale peak and
      // writing back their own computed values would let the lower one overwrite the higher.
      await prisma.$executeRawUnsafe(
        `UPDATE options_paper_trades SET mark_usd=$1, peak_usd=GREATEST(COALESCE(peak_usd,0), $1),
           assignment_level=$3, assignment_note=$4, underlying_last=$5 WHERE id=$2 AND status='open'`,
        markUsd, r.id,
        riskLevel === "none" ? null : riskLevel,
        risks.length ? risks.map((x) => x.message).join(" ") : null,
        spotNow > 0 ? spotNow : null);
      continue;
    }
    // Closing a credit position COSTS money — buy the short back, sell the long — and the P&L
    // is the credit kept minus that cost. Closing a debit position RECEIVES money. Both are
    // then expressed as "what the capital at risk became", so proceeds_usd and pnl_pct mean
    // the same thing on every row.
    const pnl = isCredit
      // width === collateral + credit, so the close cost is capped at exactly the point where
      // the loss equals the collateral. That is what makes "defined risk" true in the record.
      ? (r.credit_usd ?? 0) - creditCloseCostUsd((sq as OptionQuote).ask, q.bid, r.cost_usd + (r.credit_usd ?? 0))
      : (hasShort
          ? spreadProceedsUsd(q.bid, (sq as OptionQuote).ask)
          : exitProceedsUsd(q.bid)) - r.cost_usd;
    const proceeds = r.cost_usd + pnl;
    const pnlPct = r.cost_usd > 0 ? pnl / r.cost_usd : 0;
    const won = await resolveOnce(
      `UPDATE options_paper_trades SET status='resolved', exit_bid=$1, exit_short_ask=$8, proceeds_usd=$2, pnl=$3, pnl_pct=$4,
         reason=$5, resolved_at=now(), peak_usd=GREATEST(COALESCE(peak_usd,0), $6), mark_usd=NULL
       WHERE id=$7 AND status='open'`,
      q.bid, proceeds, pnl, pnlPct,
      reason === "assignment risk" && risks.length ? `assignment risk — ${risks[0].message}` : reason,
      markUsd, r.id, hasShort ? (sq as OptionQuote).ask : null);
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
  // Positions from an EARLIER cohort are still evaluated to their finish (the evaluator is
  // not cohort-filtered) and still appear in the position log, but they are not in this
  // cohort's statistics. Count them per sleeve so the card can say so — a card reading
  // "0 open" above a log row reading "open" is a contradiction, not a summary.
  const legacy = await prisma.$queryRawUnsafe<{ source: string; n: bigint }[]>(
    `SELECT source, count(*)::bigint AS n FROM options_paper_trades
     WHERE status='open' AND NOT (${OPTIONS_COHORT_SQL}) GROUP BY source`,
  );
  const legacyOpen = new Map(legacy.map((r) => [r.source, Number(r.n)]));
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
      legacyOpen: legacyOpen.get(source) ?? 0,
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
  structure: string; shortStrike: number | null; widthUsd: number | null; creditUsd: number;
  /** What the position was actually worth on exit — the WHOLE position. `exitBid` is only the
   *  long leg, so on any spread it contradicts the P&L beside it. */
  proceedsUsd: number | null; crossingUsd: number | null;
  /** Worst assignment/exercise finding on this position at its last mark, and why. */
  assignmentLevel: string | null; assignmentNote: string | null;
  /** Strikes and the underlying's latest price — everything a payoff grid needs. */
  longStrike: number | null; underlyingLast: number | null; capitalAtRiskUsd: number;
}
export async function recentOptionPaperTrades(limit = 100): Promise<OptionPaperRow[]> {
  await ensureOptionsPaperTable();
  const rows = await prisma.$queryRawUnsafe<{
    id: number; time: Date; symbol: string; source: string; occ: string; strike: number | null;
    expiry: string | null; entry_ask: number; cost_usd: number; mark_usd: number | null; peak_usd: number | null;
    exit_bid: number | null; pnl: number | null; pnl_pct: number | null; status: string | null;
    reason: string | null; entry_delta: number | null; entry_spread_pct: number | null; sim_version: string | null;
    structure: string | null; short_strike: number | null; width_usd: number | null; credit_usd: number | null;
    proceeds_usd: number | null; entry_crossing_usd: number | null;
    assignment_level: string | null; assignment_note: string | null; underlying_last: number | null;
  }[]>(
    `SELECT id, time, symbol, source, occ, strike, expiry, entry_ask, cost_usd, mark_usd, peak_usd,
            exit_bid, pnl, pnl_pct, status, reason, entry_delta, entry_spread_pct, sim_version,
            structure, short_strike, width_usd, COALESCE(credit_usd, 0) AS credit_usd,
            proceeds_usd, entry_crossing_usd, assignment_level, assignment_note, underlying_last
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
    creditUsd: r.credit_usd ?? 0,
    proceedsUsd: r.proceeds_usd, crossingUsd: r.entry_crossing_usd,
    assignmentLevel: r.assignment_level, assignmentNote: r.assignment_note,
    longStrike: r.strike, underlyingLast: r.underlying_last, capitalAtRiskUsd: r.cost_usd,
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
