// OPTIONS MODEL — pricing, quotes, structures and settlement. PURE: no database, no network,
// no imports. The live Robinhood desk (structure engine, quote store, risk ladder) and its
// money-invariant tests import from here.
//
// HISTORY. This began (Sep 8 2026) as the model behind a paper options book that measured
// whether a small account could grow on 60–120 DTE stock-replacement calls. Three findings
// from that screen still shape the rules kept below:
//   1. FRICTION IS THE BINDING COST — quoted round-trip spread 2.2–2.9% on liquid ITM legs,
//      so a wide spread is a hard reject and a quote with no size behind it is not a price.
//   2. IN-THE-MONEY LEGS (0.70–0.85 delta) hold most of their premium as intrinsic value: the
//      premium itself is the floor, and those strikes carry the tightest spreads.
//   3. CORRELATION IS NOT WHERE IT LOOKS — the miners decoupled from bitcoin and trade as an
//      AI-datacenter/power complex, 0.55–0.84 correlated with EACH OTHER, so the risk ladder
//      allows one position per group.
// The paper book itself (sleeves, Donchian signal, book caps, verdict ladder) was retired on
// Sep 21 2026; the live desk had already replaced every one of those rules with its own.
// ---------- Universe + correlation groups ----------
// Groups come from the measured 90-day correlation matrix, not from sector labels. Only one
// position per group may be open at a time: holding WULF + IREN + APLD is one bet in
// triplicate, which is the exact mistake the crypto book made with correlated alt shorts in
// early September.
export type CorrGroup = "ai-datacenter" | "semis" | "megacap" | "fintech" | "consumer" | "index" | "speculative";

export interface OptionName { symbol: string; group: CorrGroup }

// Excluded on purpose, with the measured reason — see finding 3 above. Kept as data so the
// exclusion stays visible and cannot be silently undone.
export const CRYPTO_PROXY_EXCLUDED: Record<string, string> = {
  MSTR: "0.76 correlation to BTC — this is the Kraken book with extra leverage",
  COIN: "0.73 correlation to BTC — same bet as the Kraken book",
  MARA: "0.44 correlation to BTC — half the Kraken book",
  CLSK: "0.32 correlation to BTC — partly the Kraken book",
  RIOT: "0.25 correlation to BTC — partly the Kraken book",
};

export const OPTIONS_UNIVERSE: readonly OptionName[] = [
  // AI-datacenter / power complex — decoupled from BTC (0.01-0.17), correlated 0.55-0.84 to each other
  { symbol: "CRWV", group: "ai-datacenter" }, { symbol: "WULF", group: "ai-datacenter" },
  { symbol: "IREN", group: "ai-datacenter" }, { symbol: "APLD", group: "ai-datacenter" },
  { symbol: "CIFR", group: "ai-datacenter" }, { symbol: "HUT",  group: "ai-datacenter" },
  { symbol: "NBIS", group: "ai-datacenter" }, { symbol: "VRT",  group: "ai-datacenter" },
  { symbol: "SMCI", group: "ai-datacenter" },
  // Semis
  { symbol: "NVDA", group: "semis" }, { symbol: "AMD",  group: "semis" }, { symbol: "MU",   group: "semis" },
  { symbol: "MRVL", group: "semis" }, { symbol: "INTC", group: "semis" }, { symbol: "ARM",  group: "semis" },
  { symbol: "ON",   group: "semis" },
  // Mega-cap tech
  { symbol: "AAPL", group: "megacap" }, { symbol: "MSFT", group: "megacap" }, { symbol: "GOOGL", group: "megacap" },
  { symbol: "AMZN", group: "megacap" }, { symbol: "META", group: "megacap" }, { symbol: "TSLA",  group: "megacap" },
  { symbol: "PLTR", group: "megacap" }, { symbol: "AVGO", group: "megacap" },
  // Fintech
  { symbol: "SOFI", group: "fintech" }, { symbol: "HOOD", group: "fintech" },
  { symbol: "AFRM", group: "fintech" }, { symbol: "PYPL", group: "fintech" },
  // Consumer / industrial — the genuinely uncorrelated corner (UBER ≈ 0.05 to BTC, 0.20 to SPY)
  { symbol: "UBER", group: "consumer" }, { symbol: "DKNG", group: "consumer" },
  { symbol: "RBLX", group: "consumer" }, { symbol: "CCL",  group: "consumer" },
  // Index ETFs — the baseline. Unaffordable at $1k; included so the $5k sleeve can hold one.
  { symbol: "SPY", group: "index" }, { symbol: "QQQ", group: "index" }, { symbol: "IWM", group: "index" },
  // High-vol speculative — one slot at most, ever
  { symbol: "RKLB", group: "speculative" }, { symbol: "IONQ", group: "speculative" },
  { symbol: "SOUN", group: "speculative" }, { symbol: "ACHR", group: "speculative" },
];
export const OPTIONS_SYMBOLS: readonly string[] = OPTIONS_UNIVERSE.map((n) => n.symbol);
export function groupOf(symbol: string): CorrGroup | null {
  return OPTIONS_UNIVERSE.find((n) => n.symbol === symbol)?.group ?? null;
}

