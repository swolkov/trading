// OPTIONS QUOTE STORE — the Robinhood data seam.
//
// WHY THIS EXISTS (Sep 9 2026). This book was built against Alpaca, whose market data is a
// server-side HTTP call with API keys. Spencer moved it to Robinhood, and Robinhood has no
// server credentials at all: its only official programmatic route is an OAuth MCP bound to
// a Claude session, and the unofficial APIs get accounts frozen. So option quotes cannot be
// PULLED by a cron — they must be PUSHED in by a scheduled agent.
//
// This module is that inbox. A scheduled Claude session writes quotes here; the scanner and
// the shadow evaluator read them through `rh-options-data.ts` and are otherwise unchanged.
// Nothing about the strategy, the universe, the caps or the verdict moved.
//
// WHY THE DELAY IS ACCEPTABLE. An entry now waits for the next agent run to fetch its chain
// (up to about an hour) instead of resolving inside one cron tick. This book takes at most
// TWO entries per sleeve per month on 60-120 day holds, so an hour of latency on a signal
// that is acted on twenty-odd times a year is immaterial. It would NOT be acceptable on the
// Kraken desk, which is why only this book works this way.
//
// STALENESS IS ENFORCED, NOT ASSUMED. Every row carries the broker's own quote timestamp,
// and reads apply the model's existing `MAX_QUOTE_AGE_MS` guard. A quote too old to trust is
// not returned at all — an absent quote is handled everywhere (the position is left alone,
// the entry is refused); a silently stale one would mark a position at last week's price.
import { prisma } from "@/lib/db";
import { MAX_QUOTE_AGE_MS } from "@/lib/options-paper-model";

export interface OptionQuote {
  occ: string; strike: number; expiry: string; type: "call" | "put";
  bid: number; ask: number; bidSize: number; askSize: number;
  /** When the broker published the quote. Never null from Robinhood, but kept nullable
   *  because the freshness guard must treat "unknown" as "not fresh". */
  quoteTs: string | null;
  delta: number | null; theta: number | null; iv: number | null; dayVolume: number;
}

export async function ensureQuoteStore(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS options_quote_snapshots (
    occ text PRIMARY KEY,
    symbol text NOT NULL,
    strike double precision NOT NULL,
    expiry text NOT NULL,
    opt_type text NOT NULL,
    bid double precision NOT NULL DEFAULT 0,
    ask double precision NOT NULL DEFAULT 0,
    bid_size double precision NOT NULL DEFAULT 0,
    ask_size double precision NOT NULL DEFAULT 0,
    quote_ts timestamptz,
    delta double precision,
    theta double precision,
    iv double precision,
    day_volume double precision NOT NULL DEFAULT 0,
    underlying double precision,
    pushed_at timestamptz DEFAULT now()
  )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS options_quote_chain_idx ON options_quote_snapshots (symbol, expiry, strike)`);
  // What the scanner still needs but could not fetch itself. The agent drains this.
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS options_chain_requests (
    symbol text PRIMARY KEY,
    spot double precision,
    budget_usd double precision,
    expiry_from text,
    expiry_to text,
    strike_min double precision,
    strike_max double precision,
    requested_at timestamptz DEFAULT now(),
    fulfilled_at timestamptz
  )`);
}

// The OCC root is the underlying ticker, but a caller may pass it explicitly rather than
// re-deriving it from the symbol string.
export type QuoteWithHint = OptionQuote & { symbolHint?: string };
function parseRoot(occ: string, hint?: string): string {
  return hint ?? (occ.length > 15 ? occ.slice(0, -15).trim() : occ);
}

/** Upsert quotes pushed by the agent. `underlying` is the spot at push time, carried so the
 *  page can show what the contract was priced against without a second lookup. */
