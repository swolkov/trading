// ============ UNIFIED FUTURES MARKET DATA ============
// Primary: Tradovate md/getChart (same broker = most reliable)
// Fallback: Yahoo Finance (for symbols/intervals Tradovate can't serve)
//
// All futures data consumers use this module instead of Yahoo directly.
// Contract resolution is cached to avoid repeated Tradovate API calls.

import { findContract, getBars as tradovateBars, getQuote as tradovateQuote, type BarData, TRADOVATE_CONTRACTS } from "./tradovate";
import type { TradingMode } from "./trading-mode";

// Lazy-load Yahoo only when needed (keeps Tradovate-only deploys clean)
let _yahoo: typeof import("./yahoo") | null = null;
async function getYahoo() {
  if (!_yahoo) _yahoo = await import("./yahoo");
  return _yahoo;
}

// Lazy-load yahoo-finance2 for quote() calls (shared instance)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _yf: { quote: (symbols: string[] | string) => Promise<any> } | null = null;
function getYf() {
  if (!_yf) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const YFClass = require("yahoo-finance2").default || require("yahoo-finance2");
    _yf = new YFClass({ suppressNotices: ["ripHistorical"] });
  }
  return _yf!;
}

// Yahoo symbol mapping (fallback only)
const YAHOO_MAP: Record<string, string> = {
  ES: "ES=F", NQ: "NQ=F", YM: "YM=F", RTY: "RTY=F", GC: "GC=F",
  MES: "ES=F", MNQ: "NQ=F", MYM: "YM=F", M2K: "RTY=F", MGC: "GC=F",
};

// ── Contract ID Cache ────────────────────────────────────
// Avoids repeated /contract/suggest calls. Cleared on process restart.

const contractCache = new Map<string, { id: number; name: string; tickSize: number }>();

export async function resolveContract(symbol: string, modeOverride?: TradingMode): Promise<{ id: number; name: string; tickSize: number } | null> {
  const cached = contractCache.get(symbol);
  if (cached) return cached;
  const contract = await findContract(symbol, modeOverride);
  if (contract) contractCache.set(symbol, contract);
  return contract;
}

// Pre-resolve a list of symbols (call at startup to warm cache)
export async function warmContractCache(symbols: string[]): Promise<void> {
  await Promise.allSettled(symbols.map((s) => resolveContract(s)));
}

// ── Intraday Bars (5m, 15m, 1h) ────────────────────────