// ---------- The long-leg delta band ----------
// It is a BAND, not a target. Selection used to take the leg nearest 0.78; since Sep 10 2026
// the structure engine takes the best return at the market's own expected move from among the
// legs inside the band, so there is no longer a single delta being aimed at. The old
// TARGET_DELTA constant was removed rather than left to imply a rule that no longer runs.
export const MIN_DELTA = 0.70;
export const MAX_DELTA = 0.85;

export const MAX_SPREAD_PCT = 3.0;
/** A quote with no size behind it is not a price. Enforced on BOTH sides: at entry when
 *  choosing a contract, and again at exit — a bid of $6.00 with zero size behind it would
 *  otherwise book a profit that nobody was ever willing to pay. */
export const MIN_QUOTE_SIZE = 1;
/** A quote older than this is stale and may not be used to open or close a position.
 *  Yesterday's quote on an untraded strike is not today's price. */
export const MAX_QUOTE_AGE_MS = 36 * 3600_000;
export function isQuoteFresh(quoteTs: string | null | undefined, now: Date): boolean {
  if (!quoteTs) return false;
  const t = Date.parse(quoteTs);
  return Number.isFinite(t) && now.getTime() - t <= MAX_QUOTE_AGE_MS;
}
/** The exit-side gate: a bid we could actually hit, quoted recently. */
export function canExitAt(q: { bid: number; bidSize: number; quoteTs?: string | null }, now: Date): boolean {
  return q.bid > 0 && q.bidSize >= MIN_QUOTE_SIZE && isQuoteFresh(q.quoteTs, now);
}

export interface Contract {
  occ: string; strike: number; expiry: string; delta: number;
  bid: number; ask: number; bidSize: number; askSize: number;
  /** When the broker published this leg's quote. Optional on the type so unit tests can build
   *  contracts without one, but the scanner ALWAYS supplies it: without it the multi-leg skew
   *  check in options-structures.ts silently has nothing to check. */
  quoteTs?: string | null;
}
export interface ContractPick { contract: Contract; costUsd: number; spreadPct: number }

export function spreadPctOf(bid: number, ask: number): number {
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : Infinity;
}
/** Entry pays the ASK, exit receives the BID — the real NBBO on both sides. This is why the
 *  book needs no modeled fee: the spread IS the cost, and it is quoted, not estimated. */
export function entryCostUsd(ask: number, contracts = 1): number {
  return ask * 100 * contracts + REG_FEE_PER_CONTRACT * contracts;
}
export function exitProceedsUsd(bid: number, contracts = 1): number {
  return bid * 100 * contracts - REG_FEE_PER_CONTRACT * contracts;
}
/** Alpaca charges no options commission; regulatory/exchange pass-throughs are ~$0.03-0.05
 *  per contract per side. Charged both ways at the conservative end. */