export async function putQuotes(quotes: QuoteWithHint[], underlyingBySymbol: Record<string, number> = {}): Promise<number> {
  if (!quotes.length) return 0;
  await ensureQuoteStore();
  let n = 0;
  for (const q of quotes) {
    // A quote with no two-sided market is not written at all: storing a zero bid would let
    // the exit path read it as a real price and book a 100% loss that never happened.
    if (!(q.ask > 0) && !(q.bid > 0)) continue;
    await prisma.$executeRawUnsafe(
      `INSERT INTO options_quote_snapshots
         (occ, symbol, strike, expiry, opt_type, bid, ask, bid_size, ask_size, quote_ts, delta, theta, iv, day_volume, underlying, pushed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (occ) DO UPDATE SET
         bid=EXCLUDED.bid, ask=EXCLUDED.ask, bid_size=EXCLUDED.bid_size, ask_size=EXCLUDED.ask_size,
         quote_ts=EXCLUDED.quote_ts, delta=EXCLUDED.delta, theta=EXCLUDED.theta, iv=EXCLUDED.iv,
         day_volume=EXCLUDED.day_volume, underlying=EXCLUDED.underlying, pushed_at=now()`,
      q.occ, parseRoot(q.occ, q.symbolHint), q.strike, q.expiry, q.type,
      q.bid, q.ask, q.bidSize, q.askSize, q.quoteTs ? new Date(q.quoteTs) : null,
      q.delta, q.theta, q.iv, q.dayVolume, underlyingBySymbol[parseRoot(q.occ, q.symbolHint)] ?? null,
    );
    n++;
  }
  return n;
}
interface QuoteRow {
  occ: string; strike: number; expiry: string; opt_type: string;
  bid: number; ask: number; bid_size: number; ask_size: number;
  quote_ts: Date | null; delta: number | null; theta: number | null; iv: number | null; day_volume: number;
}
const rowToQuote = (r: QuoteRow): OptionQuote => ({
  occ: r.occ, strike: r.strike, expiry: r.expiry, type: r.opt_type === "put" ? "put" : "call",
  bid: r.bid, ask: r.ask, bidSize: r.bid_size, askSize: r.ask_size,
  quoteTs: r.quote_ts ? r.quote_ts.toISOString() : null,
  delta: r.delta, theta: r.theta, iv: r.iv, dayVolume: r.day_volume,
});

/** Stored quotes for specific contracts. Rows older than the model's freshness window are
 *  OMITTED rather than returned stale — see the header. */
export async function getStoredQuotes(occs: string[], now: Date = new Date()): Promise<Record<string, OptionQuote>> {
  if (!occs.length) return {};
  await ensureQuoteStore();
  const cutoff = new Date(now.getTime() - MAX_QUOTE_AGE_MS);
  const rows = await prisma.$queryRawUnsafe<QuoteRow[]>(
    `SELECT occ, strike, expiry, opt_type, bid, ask, bid_size, ask_size, quote_ts, delta, theta, iv, day_volume
     FROM options_quote_snapshots WHERE occ = ANY($1) AND quote_ts IS NOT NULL AND quote_ts >= $2`,
    occs, cutoff,
  );
  const out: Record<string, OptionQuote> = {};
  for (const r of rows) out[r.occ] = rowToQuote(r);
  return out;
}

/** Stored chain for one underlying inside a strike/expiry window, freshness-filtered. */
export async function getStoredChain(p: {
  underlying: string; expiryFrom: string; expiryTo: string; strikeMin: number; strikeMax: number; type?: "call" | "put";
}, now: Date = new Date()): Promise<OptionQuote[]> {
  await ensureQuoteStore();
  const cutoff = new Date(now.getTime() - MAX_QUOTE_AGE_MS);
  const rows = await prisma.$queryRawUnsafe<QuoteRow[]>(
    `SELECT occ, strike, expiry, opt_type, bid, ask, bid_size, ask_size, quote_ts, delta, theta, iv, day_volume
     FROM options_quote_snapshots
     WHERE symbol=$1 AND opt_type=$2 AND expiry >= $3 AND expiry <= $4
       AND strike >= $5 AND strike <= $6 AND quote_ts IS NOT NULL AND quote_ts >= $7
     ORDER BY expiry, strike`,
    p.underlying, p.type ?? "call", p.expiryFrom, p.expiryTo, p.strikeMin, p.strikeMax, cutoff,
  );
  return rows.map(rowToQuote);
}

// ---------- Chain requests ----------
export async function requestChain(p: {
  symbol: string; spot: number; budgetUsd: number;
  expiryFrom: string; expiryTo: string; strikeMin: number; strikeMax: number;
}): Promise<void> {
  await ensureQuoteStore();
  await prisma.$executeRawUnsafe(
    `INSERT INTO options_chain_requests (symbol, spot, budget_usd, expiry_from, expiry_to, strike_min, strike_max, requested_at, fulfilled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), NULL)
     ON CONFLICT (symbol) DO UPDATE SET
       spot=EXCLUDED.spot, budget_usd=EXCLUDED.budget_usd, expiry_from=EXCLUDED.expiry_from,
       expiry_to=EXCLUDED.expiry_to, strike_min=EXCLUDED.strike_min, strike_max=EXCLUDED.strike_max,
       requested_at=now(), fulfilled_at=NULL`,
    p.symbol, p.spot, p.budgetUsd, p.expiryFrom, p.expiryTo, p.strikeMin, p.strikeMax,
  );
}

