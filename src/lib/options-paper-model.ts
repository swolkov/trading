// OPTIONS PAPER BOOK — the model. PURE: no database, no network, no imports. Everything a
// unit test needs to pin down lives here; options-shadow.ts does the I/O.
//
// WHY THIS EXISTS (Sep 8 2026). Spencer asked whether a $1k options account could be grown
// "super high" alongside the Kraken margin desk, and named WULF and CRWV. A screen of 63
// symbols against real Alpaca quotes, greeks and 90-day realized vol produced three facts
// that shape every rule below:
//
//   1. FRICTION, NOT STRATEGY, IS THE BINDING COST. Round-trip quoted spread on the liquid
//      in-the-money contracts is 2.2-2.9%; Kraken's is 0.34%. At 4-6 round trips a month
//      that is 12-17% of the account per month in spread alone — unrecoverable. At 1-2
//      trades a month on 60-120 day holds it is 3-6%. So this book is deliberately
//      LOW-FREQUENCY and LONG-HOLD, and the entry cap is enforced in code (MAX_ENTRIES_PER_MONTH).
//
//   2. THE GOOD NAMES ARE UNAFFORDABLE AT $1k. Ranked by expected 90-day move ÷ spread, the
//      top of the screen was CRWV ($3,139/contract, 0.1% spread, 98% realized vol), PLTR
//      ($3,534), IREN ($1,744), MRVL ($7,518), INTC ($3,157). $1k cannot buy CRWV at ANY
//      delta — even the 0.50-delta at-the-money Dec call was $1,457. That is arithmetic,
//      not judgement, and it is the whole reason this book runs TWO sleeves at different
//      reference equity: the gap between them measures what account size is actually worth
//      in this strategy, instead of anyone asserting it.
//
//   3. CORRELATION IS NOT WHERE IT LOOKS. Measured over 90 days, the miners have DECOUPLED
//      from bitcoin — WULF 0.09 to BTC, CRWV 0.01, HUT 0.07, CIFR 0.11, IREN 0.17. They now
//      trade as an AI-datacenter/power complex, so they ARE a genuine diversifier against
//      the Kraken crypto book. But MSTR (0.76) and COIN (0.73) still ARE bitcoin, and MARA
//      is half of one (0.44) — those are excluded outright, because a sleeve whose purpose
//      is to be uncorrelated with the crypto desk must not quietly re-buy the crypto desk.
//      Within the datacenter complex the names are 0.55-0.84 correlated with EACH OTHER
//      (WULF-CIFR 0.84, CRWV-NBIS 0.82), so only ONE position per group may be open at once.
//
// This book touches NOTHING in the Kraken margin system: separate tables, separate config
// keys, separate cron, separate page, separate Slack lane, and no import from any margin-*
// module. It is a measurement record, not an executor — no order is ever placed anywhere.

// ---------- Universe + correlation groups ----------
// Groups come from the measured 90-day correlation matrix, not from sector labels. Only one
// position per group may be open at a time: holding WULF + IREN + APLD is one bet in
// triplicate, which is the exact mistake the crypto book made with correlated alt shorts in
// early September.
export type CorrGroup = "ai-datacenter" | "semis" | "megacap" | "fintech" | "consumer" | "index" | "speculative";

export interface OptionName { symbol: string; group: CorrGroup }

// Excluded on purpose, with the measured reason — see fact 3 above. Kept as data (not
// deleted) so the exclusion is visible on the page and cannot be silently undone.
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

// Measurement cohort stamp — bump when contract selection, costs or exits change
// materially. Aggregates fail CLOSED to this exact value, exactly as the other books do.
// o2 (Sep 10 2026): Level 3 approval landed, so the book can now build VERTICAL DEBIT
// SPREADS when a naked call does not fit the budget, and the $1,000 sleeve was retired in
// favour of $3,500. Both change what gets traded, so the sample restarts rather than
// blending two rule sets. The o1 rows stay in the table as history; open o1 positions are
// still managed to their natural exit (see evaluateOptionsPaper) — a rule change is not a
// reason to abandon a live position.
export const OPTIONS_SIM_VERSION = "o2";
export const OPTIONS_COHORT_SQL = `sim_version='${OPTIONS_SIM_VERSION}'`;

