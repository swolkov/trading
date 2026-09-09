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
export const OPTIONS_SIM_VERSION = "o1";
export const OPTIONS_COHORT_SQL = `sim_version='${OPTIONS_SIM_VERSION}'`;

// ---------- Sleeves ----------
// Two sleeves, IDENTICAL rules, different reference equity. Everything is expressed as a
// percentage of reference equity, so the only thing that differs is which contracts the
// sleeve can afford — and that difference IS the experiment. Do not "fix" one sleeve's
// parameters without the other; the comparison is the point.
export type OptionSource = "opt-1k" | "opt-5k";
export const OPTION_SOURCES: readonly OptionSource[] = ["opt-1k", "opt-5k"];
export const OPTION_SOURCE_LABELS: Record<OptionSource, string> = {
  "opt-1k": "$1,000 book — ITM calls, 60-120 DTE, trend",
  "opt-5k": "$5,000 book — same rules, 5× the equity",
};
export const OPTION_SOURCE_EQUITY: Record<OptionSource, number> = { "opt-1k": 1000, "opt-5k": 5000 };

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
/** Hard reject above this quoted round-trip spread. The screen's cheap names (F 8.2%,
 *  CCL 5.8-28%, CHPT 21.8%, OPEN 27.1%) all fail here — cheap contract ≠ cheap trade. */
export const MAX_SPREAD_PCT = 3.0;
/** A quote with no size behind it is not a price. */
export const MIN_QUOTE_SIZE = 1;

export interface Contract {
  occ: string; strike: number; expiry: string; delta: number;
  bid: number; ask: number; bidSize: number; askSize: number;
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
 *  structure filter, and affordable within the position budget. Returns null with no
 *  fallback: "nothing tradeable today" is a valid and common answer for this book. */
export function pickContract(candidates: Contract[], budgetUsd: number): ContractPick | null {
  let best: ContractPick | null = null;
  for (const c of candidates) {
    if (!(c.bid > 0 && c.ask > 0 && c.ask >= c.bid)) continue;
    if (!(c.delta >= MIN_DELTA && c.delta <= MAX_DELTA)) continue;
    if (!(c.bidSize >= MIN_QUOTE_SIZE && c.askSize >= MIN_QUOTE_SIZE)) continue;
    const spreadPct = spreadPctOf(c.bid, c.ask);
    if (!(spreadPct <= MAX_SPREAD_PCT)) continue;
    const costUsd = entryCostUsd(c.ask);
    if (costUsd > budgetUsd) continue;
    if (!best || Math.abs(c.delta - TARGET_DELTA) < Math.abs(best.contract.delta - TARGET_DELTA)) {
      best = { contract: c, costUsd, spreadPct };
    }
  }
  return best;
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

// ---------- Exits ----------
// Three of them, checked in this order. There is deliberately NO profit target: the rule
// being tested is trend-following, and capping the winners is what turns a trend rule
// negative. The premium stop exists only to stop a dead position bleeding to zero, and
// the DTE floor exists because time decay accelerates sharply in the last few weeks —
// the single structural fact that makes short-dated options a bad instrument.
export const DTE_FLOOR = 21;
export const PREMIUM_STOP_FRAC = 0.50;
export type ExitReason = "trend exit" | "dte floor" | "premium stop" | null;

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
export function dteOf(expiry: string, now: Date): number {
  const exp = new Date(`${expiry}T21:00:00Z`).getTime();
  // FLOOR, not ceil: rounding time-remaining DOWN is the conservative direction for the
  // DTE_FLOOR exit — it can only ever close a position a day early, never a day late into
  // the accelerating-decay window that the floor exists to avoid.
  return Math.floor((exp - now.getTime()) / 86_400_000);
}
