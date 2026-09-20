// THE LEDGER FOLD (pure). Tradovate's cash-balance log → one line per trade date. Kept free of I/O so it
// tests without a database; the store in trading-room-ledger.ts syncs and reads the rows.

export interface LedgerRow { id: number; ts: string; tradeDate: string | null; type: string; delta: number; realizedPnl: number | null; fillId: number | null; fillPairId: number | null }
export interface LedgerDay { day: string; trades: number; grossUsd: number; winUsd: number; lossUsd: number; feesUsd: number; otherUsd: number; netUsd: number; cumNetUsd: number; wins: number; losses: number; bestUsd: number; worstUsd: number }

const FEE_TYPES = new Set(["Commission", "ExchangeFee", "NfaFee", "ClearingFee"]);
const TRADE_TYPE = "TradePaired";

/** Pure: the broker's rows → one line per trade date. Fees are attributed to the day they posted; a day with no trades and no money movement is dropped. */
export function ledgerByDay(rows: LedgerRow[]): LedgerDay[] {
  const days = new Map<string, LedgerDay>();
  for (const r of rows) {
    const day = r.tradeDate ?? r.ts.slice(0, 10);
    const d = days.get(day) ?? { day, trades: 0, grossUsd: 0, winUsd: 0, lossUsd: 0, feesUsd: 0, otherUsd: 0, netUsd: 0, cumNetUsd: 0, wins: 0, losses: 0, bestUsd: 0, worstUsd: 0 };
    if (r.type === TRADE_TYPE) { d.trades++; d.grossUsd += r.delta; if (r.delta > 0) { d.wins++; d.winUsd += r.delta; } else if (r.delta < 0) { d.losses++; d.lossUsd += r.delta; } d.bestUsd = Math.max(d.bestUsd, r.delta); d.worstUsd = Math.min(d.worstUsd, r.delta); }
    else if (FEE_TYPES.has(r.type)) d.feesUsd += r.delta;
    else if (r.type !== "NewSession") d.otherUsd += r.delta;   // liquidation fees, subscriptions, deposits
    days.set(day, d);
  }
  const out = [...days.values()].filter((d) => d.trades > 0 || d.feesUsd !== 0 || d.otherUsd !== 0).sort((a, b) => a.day.localeCompare(b.day));
  let cum = 0;
  for (const d of out) { d.netUsd = d.grossUsd + d.feesUsd + d.otherUsd; cum += d.netUsd; d.cumNetUsd = cum; }
  return out;
}

// EVERY TRADE THE BROKER RECORDED. Tradovate books one "paired" row per entry-fill/exit-fill match, all at
// the exit's timestamp, so a 20-lot closed in one click shows as several rows in the same second. Rows
// closer than CLUSTER_MS apart are one trade here. Entry price, market and size live on fills, which the
// broker drops after the session — so a trade from before the room existed carries only what the ledger
// knows: when it closed, how many pairs, and the money.
export const TRADE_CLUSTER_MS = 90_000;
export interface LedgerTrade { id: number; exitTs: string; tradeDate: string | null; pairs: number; grossUsd: number; bestPairUsd: number; worstPairUsd: number; runningGrossUsd: number }
export function ledgerTrades(rows: LedgerRow[]): LedgerTrade[] {
  const paired = rows.filter((r) => r.type === TRADE_TYPE).sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
  const out: LedgerTrade[] = [];
  for (const r of paired) {
    const last = out[out.length - 1];
    if (last && Date.parse(r.ts) - Date.parse(last.exitTs) < TRADE_CLUSTER_MS) {
      last.exitTs = r.ts; last.pairs++; last.grossUsd += r.delta; last.bestPairUsd = Math.max(last.bestPairUsd, r.delta); last.worstPairUsd = Math.min(last.worstPairUsd, r.delta);
    } else out.push({ id: r.id, exitTs: r.ts, tradeDate: r.tradeDate, pairs: 1, grossUsd: r.delta, bestPairUsd: r.delta, worstPairUsd: r.delta, runningGrossUsd: 0 });
  }
  let run = 0;
  for (const t of out) { run += t.grossUsd; t.runningGrossUsd = run; }
  return out;
}
