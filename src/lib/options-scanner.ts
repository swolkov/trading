// OPTIONS PAPER BOOK — the scan: which underlyings are in a trend today, and which single
// contract on each one passes every liquidity and structure filter.
//
// Order of work matters for cost. The Donchian signal runs on DAILY bars, which arrive for
// the whole universe in one or two batched calls. Only the handful of names that actually
// fired get an option-chain request. On a normal day that is zero to three chain calls, not
// thirty-eight — which is what keeps this book inside a cron budget and inside the free
// data plan.
import { getDailyBars, getOptionChain } from "@/lib/alpaca-options";
import {
  MAX_DTE, MIN_DTE, OPTIONS_SYMBOLS, type Contract, type ContractPick,
  isEntrySignal, pickContract,
} from "@/lib/options-paper-model";

export interface TrendCandidate { symbol: string; close: number; bars: { t: string; c: number; h: number; l: number }[] }

/** Every universe name whose daily close just made a new 50-session high while above its
 *  200-day average. Returns the bars too so the caller does not refetch them. */
export async function scanTrendSignals(): Promise<{ candidates: TrendCandidate[]; scanned: number; errors: string[] }> {
  const errors: string[] = [];
  let bars: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> = {};
  try {
    bars = await getDailyBars([...OPTIONS_SYMBOLS], 420);
  } catch (e) {
    return { candidates: [], scanned: 0, errors: [`daily bars: ${String(e).slice(0, 120)}`] };
  }
  const candidates: TrendCandidate[] = [];
  for (const symbol of OPTIONS_SYMBOLS) {
    const b = bars[symbol];
    if (!b || b.length < 201) { if (!b) errors.push(`${symbol}: no bars`); continue; }
    const slim = b.map((x) => ({ t: x.t, c: x.c, h: x.h, l: x.l }));
    if (isEntrySignal(slim)) candidates.push({ symbol, close: b[b.length - 1].c, bars: slim });
  }
  return { candidates, scanned: Object.keys(bars).length, errors };
}

export interface ChainPick extends ContractPick { symbol: string; underlying: number; iv: number | null }

/**
 * The best in-the-money call on one underlying for a given SPENDABLE budget, or null.
 *
 * `budgetUsd` is the caller's real spending room — the smaller of the per-position budget
 * and what is left under the book cap. It is passed in rather than derived from reference
 * equity here, because selecting on the position budget alone picks the contract nearest
 * the target delta and only then discovers the book cannot afford it, when a slightly
 * cheaper contract one delta-step away would have passed every gate.
 *
 * The strike window is derived from delta, not guessed: a 0.70-0.85 delta call on a normal
 * equity is roughly 8-35% in the money, so the request asks for strikes between 60% and 97%
 * of spot and lets the delta filter in pickContract do the precise work.
 */
export async function pickContractFor(symbol: string, underlying: number, budgetUsd: number): Promise<ChainPick | null> {
  const now = Date.now();
  const from = new Date(now + MIN_DTE * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now + MAX_DTE * 86_400_000).toISOString().slice(0, 10);
  // `symbol` is the ticker the chain is requested for; `underlying` is its spot price and
  // only shapes the strike window. Keeping them distinct matters — an earlier draft passed
  // the price where the ticker belongs and a type assertion hid it.
  const quotes = await getOptionChain({
    underlying: symbol, expiryFrom: from, expiryTo: to,
    strikeMin: underlying * 0.60, strikeMax: underlying * 0.97, type: "call",
  });
  const candidates: Contract[] = quotes
    .filter((q) => q.delta != null)
    .map((q) => ({
      occ: q.occ, strike: q.strike, expiry: q.expiry, delta: q.delta as number,
      bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize,
    }));
  const pick = pickContract(candidates, budgetUsd);
  if (!pick) return null;
  const iv = quotes.find((q) => q.occ === pick.contract.occ)?.iv ?? null;
  return { ...pick, symbol, underlying, iv };
}