// ---------- Sleeves ----------
// Two sleeves, IDENTICAL rules, different reference equity. Everything is expressed as a
// percentage of reference equity, so the only thing that differs is which contracts the
// sleeve can afford — and that difference IS the experiment. Do not "fix" one sleeve's
// parameters without the other; the comparison is the point.
// The $1,000 sleeve was RETIRED on Sep 10 2026. It had done its job: the screen proved a
// $1k book can almost never open a position, which measures the wall rather than the
// strategy. $3,500 replaces it because that is the size actually under consideration, and
// it still brackets $5,000 so the size comparison survives.
// BEARISH SLEEVES ARE SEPARATE SLEEVES, not a flag on the existing ones. Long and short are
// different strategies with different evidence, and every per-sleeve mechanism this book
// already has — the monthly entry cap, the correlation-group rule, the book premium cap, the
// verdict — keys on `source`. Separate sources therefore give complete separation for free,
// and make it impossible for a bearish result to be pooled into the bullish record.
//
// The bearish rule is the exact mirror, deliberately: a new 50-session LOW while BELOW the
// 200-day average, exited on a 25-session high. Same numbers, opposite sign — so if it fails
// it fails as a fair test of the mirror rather than of a differently-tuned rule.
export type OptionSource = "opt-3.5k" | "opt-5k" | "opt-3.5k-bear" | "opt-5k-bear";
export const OPTION_SOURCES: readonly OptionSource[] = ["opt-3.5k", "opt-5k", "opt-3.5k-bear", "opt-5k-bear"];
export const OPTION_SOURCE_LABELS: Record<OptionSource, string> = {
  "opt-3.5k": "$3,500 long book — ITM calls, call debit or put credit spreads, 60-120 DTE",
  "opt-5k": "$5,000 long book — same rules, more equity",
  "opt-3.5k-bear": "$3,500 short book — ITM puts, put debit or call credit spreads, the mirrored signal",
  "opt-5k-bear": "$5,000 short book — same rules, more equity",
};
export const OPTION_SOURCE_EQUITY: Record<OptionSource, number> = {
  "opt-3.5k": 3500, "opt-5k": 5000, "opt-3.5k-bear": 3500, "opt-5k-bear": 5000,
};
/** Bearish sleeves are suffixed, so direction is derivable anywhere a source string reaches. */
export function isBearishSource(source: string | null | undefined): boolean {
  return typeof source === "string" && source.endsWith("-bear");
}

// ---------- Contract selection ----------
// In-the-money "stock replacement" calls, NOT out-of-the-money lottery tickets. Rationale
// from the screen: at delta 0.78 most of the premium is intrinsic, so time decay is a small
// fraction of the position; ITM strikes carry the tightest quoted spreads; and no stop-loss
// order is needed because the premium itself is the floor. Out-of-the-money contracts have
// the opposite of every one of those properties and are how small options accounts die.
export const TARGET_DELTA = 0.78;
export const MIN_DELTA = 0.70;
export const MAX_DELTA = 0.85;
export const MIN_DTE = 60;
export const MAX_DTE = 120;

/**
 * EARNINGS BLACKOUT (added 2026-09-09). Do not OPEN a position in the run-up to a scheduled
 * earnings report.
 *
 * A long call is a bet on direction AND on implied volatility. Into a print, IV inflates —
 * the market prices the coming jump — and after it, IV collapses whether or not the stock
 * moved your way. Buying in that window pays a premium that is engineered to evaporate.
 * With 60–120 DTE the report will usually fall INSIDE the hold; that is fine and expected,
 * because a call bought at post-print IV carries the next print at a fair price. The thing
 * to avoid is the ENTRY landing in the inflated window. Fourteen days is where the run-up
 * measurably begins for names at this vol level.
 *
 * The one position in the book when this was added — IREN, entered at 97.6% IV — is the
 * shape of trade this exists to stop from becoming a pattern in the record.
 */
export const EARNINGS_BLACKOUT_DAYS = 14;

