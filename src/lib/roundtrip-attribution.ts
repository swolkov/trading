/**
 * ROUND-TRIP ATTRIBUTION — answers "which edge made or lost this money?"
 *
 * WHY THIS EXISTS (2026-08-02). RoundTrip is the CLEAN, broker-reconciled ledger and its schema
 * promises `setupType` and `rMultiple` "enriched later from the matching entry log". Nothing ever
 * did the enriching: 0 of 43 live round-trips had either field. So the only trustworthy P&L record
 * in the system could say THAT money was made but not WHICH edge made it — which forced every
 * scoreboard back onto autoTradeLog, a fragmented, partially-reconciled, historically double-logged
 * source. That is exactly why the admin showed 25 trades / 64% win while the clean ledger held
 * 43 / 56%.
 *
 * You cannot tell which edge to scale if you cannot attribute a dollar to an edge. This closes that.
 *
 * METHOD: the engine already writes a rich entry row to autoTradeLog (setup description, stop,
 * target, and an explicit "Risk: $N"). Match each round-trip back to its entry row on
 * symbol + direction + time + price, then parse. No schema migration, and it works retroactively on
 * rows already banked.
 */
import { prisma } from "./db";

/** Canonical setupType from the engine's own entry prose. Keys mirror the strings passed to
 *  evaluateAndTrade(), so the values line up with realtime-edges.ts matchers. */
const SETUP_PATTERNS: [RegExp, string][] = [
  [/trend pullback/i, "trend_continuation"],
  [/extreme rsi/i, "extreme_rsi_bounce"],
  [/or breakout|opening range/i, "or_breakout"],
  [/gap fill/i, "gap_fill"],
  [/failed ib/i, "failed_ib_breakout"],
  [/ib extension/i, "ib_extension"],
  [/vwap bounce/i, "vwap_bounce"],
  [/range bounce/i, "range_bounce"],
];

export function parseSetupType(reason: string): string | null {
  for (const [re, name] of SETUP_PATTERNS) if (re.test(reason)) return name;
  return null;
}

/** Intended dollar risk for the trade. Prefers the engine's own "Risk: $N" (authoritative — it is
 *  what the sizer actually budgeted); falls back to reconstructing from the logged stop. */
export function parseRiskDollars(reason: string, entryPrice: number, contracts: number, mult: number): number | null {
  const direct = reason.match(/Risk:\s*\$([\d,]+(?:\.\d+)?)/i);
  if (direct) {
    const v = parseFloat(direct[1].replace(/,/g, ""));
    if (v > 0) return v;
  }
  const stop = reason.match(/Stop:\s*\$([\d,]+(?:\.\d+)?)/i);
  if (stop && entryPrice > 0) {
    const sp = parseFloat(stop[1].replace(/,/g, ""));
    const dist = Math.abs(entryPrice - sp);
    if (dist > 0) return dist * mult * Math.max(1, contracts);
  }
  return null;
}

const MULT: Record<string, number> = {
  ES: 50, NQ: 20, GC: 100, YM: 5, RTY: 50,
  MES: 5, MNQ: 2, MGC: 10, MYM: 0.5, M2K: 5, MBT: 0.1,
};

export interface Attribution { setupType: string | null; rMultiple: number | null }

/**
 * Find the entry log row for a round-trip and derive its edge + R-multiple.
 * Matching is symbol + direction + a time window + price proximity — deliberately conservative:
 * a WRONG attribution is worse than a missing one, because it would silently credit an edge with
 * another edge's P&L and we would scale the wrong thing.
 */
export async function attributeRoundTrip(rt: {
  mode: string; symbol: string; direction: string; contracts: number;
  entryPrice: number; entryTime: Date; pnl: number;
}): Promise<Attribution> {
  const side = rt.direction === "long" ? "long" : "short";
  const from = new Date(rt.entryTime.getTime() - 6 * 60_000);
  const to = new Date(rt.entryTime.getTime() + 6 * 60_000);

  // 2026-08-11 FIX: `endsWith: rt.symbol` COLLIDED across contract sizes — "ES" matched "FUT:MES",
  // so a demo ES round-trip could adopt a LIVE MES micro's entry row (identical prices, so the
  // price-proximity tiebreak cannot discriminate) and inherit its tiny "Risk: $N". Verified case:
  // a clean −1.0R ES loss ($777 risked) labeled −4.9R from an MES row's $158. Exact symbol +
  // mode-exact action now; a missing match stays preferable to a wrong one.
  const candidates = await prisma.autoTradeLog.findMany({
    where: {
      symbol: `FUT:${rt.symbol}`,                                        // exact — no suffix collisions
      action: `${rt.mode === "live" ? "live" : "futures"}_${side}`,      // mode-exact entry action
      createdAt: { gte: from, lte: to },
    },
    orderBy: { createdAt: "asc" },
    select: { price: true, reason: true, createdAt: true },
  });
  if (candidates.length === 0) return { setupType: null, rMultiple: null };

  // Closest fill price wins; entry price is the most discriminating field when several setups fire
  // in the same window (the engine can evaluate MES and MNQ on the same bar).
  const best = candidates.reduce((a, b) =>
    Math.abs((b.price ?? 0) - rt.entryPrice) < Math.abs((a.price ?? 0) - rt.entryPrice) ? b : a);

  // Guard: if the nearest candidate is not actually near, refuse rather than guess.
  const tol = Math.max(rt.entryPrice * 0.002, 1);   // 20bps or 1 point
  if (Math.abs((best.price ?? 0) - rt.entryPrice) > tol) return { setupType: null, rMultiple: null };

  const setupType = parseSetupType(best.reason);
  const mult = MULT[rt.symbol] ?? 5;
  const risk = parseRiskDollars(best.reason, rt.entryPrice, rt.contracts, mult);
  const rMultiple = risk && risk > 0 ? Number((rt.pnl / risk).toFixed(3)) : null;
  return { setupType, rMultiple };
}