export const REG_FEE_PER_CONTRACT = 0.05;

/** The quote gates every leg must pass, long or short: a real two-sided market, size behind
 *  both sides, and a quoted spread inside the ceiling. Extracted so the short leg of a
 *  vertical is held to exactly the same standard as the long — a tight long against a
 *  garbage short is not a tradeable spread. */
export function tradeable(c: Contract): boolean {
  if (!(c.bid > 0 && c.ask > 0 && c.ask >= c.bid)) return false;
  if (!(c.bidSize >= MIN_QUOTE_SIZE && c.askSize >= MIN_QUOTE_SIZE)) return false;
  return spreadPctOf(c.bid, c.ask) <= MAX_SPREAD_PCT;
}

// ---------- Vertical spread cash flows ----------
// The SELECTION of a spread moved to options-structures.ts on Sep 10 2026 — it compares every
// shape and every expiry against the market's own expected move, which this file's simpler
// "closest to target delta that fits the budget" rule could not do. Only the cash-flow
// arithmetic stays here, because it is the vocabulary the rest of the book is written in.
//
// The compromise a vertical represents has not changed and is not hidden: this book has no
// take-profit precisely because capping winners is what turns a trend rule negative, and a
// vertical caps the winner by construction. It is used when the naked call will not fit the
// budget, which below roughly $4,500 is most of the time on a liquid name. Every row records
// its structure so the record can settle whether the cap cost more than it bought.

/** Net cash to open a vertical: pay the long's ask, receive the short's bid, both legs' fees. */
export function spreadDebitUsd(longAsk: number, shortBid: number, contracts = 1): number {
  return (longAsk - shortBid) * 100 * contracts + 2 * REG_FEE_PER_CONTRACT * contracts;
}
/** Net cash to close a vertical: receive the long's bid, pay the short's ask, both legs' fees.
 *  The gross is floored at zero — a vertical cannot be worth less than nothing, and a crossed
 *  or stale pair of quotes must not book a loss deeper than the debit. */
export function spreadProceedsUsd(longBid: number, shortAsk: number, contracts = 1): number {
  return Math.max(0, (longBid - shortAsk) * 100 * contracts) - 2 * REG_FEE_PER_CONTRACT * contracts;
}

// ---------- Credit structures: the inverted money math ----------
//
// A debit position is one you PAID for: your risk is the cash out, and the position is worth
// whatever you can sell it for. A credit position is one you were PAID for: your risk is the
// COLLATERAL the broker holds, and the position is a liability you must buy back.
//
// Getting this backwards does not throw. It books a loss as a profit. So the whole thing is
// funnelled through ONE definition that both kinds share:
//
//     mark = capital at risk + unrealised P&L
//
// For a debit position that reduces to "what it is worth today", which is exactly what the
// original single-leg book already stored — so every existing exit rule, the peak tracker and
// the premium stop keep working untouched, and a credit spread that has lost half its
// collateral trips the same stop as a call that has lost half its premium.
export type StoredStructure =
  | "call" | "call_spread" | "put_credit_spread"          // bullish
  | "put" | "put_spread" | "call_credit_spread";          // bearish

export function isCreditStructure(structure: string | null | undefined): boolean {
  return structure === "put_credit_spread" || structure === "call_credit_spread";
}

/**
 * Whether a structure's LEGS are puts. This is not the same question as whether the position
 * is bearish, and conflating the two is how settlement silently inverts:
 *
 *   put_credit_spread  — legs are PUTS,  position is BULLISH
 *   call_credit_spread — legs are CALLS, position is BEARISH
 *
 * Settlement depends on the leg type, never on the direction.
 */
export function isPutStructure(structure: string | null | undefined): boolean {
  return structure === "put" || structure === "put_spread" || structure === "put_credit_spread";
}

