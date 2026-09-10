// OPTIONS PAPER BOOK — the scan: which underlyings are in a trend today, and which single
// contract on each one passes every liquidity and structure filter.
//
// Order of work matters for cost. The Donchian signal runs on DAILY bars, which arrive for
// the whole universe in one or two batched calls. Only the handful of names that actually
// fired get an option-chain request. On a normal day that is zero to three chain calls, not
// thirty-eight — which is what keeps this book inside a cron budget and inside the free
// data plan.
import { getDailyBars, getOptionChain } from "@/lib/rh-options-data";
import {
  MAX_DTE, MIN_DTE, OPTIONS_SYMBOLS, type Contract, type StoredStructure,
  isEntrySignal,
} from "@/lib/options-paper-model";
import {
  type Candidate, atmOf, buildCandidates, expectedMove, selectStructure,
} from "@/lib/options-structures";

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

/** What the scan hands the opener. `short` and `widthUsd` are present only for a vertical —
 *  see options-structures.ts: the engine compares every shape and expiry on real quotes. */
export interface ChainPick {
  structure: StoredStructure;
  /** Always the leg we BUY — the ITM call, or the protective lower-strike put of a credit
   *  spread. The storage convention depends on this: `occ` is what we bought. */
  contract: Contract;
  short?: Contract;
  /** Capital at risk: the debit, or the collateral (width − credit) for a credit spread. */
  costUsd: number;
  creditUsd: number;
  spreadPct: number;
  widthUsd?: number;
  /** Half the quoted spread on EVERY leg — the real cost of getting in. `spreadPct` describes
   *  the long leg alone, which on a credit spread is the cheap protective one. */
  crossingUsd: number;
  symbol: string; underlying: number; iv: number | null;
}

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
 * of spot and lets the structure engine's delta band do the precise work.
 */