/** True when `symbol` has a scheduled report within the blackout window from `now`. Pure. */
export function inEarningsBlackout(
  symbol: string,
  calendar: readonly { symbol: string; date: string }[],
  now: Date,
  days = EARNINGS_BLACKOUT_DAYS,
): { blocked: boolean; date?: string } {
  const start = now.getTime();
  const end = start + days * 86_400_000;
  const hit = calendar
    .filter((e) => e.symbol.toUpperCase() === symbol.toUpperCase())
    .map((e) => ({ date: e.date, t: Date.parse(e.date + "T12:00:00Z") }))
    .filter((e) => Number.isFinite(e.t) && e.t >= start - 86_400_000 && e.t <= end)   // a report dated today still counts
    .sort((a, b) => a.t - b.t)[0];
  return hit ? { blocked: true, date: hit.date } : { blocked: false };
}
/** Hard reject above this quoted round-trip spread. The screen's cheap names (F 8.2%,
 *  CCL 5.8-28%, CHPT 21.8%, OPEN 27.1%) all fail here — cheap contract ≠ cheap trade. */
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

/** Choose the contract closest to TARGET_DELTA among those passing every liquidity and
 *  structure filter, and affordable within `budgetUsd`. Returns null with no fallback:
 *  "nothing tradeable today" is a valid and common answer for this book.
 *
 *  `budgetUsd` must be the SMALLER of the position budget and the room left under the book
 *  cap. Passing only the position budget lets this pick a $500 contract that the book cap
 *  then refuses, when a $295 contract one delta-step away would have passed everything —
 *  a silently missed entry rather than a bad one, but a missed entry all the same. */
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
export const MAX_POSITION_PCT = 0.55;
export const MAX_BOOK_PCT = 0.80;
export const MAX_CONCURRENT = 3;
/** LOW-FREQUENCY BY CONSTRUCTION — see fact 1. Two entries per calendar month, per sleeve. */
export const MAX_ENTRIES_PER_MONTH = 2;

export function positionBudget(refEquity: number): number {
  return refEquity * MAX_POSITION_PCT;
}
export interface BookState { openCount: number; openPremium: number; entriesThisMonth: number; openGroups: readonly string[] }
export type EntryRefusal =
  | "max concurrent positions" | "book premium cap" | "monthly entry cap"
  | "correlated position already open" | "already open" | "no contract passes filters";

/** Every book-level gate in one pure function, so the tests pin the exact refusal reason. */
export function entryRefusal(book: BookState, group: string | null, refEquity: number, costUsd: number): EntryRefusal | null {
  if (book.entriesThisMonth >= MAX_ENTRIES_PER_MONTH) return "monthly entry cap";
  if (book.openCount >= MAX_CONCURRENT) return "max concurrent positions";
  if (group && book.openGroups.includes(group)) return "correlated position already open";
  if (costUsd > positionBudget(refEquity) + 1e-9) return "no contract passes filters";
  if (book.openPremium + costUsd > refEquity * MAX_BOOK_PCT + 1e-9) return "book premium cap";
  return null;
}

// ---------- The signal ----------
// Donchian breakout on DAILY bars, long only. This is the daily analogue of the ONE rule
// that ever survived out-of-sample testing in this project (long-only Donchian 100/50 on
// 60-minute bars, t = 2.93 — see the trend-survivor research). Parameters are
// PRE-REGISTERED at the conventional 50/25 and must not be tuned on this book's own
// results; that is how the earlier options work talked itself into a curve fit.
export const DONCHIAN_ENTRY = 50;
export const DONCHIAN_EXIT = 25;
export const TREND_FILTER = 200;

export interface Bar { t: string; c: number; h: number; l: number }
/** Entry: today's close is the highest close of the last DONCHIAN_ENTRY sessions AND above
 *  the 200-day average. The trend filter is what keeps the rule from buying breakouts
 *  inside a downtrend, which is where long-only Donchian does its losing. */