/** Cash received opening a credit spread: sell the short leg at its bid, buy the protective
 *  long at its ask, both legs paying a fee. */
export function spreadCreditUsd(shortBid: number, longAsk: number, contracts = 1): number {
  return (shortBid - longAsk) * 100 * contracts - 2 * REG_FEE_PER_CONTRACT * contracts;
}

/**
 * Cash to close a credit spread right now: buy the short leg back at its ask, sell the long
 * leg at its bid, both legs paying a fee.
 *
 * FLOORED AT ZERO **AND CAPPED AT THE WIDTH** (`maxUsd`, which is collateral + credit). The
 * cap is not cosmetic and does not need a crossed market to matter — mere parity does it.
 * Short 95p / long 90p on a $5 wide spread with the stock at 82.50 quotes 12.60 ask / 7.40
 * bid: crossing both legs costs $5.20 of a $5.00-wide spread. Without the cap that books a
 * 105% loss on a defined-risk position, contradicting settleAtExpiry (which caps at the
 * collateral) and poisoning every average return that includes it. A vertical is worth at
 * most its width; quotes implying more are a market you would not trade into.
 */
export function creditCloseCostUsd(shortAsk: number, longBid: number, maxUsd: number, contracts = 1): number {
  const gross = Math.max(0, (shortAsk - longBid) * 100 * contracts) + 2 * REG_FEE_PER_CONTRACT * contracts;
  return Math.min(gross, Math.max(0, maxUsd) * contracts);
}

/**
 * The one mark definition. `capitalAtRiskUsd` is the debit for a debit position and the
 * collateral (width − credit) for a credit one; `creditUsd` is zero unless it is a credit.
 *
 * Floored at zero: a defined-risk position cannot be worth negative capital, and a crossed or
 * stale pair of quotes must never mark one below its own maximum loss.
 */
export function positionMarkUsd(p: {
  structure: string | null;
  capitalAtRiskUsd: number;
  creditUsd: number;
  longBid: number;
  shortAsk?: number | null;
  contracts?: number;
}): number {
  const n = p.contracts ?? 1;
  if (isCreditStructure(p.structure)) {
    // width === collateral + credit, always — so the cap needs no extra argument.
    //
    // FEES ARE EXCLUDED HERE, deliberately and symmetrically with the debit side: a debit
    // position marks at bid × 100 and only pays its exit fee when it actually closes. The
    // mark answers "what is this worth", not "what would I net after closing it".
    const width = p.capitalAtRiskUsd + p.creditUsd;
    const grossToClose = Math.min(Math.max(0, ((p.shortAsk ?? 0) - p.longBid) * 100 * n), width * n);
    return Math.max(0, p.capitalAtRiskUsd + p.creditUsd - grossToClose);
  }
  const value = p.shortAsk != null
    ? Math.max(0, (p.longBid - p.shortAsk) * 100 * n)
    : p.longBid * 100 * n;
  return Math.max(0, value);
}

/** The moves a payoff grid is shown at. Lives here, beside settleAtExpiry, because the grid
 *  is built from STORED positions rather than from selection candidates. */
export const SCENARIO_MOVES = [-0.10, -0.05, -0.02, 0, 0.02, 0.05, 0.10] as const;

export interface ScenarioPoint { move: number; price: number; pnl: number }

/**
 * What this position is worth at expiry if the underlying moves by each of SCENARIO_MOVES.
 *
 * Terminal values only — no attempt to model what it is worth BEFORE expiry, which would
 * need a price model this book deliberately does not use. Stated on the page rather than
 * implied, so nobody reads a −2% row as "what happens tomorrow".
 */
export function scenarioGrid(p: {
  structure: string | null; longStrike: number; shortStrike?: number | null;
  widthUsd?: number | null; capitalAtRiskUsd: number; creditUsd: number; spot: number;
}): ScenarioPoint[] {
  if (!(p.spot > 0)) return [];
  return SCENARIO_MOVES.map((move) => {
    const price = p.spot * (1 + move);
    return { move, price, pnl: settleAtExpiry({ ...p, close: price }).pnlUsd };
  });
}

