// OPTIONS DATA — the Robinhood-era replacement for `alpaca-options.ts`.
//
// The public surface is deliberately IDENTICAL to the Alpaca adapter it replaces
// (`DailyBar`, `getDailyBars`, `OptionQuote`, `parseOcc`, `getOptionChain`,
// `getOptionQuotes`) so the scanner, the shadow evaluator, the model, the caps, the
// universe and the verdict are all untouched by the move. Only where the numbers come
// from changed.
//
// The split is not arbitrary — it follows what Robinhood can and cannot do from a server:
//
//   UNDERLYING DAILY BARS  → Yahoo, fetched live, server-side. The Donchian trend signal
//     never needed a broker; Alpaca was just the feed that happened to be wired. Yahoo is
//     free, already used elsewhere in this repo, and returns split-adjusted daily bars,
//     which is what the 50-high / 200-day filter reads. So the cron keeps working exactly
//     as before for signal detection.
//
//   OPTION CHAINS AND QUOTES → the push inbox in `options-quote-store.ts`. These genuinely
//     cannot be fetched from a server: Robinhood's only official route is an OAuth MCP
//     bound to a Claude session. A scheduled agent pushes them in. When the scanner wants a
//     chain it does not have, it FILES A REQUEST and returns nothing this tick; the agent
//     fills it and the next tick proceeds. At two entries per sleeve per month on 60-120
//     day holds, that latency is immaterial.
//
// Everything here fails toward "no data" rather than toward a guess. An empty chain means
// no entry; a missing quote means a position is left alone. Both are already handled by the
// callers, and both are far safer than a modelled price.
import { getHistoricalBars } from "@/lib/yahoo";
import { parseOcc, toOcc } from "@/lib/options-occ";
import {
  getStoredChain, getStoredQuotes, requestChain, type OptionQuote,
} from "@/lib/options-quote-store";

export type { OptionQuote };
// OCC is an exchange standard, not a vendor format — it lives in a pure module so the
// paper-book tests can exercise it without a database. Re-exported here so the two
// consumers keep importing everything data-shaped from one place.
export { parseOcc, toOcc };
export interface DailyBar { t: string; o: number; h: number; l: number; c: number; v: number }

/** Daily bars for many symbols, split-adjusted. Yahoo is per-symbol, so this fans out with
 *  a small concurrency cap — enough to keep a 38-name universe inside the cron budget,
 *  low enough not to get rate-limited. A symbol that fails is simply absent; the scanner
 *  already reports "no bars" for it rather than treating it as a signal. */
export async function getDailyBars(symbols: string[], days = 420): Promise<Record<string, DailyBar[]>> {
  const out: Record<string, DailyBar[]> = {};
  const queue = [...symbols];
  const CONCURRENCY = 6;
  async function worker() {
    for (;;) {
      const symbol = queue.shift();
      if (!symbol) return;
      try {
        const bars = await getHistoricalBars(symbol, days);
        if (bars.length) out[symbol] = bars;
      } catch { /* absent, not zero — see the header */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, worker));
  for (const bars of Object.values(out)) bars.sort((a, b) => a.t.localeCompare(b.t));
  return out;
}


/**
 * One underlying's chain inside a strike and expiry window, read from the push inbox.
 *
 * If nothing fresh is stored, this FILES A REQUEST and returns an empty array. That is the
 * one behavioural difference from the Alpaca adapter, and the callers already treat an
 * empty chain as "no contract passes filters" — a quiet tick, not an error.
 */
export async function getOptionChain(p: {
  underlying: string; expiryFrom: string; expiryTo: string; strikeMin: number; strikeMax: number;
  type?: "call" | "put"; budgetUsd?: number; spot?: number;
}): Promise<OptionQuote[]> {
  const stored = await getStoredChain(p);
  if (stored.length) return stored;
  await requestChain({
    symbol: p.underlying, spot: p.spot ?? 0, budgetUsd: p.budgetUsd ?? 0,
    expiryFrom: p.expiryFrom, expiryTo: p.expiryTo, strikeMin: p.strikeMin, strikeMax: p.strikeMax,
  });
  return [];
}

/** Current quotes for contracts already held — the mark for open positions. Freshness is
 *  enforced inside the store, so a contract the agent has not refreshed simply does not
 *  appear here and its position is left untouched. */
export async function getOptionQuotes(occs: string[]): Promise<Record<string, OptionQuote>> {
  return getStoredQuotes(occs);
}
