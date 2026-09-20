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