/**
 * Settlement at expiry from the underlying's close on the expiry date.
 *
 * Returns the position's terminal VALUE (what the capital at risk turned into) and the P&L,
 * so the caller books one number and displays the other without re-deriving either.
 *
 * `longStrike` is always the leg we bought. For a put credit spread that is the LOWER strike —
 * the protective one — and `shortStrike` is the higher strike we sold.
 */
export function settleAtExpiry(p: {
  structure: string | null;
  longStrike: number;
  shortStrike?: number | null;
  widthUsd?: number | null;
  close: number;
  capitalAtRiskUsd: number;
  creditUsd: number;
}): { valueUsd: number; pnlUsd: number } {
  const puts = isPutStructure(p.structure);
  if (isCreditStructure(p.structure)) {
    // The short leg is the one that can hurt, and WHICH WAY depends on the leg type: a short
    // PUT loses as the close falls through its strike, a short CALL as the close rises through
    // it. Capped at the width either way — beyond the long leg the two cancel.
    const short = p.shortStrike ?? p.longStrike;
    const width = p.widthUsd ?? Math.abs(short - p.longStrike) * 100;
    const through = puts ? (short - p.close) : (p.close - short);
    const loss = Math.min(Math.max(0, through * 100), width);
    const pnlUsd = p.creditUsd - loss;
    return { valueUsd: Math.max(0, p.capitalAtRiskUsd + pnlUsd), pnlUsd };
  }
  // Debit: intrinsic on the long leg — which for a put is strike MINUS close — capped at the
  // width when there is a short leg beyond it.
  const rawIntrinsic = Math.max(0, puts ? (p.longStrike - p.close) : (p.close - p.longStrike)) * 100;
  const cap = p.shortStrike != null && p.widthUsd != null ? p.widthUsd : Infinity;
  const valueUsd = Math.min(rawIntrinsic, cap);
  return { valueUsd, pnlUsd: valueUsd - p.capitalAtRiskUsd };
}

// ---------- Position budget + book caps ----------
// A single option position can go to zero, so these percentages are of PREMIUM AT RISK, not
// of notional — 40% of the book in one contract is genuinely 40% at risk. That is high by
// any normal standard, and it is stated rather than hidden: at $1k there is no alternative,
// because the cheapest tradeable ITM contracts in the screen were $286-532. The $5k sleeve
// runs the identical percentage and is therefore less concentrated in dollar-risk terms per
// name — which is one of the things this experiment is measuring.
// 55%, not a more respectable-looking 40%: at 40% the $1k sleeve's budget is $400, and the
// screen's tradeable contracts start at $399 (SOFI) and run to $532 (WULF) — so a 40% cap
// silently produces a sleeve that can almost never open a position, which measures nothing.
// A unit test caught exactly that. The honest statement is that $1k cannot hold a
// diversified options book at all, and the cap says so out loud instead of hiding it behind
// a sleeve that never trades. MAX_BOOK_PCT still binds at 80%, so in practice this is one
// full-size position plus a small one, never three at 55%.

export function etDateOf(at: Date): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function dayNumber(isoDate: string): number {
  return Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10))) / 86_400_000;
}
/**
 * Whole CALENDAR days from today (ET) to the expiry date. Zero on expiry day itself,
 * negative after it.
 *
 * An earlier version subtracted timestamps and floored the result, which made a Dec-18
 * expiry read as 0 DTE when the cron ran at 22:00 UTC on Dec 17 — settling a day early,
 * every time, because that is exactly when the cron runs. Calendar dates in, calendar days
 * out; no clock arithmetic to get wrong.
 */
export function dteOf(expiry: string, now: Date): number {
  return dayNumber(expiry) - dayNumber(etDateOf(now));
}