export interface ChainRequest {
  symbol: string; spot: number; budgetUsd: number;
  expiryFrom: string; expiryTo: string; strikeMin: number; strikeMax: number; requestedAt: string;
}
/** Outstanding chain requests from the last 3 days. Older ones are dropped: the signal that
 *  asked for them has long since been re-evaluated, and fetching a stale request wastes the
 *  agent's read budget on a trade nobody wants any more. */
interface ChainReqRow {
  symbol: string; spot: number; budget_usd: number;
  expiry_from: string; expiry_to: string; strike_min: number; strike_max: number; requested_at: Date;
}
export async function pendingChainRequests(): Promise<ChainRequest[]> {
  await ensureQuoteStore();
  const rows = await prisma.$queryRawUnsafe<ChainReqRow[]>(
    `SELECT symbol, spot, budget_usd, expiry_from, expiry_to, strike_min, strike_max, requested_at
     FROM options_chain_requests
     WHERE fulfilled_at IS NULL AND requested_at > now() - interval '3 days'
     ORDER BY requested_at ASC`,
  );
  return rows.map((r) => ({
    symbol: r.symbol, spot: Number(r.spot), budgetUsd: Number(r.budget_usd),
    expiryFrom: r.expiry_from, expiryTo: r.expiry_to,
    strikeMin: Number(r.strike_min), strikeMax: Number(r.strike_max),
    requestedAt: new Date(r.requested_at).toISOString(),
  }));
}

export async function markChainFulfilled(symbols: string[]): Promise<void> {
  if (!symbols.length) return;
  await ensureQuoteStore();
  await prisma.$executeRawUnsafe(
    `UPDATE options_chain_requests SET fulfilled_at=now() WHERE symbol = ANY($1)`, symbols,
  );
}

/** Age of the freshest quote in the store — the page's "is this data live?" number.
 *  `stale` is decided HERE, against the same MAX_QUOTE_AGE_MS the reads enforce, so the
 *  banner and the actual behaviour can never disagree (and so the page needs no clock of
 *  its own during render). */
export interface QuoteStoreStatus { newestQuoteTs: string | null; rows: number; ageMinutes: number | null; stale: boolean }
export async function quoteStoreFreshness(now: Date = new Date()): Promise<QuoteStoreStatus> {
  await ensureQuoteStore();
  const [r] = await prisma.$queryRawUnsafe<{ newest: Date | null; n: bigint }[]>(
    `SELECT max(quote_ts) AS newest, count(*)::bigint AS n FROM options_quote_snapshots`,
  );
  const newest = r?.newest ?? null;
  const ageMs = newest ? now.getTime() - newest.getTime() : null;
  return {
    newestQuoteTs: newest ? newest.toISOString() : null,
    rows: Number(r?.n ?? 0),
    ageMinutes: ageMs == null ? null : Math.round(ageMs / 60_000),
    stale: ageMs == null || ageMs > MAX_QUOTE_AGE_MS,
  };
}

// ---------- ACCOUNT SNAPSHOT ----------
// The app cannot read the Robinhood account either, so the page shows what the agent last
// saw, WITH ITS AGE. `optionLevel` is carried because it decides what this book is even
// allowed to do: at option_level_2 only long premium is available, and the page should say
// so plainly until the Level 3 application clears.
export interface AccountSnapshot {
  accountNumber: string; type: string; optionLevel: string;
  cash: number; buyingPower: number; optionsValue: number; totalValue: number; at: string;
}
const ACCOUNT_KEY = "options_account_snapshot";

export async function saveAccountSnapshot(s: Omit<AccountSnapshot, "at">): Promise<void> {
  const payload: AccountSnapshot = { ...s, at: new Date().toISOString() };
  await prisma.agentConfig.upsert({
    where: { key: ACCOUNT_KEY },
    create: { key: ACCOUNT_KEY, value: JSON.stringify(payload) },
    update: { value: JSON.stringify(payload) },
  });
}

export async function readAccountSnapshot(): Promise<(AccountSnapshot & { minutesAgo: number }) | null> {
  const r = await prisma.agentConfig.findUnique({ where: { key: ACCOUNT_KEY } }).catch(() => null);
  if (!r?.value) return null;
  try {
    const s = JSON.parse(r.value) as AccountSnapshot;
    return { ...s, minutesAgo: Math.round((Date.now() - Date.parse(s.at)) / 60_000) };
  } catch { return null; }
}