export async function getFuturesIntradayBars(
  symbol: string,
  interval: "5m" | "15m" | "1h" = "5m",
  range: "1d" | "5d" = "1d",
  modeOverride?: TradingMode,
): Promise<BarData[]> {
  // Map interval + range to Tradovate bar params
  const barSize = interval === "5m" ? "5min" : interval === "15m" ? "15min" : "1h";
  const barsPerDay = interval === "5m" ? 78 : interval === "15m" ? 26 : 7;
  const days = range === "5d" ? 5 : 1;
  const count = barsPerDay * days;

  // Try Tradovate first
  try {
    const contract = await resolveContract(symbol, modeOverride);
    if (contract) {
      const bars = await tradovateBars(contract.id, count, barSize, modeOverride);
      if (bars.length > 0) return bars;
    }
  } catch (err) {
    console.warn(`[futures-data] Tradovate intraday failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
  }

  // Fallback: Yahoo Finance
  const yahooSym = YAHOO_MAP[symbol];
  if (!yahooSym) return [];
  try {
    const yahoo = await getYahoo();
    return await yahoo.getIntradayBars(yahooSym, interval, range);
  } catch (err) {
    console.warn(`[futures-data] Yahoo intraday also failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ── Daily Bars (historical) ─────────────────────────────

export async function getFuturesDailyBars(
  symbol: string,
  days: number = 60,
  modeOverride?: TradingMode,
): Promise<{ t: string; o: number; h: number; l: number; c: number; v: number }[]> {
  // Try Tradovate first
  try {
    const contract = await resolveContract(symbol, modeOverride);
    if (contract) {
      const bars = await tradovateBars(contract.id, days, "1d", modeOverride);
      if (bars.length > 0) {
        // Convert unix seconds back to ISO string for daily bar format
        return bars.map((b) => ({
          t: new Date(b.t * 1000).toISOString(),
          o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
        }));
      }
    }
  } catch (err) {
    console.warn(`[futures-data] Tradovate daily failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
  }

  // Fallback: Yahoo Finance
  const yahooSym = YAHOO_MAP[symbol];
  if (!yahooSym) return [];
  try {
    const yahoo = await getYahoo();
    return await yahoo.getHistoricalBars(yahooSym, days);
  } catch (err) {
    console.warn(`[futures-data] Yahoo daily also failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ── Live Quote (single symbol) ──────────────────────────

export interface FuturesQuote {
  symbol: string;
  price: number;
  volume: number;
  bid: number;
  ask: number;
  source: "tradovate" | "yahoo" | "none";
}

export async function getFuturesQuote(symbol: string, modeOverride?: TradingMode): Promise<FuturesQuote> {
  // Try Tradovate
  try {
    const contract = await resolveContract(symbol, modeOverride);
    if (contract) {
      const q = await tradovateQuote(contract.id, modeOverride);
      if (q.last > 0) return { symbol, price: q.last, volume: q.volume, bid: q.bid, ask: q.ask, source: "tradovate" };
    }
  } catch { /* fall through */ }

  // Fallback: Yahoo
  const yahooSym = YAHOO_MAP[symbol];
  if (yahooSym) {
    try {
      const q = await getYf().quote(yahooSym);
      if (q?.regularMarketPrice) {
        return {
          symbol,
          price: q.regularMarketPrice,
          volume: q.regularMarketVolume || 0,
          bid: q.bid || 0,
          ask: q.ask || 0,
          source: "yahoo",
        };
      }
    } catch { /* fall through */ }
  }

  return { symbol, price: 0, volume: 0, bid: 0, ask: 0, source: "none" };
}

// ── Batch Quotes (multiple symbols) ─────────────────────

export async function getFuturesQuotes(symbols: string[], modeOverride?: TradingMode): Promise<Record<string, FuturesQuote>> {
  const results: Record<string, FuturesQuote> = {};

  // Try Tradovate in parallel
  const tradovateResults = await Promise.allSettled(
    symbols.map(async (sym) => {
      const contract = await resolveContract(sym, modeOverride);
      if (!contract) return null;
      const q = await tradovateQuote(contract.id, modeOverride);
      if (q.last > 0) return { sym, quote: { symbol: sym, price: q.last, volume: q.volume, bid: q.bid, ask: q.ask, source: "tradovate" as const } };
      return null;
    })
  );

  const needYahoo: string[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const r = tradovateResults[i];
    if (r.status === "fulfilled" && r.value) {
      results[r.value.sym] = r.value.quote;
    } else {
      needYahoo.push(symbols[i]);
    }
  }

  // Batch fallback via Yahoo
  if (needYahoo.length > 0) {
    try {
      const yahooSymbols = needYahoo.map((s) => YAHOO_MAP[s]).filter(Boolean);
      if (yahooSymbols.length > 0) {
        const quotes = await getYf().quote(yahooSymbols);
        const arr = Array.isArray(quotes) ? quotes : [quotes];
        const yahooMap: Record<string, { price: number; volume: number; bid: number; ask: number }> = {};
        for (const q of arr) {
          if (q?.symbol && q?.regularMarketPrice) {
            yahooMap[q.symbol] = {
              price: q.regularMarketPrice, volume: q.regularMarketVolume || 0,
              bid: q.bid || 0, ask: q.ask || 0,
            };
          }
        }
        for (const sym of needYahoo) {
          const ySym = YAHOO_MAP[sym];
          const yq = ySym ? yahooMap[ySym] : null;
          if (yq) {
            results[sym] = { symbol: sym, ...yq, source: "yahoo" };
          } else {
            results[sym] = { symbol: sym, price: 0, volume: 0, bid: 0, ask: 0, source: "none" };
          }
        }
      }
    } catch {
      for (const sym of needYahoo) {
        if (!results[sym]) results[sym] = { symbol: sym, price: 0, volume: 0, bid: 0, ask: 0, source: "none" };
      }
    }
  }

  return results;
}

// ── Dashboard-friendly quote (matches old Yahoo route shape) ──

// Day-trade margins (approximate, broker-dependent)
const DAY_MARGINS: Record<string, number> = {
  ES: 12_650, NQ: 18_700, GC: 10_200, YM: 9_900, RTY: 7_150,
  MES: 1_265, MNQ: 1_870, MGC: 1_020, MYM: 990, M2K: 715,
};

export interface DashboardQuote {
  symbol: string;
  name: string;
  multiplier: number;
  tickSize: number;
  margin: number;
  price: number;
  change: number;
  changePercent: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  bid: number;
  ask: number;
  timestamp: string;
  source: "tradovate" | "yahoo" | "none";
}

export async function getDashboardQuotes(symbols: string[]): Promise<DashboardQuote[]> {
  const results: DashboardQuote[] = [];

  for (const sym of symbols) {
    const spec = TRADOVATE_CONTRACTS[sym];
    if (!spec) continue;

    // Try to get a recent bar for OHLC + change data
    let price = 0, open = 0, high = 0, low = 0, volume = 0, prevClose = 0, bid = 0, ask = 0;
    let source: "tradovate" | "yahoo" | "none" = "none";

    try {
      const contract = await resolveContract(sym);
      if (contract) {
        // Get 2 daily bars (today + yesterday) for change calculation
        const bars = await tradovateBars(contract.id, 2, "1d");
        if (bars.length >= 1) {
          const today = bars[bars.length - 1];
          price = today.c; open = today.o; high = today.h; low = today.l; volume = today.v;
          if (bars.length >= 2) prevClose = bars[bars.length - 2].c;
          source = "tradovate";
        }
      }
    } catch { /* fall through */ }

    // Fallback: Yahoo
    if (price === 0) {
      const yahooSym = YAHOO_MAP[sym];
      if (yahooSym) {
        try {
          const q = await getYf().quote(yahooSym);
          if (q?.regularMarketPrice) {
            price = q.regularMarketPrice;
            open = q.regularMarketOpen || 0;
            high = q.regularMarketDayHigh || 0;
            low = q.regularMarketDayLow || 0;
            volume = q.regularMarketVolume || 0;
            prevClose = q.regularMarketPreviousClose || 0;
            bid = q.bid || 0;
            ask = q.ask || 0;
            source = "yahoo";
          }
        } catch { /* no data */ }
      }
    }

    const change = prevClose > 0 ? price - prevClose : 0;
    const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;

    results.push({
      symbol: sym, name: spec.name, multiplier: spec.multiplier, tickSize: spec.tickSize, margin: DAY_MARGINS[sym] || 0,
      price, change, changePercent, prevClose, open, high, low, volume, bid, ask,
      timestamp: new Date().toISOString(), source,
    });
  }

  return results;
}