export function isEntrySignal(bars: Bar[]): boolean {
  if (bars.length < TREND_FILTER + 1) return false;
  const closes = bars.map((b) => b.c);
  const last = closes[closes.length - 1];
  const window = closes.slice(-DONCHIAN_ENTRY);
  const sma = closes.slice(-TREND_FILTER).reduce((s, c) => s + c, 0) / TREND_FILTER;
  return last >= Math.max(...window) && last > sma;
}
/** Exit: today's close is the lowest close of the last DONCHIAN_EXIT sessions. */
export function isExitSignal(bars: Bar[]): boolean {
  if (bars.length < DONCHIAN_EXIT) return false;
  const closes = bars.map((b) => b.c);
  return closes[closes.length - 1] <= Math.min(...closes.slice(-DONCHIAN_EXIT));
}

/** The mirror of isEntrySignal: a new DONCHIAN_ENTRY-session LOW while BELOW the 200-day
 *  average. The trend filter does the same job in reverse — it keeps the rule from shorting
 *  a dip inside an uptrend, which is where short Donchian does its losing. */
export function isBearishEntrySignal(bars: Bar[]): boolean {
  if (bars.length < TREND_FILTER + 1) return false;
  const closes = bars.map((b) => b.c);
  const last = closes[closes.length - 1];
  const window = closes.slice(-DONCHIAN_ENTRY);
  const sma = closes.slice(-TREND_FILTER).reduce((s, c) => s + c, 0) / TREND_FILTER;
  return last <= Math.min(...window) && last < sma;
}

/** The mirror of isExitSignal: a DONCHIAN_EXIT-session HIGH ends a bearish position. */
export function isBearishExitSignal(bars: Bar[]): boolean {
  if (bars.length < DONCHIAN_EXIT) return false;
  const closes = bars.map((b) => b.c);
  return closes[closes.length - 1] >= Math.max(...closes.slice(-DONCHIAN_EXIT));
}

/** The exit rule that applies to a position, chosen by its sleeve's direction. */
export function trendExitFor(source: string | null | undefined, bars: Bar[]): boolean {
  return isBearishSource(source) ? isBearishExitSignal(bars) : isExitSignal(bars);
}

// ---------- Exits ----------
// Three of them, checked in this order. There is deliberately NO profit target: the rule
// being tested is trend-following, and capping the winners is what turns a trend rule
// negative. The premium stop exists only to stop a dead position bleeding to zero, and
// the DTE floor exists because time decay accelerates sharply in the last few weeks —
// the single structural fact that makes short-dated options a bad instrument.
export const DTE_FLOOR = 21;
export const PREMIUM_STOP_FRAC = 0.50;
export type ExitReason = "trend exit" | "dte floor" | "premium stop" | "assignment risk" | null;

export function exitReason(p: { trendExit: boolean; dte: number; markUsd: number; costUsd: number }): ExitReason {
  if (p.trendExit) return "trend exit";
  if (p.dte <= DTE_FLOOR) return "dte floor";
  if (p.costUsd > 0 && p.markUsd <= p.costUsd * PREMIUM_STOP_FRAC) return "premium stop";
  return null;
}

// ---------- Verdict ladder ----------
// Identical wording and thresholds to the crypto and stock books, so "REAL EDGE" means the
// same thing on every desk. 30 resolved, positive net, t >= 2, spanning 7+ distinct days.
// NOTE the honest arithmetic: at 2 entries per sleeve per month, 30 resolved trades is
// roughly 15 months. This book is a slow instrument by design and the page says so.
export function optionsVerdict(resolved: number, net: number, tStat: number | null, days: number): string {
  if (resolved < 30) return `gathering (${resolved}/30)`;
  if (net <= 0) return "not paying";
  if (tStat != null && tStat >= 2) {
    if (days < 7) return `promising — significant, needs ${7 - days} more day${7 - days === 1 ? "" : "s"} of data`;
    return "REAL EDGE — significant";
  }
  return "promising (could be luck)";
}
export function tStatOf(mean: number | null, std: number | null, n: number): number | null {
  return n > 1 && mean != null && std != null && std > 0 ? (mean * Math.sqrt(n)) / std : null;
}

/** Days to expiry from an OCC-style YYYY-MM-DD expiry string, at a given instant. */
/** The ET calendar date at an instant, as YYYY-MM-DD. Expiries are calendar dates, so every
 *  comparison against one has to be done in calendar terms or it drifts by a day. */
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