export async function pickContractFor(symbol: string, underlying: number, budgetUsd: number): Promise<ChainPick | null> {
  const now = Date.now();
  const from = new Date(now + MIN_DTE * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now + MAX_DTE * 86_400_000).toISOString().slice(0, 10);
  // `symbol` is the ticker the chain is requested for; `underlying` is its spot price and
  // only shapes the strike window. Keeping them distinct matters — an earlier draft passed
  // the price where the ticker belongs and a type assertion hid it.
  //
  // The call window runs from deep in the money (the long leg) out past spot (the short leg
  // of a vertical). Puts are fetched in a narrow band around spot for one reason only: the
  // at-the-money straddle is what gives the expected move, and the expected move is the
  // yardstick every structure is ranked against.
  const [calls, puts] = await Promise.all([
    getOptionChain({
      underlying: symbol, expiryFrom: from, expiryTo: to,
      strikeMin: underlying * 0.60, strikeMax: underlying * 1.30, type: "call",
      budgetUsd, spot: underlying,
    }),
    getOptionChain({
      underlying: symbol, expiryFrom: from, expiryTo: to,
      // Wide enough for put credit spreads (short just below spot, long below that) as well
      // as the at-the-money straddle that supplies the expected move.
      strikeMin: underlying * 0.80, strikeMax: underlying * 1.08, type: "put",
      budgetUsd, spot: underlying,
    }),
  ]);
  if (!calls.length) return null;

  // quoteTs is carried through so the multi-leg skew check has something to check. Dropping
  // it here is what let a vertical be assembled from two quotes 36 hours apart.
  const asContract = (q: (typeof calls)[number]): Contract => ({
    occ: q.occ, strike: q.strike, expiry: q.expiry, delta: q.delta ?? 0,
    bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, quoteTs: q.quoteTs,
  });
  const callContracts = calls.filter((q) => q.delta != null).map(asContract);
  const putContracts = puts.map(asContract);

  // COMPARE EVERY LISTED EXPIRY IN THE WINDOW, rather than defaulting to the nearest one.
  // Each expiry is judged against ITS OWN expected move, because a 60-day move and a
  // 120-day move are not the same benchmark.
  const expiries = [...new Set(callContracts.map((c) => c.expiry))].sort();
  let best: { cand: Candidate; ret: number; iv: number | null } | null = null;
  for (const expiry of expiries) {
    const em = expectedMove(atmOf(callContracts, underlying, expiry), atmOf(putContracts, underlying, expiry), underlying);
    // No straddle, no yardstick, no trade on that expiry. Guessing one would put a modelled
    // number at the centre of a book whose whole claim is that it never models a price.
    if (em == null || !(em > 0)) continue;
    const cands = buildCandidates({
      calls: callContracts, puts: putContracts, spot: underlying, expiry, budgetUsd,
      // All three BULLISH shapes now that the position lifecycle handles a credit position
      // (see positionMarkUsd / settleAtExpiry). Bearish shapes stay off: the only entry signal
      // this desk has validated is a long trend break, and its own crypto record found the
      // mirrored short lost on every slice.
      //
      // Note what the ranking does here without being told to: a put credit spread's ceiling
      // is the credit, so its return at the expected move is usually far below a debit
      // spread's. It only wins when the debit alternatives are genuinely poor — which is the
      // right way round, given this desk's July finding that premium selling is not durable.
      kinds: ["long_call", "call_debit", "put_credit"],
    });
    const sel = selectStructure(cands, underlying, em);
    if (!sel) continue;
    if (!best || sel.returnAtRef > best.ret) best = { cand: sel.best, ret: sel.returnAtRef, iv: null };
  }
  if (!best) return null;

  const longLeg = best.cand.legs.find((l) => l.side === "buy")!.contract;
  const shortLeg = best.cand.legs.find((l) => l.side === "sell")?.contract;
  // EXHAUSTIVE, and it THROWS on anything unmapped. The previous expression defaulted every
  // two-legged shape to "call_spread" — a DEBIT label. A call credit spread stored that way
  // runs entirely on debit arithmetic: settleAtExpiry takes the debit branch and books a
  // full-width LOSS as a full-width PROFIT. A put debit spread stored that way settles off
  // `close − longStrike`, which is backwards for a put. Both were unreachable only because
  // the `kinds` list below happens to exclude them, which is not a safeguard — it is luck.
  // Enabling a bearish shape must fail loudly here, not silently invert its sign.
  const STORED_FOR_KIND: Record<string, StoredStructure | undefined> = {
    long_call: "call",
    call_debit: "call_spread",
    put_credit: "put_credit_spread",
  };
  const structure = STORED_FOR_KIND[best.cand.kind];
  if (!structure) {
    throw new Error(
      `options: structure "${best.cand.kind}" has no storage mapping. The position lifecycle ` +
      `only handles long calls, call debit spreads and put credit spreads. Add explicit ` +
      `storage, marking and settlement for it before enabling it in the kinds list.`,
    );
  }
  // The implied vol worth recording is the one the trade is ABOUT: for a debit position that
  // is the vol we bought (the long leg); for a credit position it is the vol we SOLD (the
  // short leg). Searching only the calls array left every credit row with a null IV, because
  // its legs are puts.
  const ivLeg = structure === "put_credit_spread" ? (shortLeg ?? longLeg) : longLeg;
  const iv = [...calls, ...puts].find((q) => q.occ === ivLeg.occ)?.iv ?? null;

  return {
    structure,
    contract: longLeg,
    short: shortLeg,
    costUsd: best.cand.capitalAtRiskUsd,
    creditUsd: best.cand.creditUsd,
    crossingUsd: best.cand.crossingCostUsd,
    spreadPct: ((longLeg.ask - longLeg.bid) / ((longLeg.ask + longLeg.bid) / 2)) * 100,
    widthUsd: shortLeg ? Math.abs(shortLeg.strike - longLeg.strike) * 100 : undefined,
    symbol, underlying, iv,
  };
}
