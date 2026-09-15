// MARKET ALIGNMENT for the options desk (Sep 15 2026) — pure, no I/O except the one VIX reader.
//
// "Broad market first": every candidate carries where SPY and QQQ sit against their 20/50-day
// averages and what they did on the signal day, so the record can later say whether alignment
// mattered. ONE rule is pre-registered as a live veto — a bullish single-name entry is refused when
// SPY closed below its 20-day average AND fell 1.5% or more on the day (mirror for bearish) — and
// one intraday check refuses an entry against a 1.5% SPY move in progress. Everything else is a
// stamp. Missing or stale data stamps "unknown" and never vetoes: this layer is fail-soft by
// design; the earnings rule (options-events.ts) is the fail-closed one.
import type { ResearchBar } from "./options-desk-model";

export const OPTIONS_MARKET_RULES = {
  vetoDayPct: 1.5,          // close-to-close move on the signal day that, with the wrong side of the 20-day, vetoes
  shockPct: 1.5,            // intraday SPY move against the trade at the moment of entry
  indexEtfs: ["SPY", "QQQ", "IWM"],   // the veto is for single names; an ETF breakout IS the market
  staleDays: 4,
  maxQuoteAgeMs: 15 * 60_000,   // an intraday quote older than this is "unavailable": stamped stale, never a veto
  vixTimeoutMs: 8_000,          // the guard loop must never stall on Yahoo
};
export type Direction = "bullish" | "bearish";
export interface IndexState { day: string | null; close: number | null; sma20: number | null; sma50: number | null; dayPct: number | null; regime: "above" | "below" | "unknown" }
/** The plain-data stamp a candidate and the desk state carry. */
export interface MarketStamp { spy: IndexState; qqq: IndexState; vix: number | null }
export interface MarketState extends MarketStamp { alignedFor(direction: Direction): { aligned: boolean | null; vetoed: boolean; reason: string } }
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const UNKNOWN: IndexState = { day: null, close: null, sma20: null, sma50: null, dayPct: null, regime: "unknown" };

export function indexState(bars: ResearchBar[] | undefined, now: number, rules = OPTIONS_MARKET_RULES): IndexState {
  if (!bars || bars.length < 21) return UNKNOWN;
  const last = bars[bars.length - 1], prev = bars[bars.length - 2];
  if (!(last.close > 0) || !(prev.close > 0) || now - Date.parse(`${last.day}T21:00:00Z`) > rules.staleDays * 86_400_000 || Date.parse(last.day) > now) return UNKNOWN;
  const sma20 = mean(bars.slice(-20).map((b) => b.close)), sma50 = bars.length >= 50 ? mean(bars.slice(-50).map((b) => b.close)) : null;
  return { day: last.day, close: last.close, sma20: round(sma20), sma50: sma50 == null ? null : round(sma50), dayPct: round((last.close / prev.close - 1) * 100), regime: last.close >= sma20 ? "above" : "below" };
}
/** The pre-registered veto, on the stamp alone so the runner and the screen read one rule. */
export function marketVeto(stamp: MarketStamp, direction: Direction, symbol: string, rules = OPTIONS_MARKET_RULES): { aligned: boolean | null; vetoed: boolean; reason: string } {
  const s = stamp.spy;
  if (s.regime === "unknown" || s.dayPct == null) return { aligned: null, vetoed: false, reason: "SPY bars unavailable or stale — market state unknown, no veto" };
  const aligned = direction === "bullish" ? s.regime === "above" : s.regime === "below";
  const line = `SPY ${s.regime} its 20-day (${s.close} vs ${s.sma20}) and ${s.dayPct >= 0 ? "+" : ""}${s.dayPct}% on ${s.day}`;
  if (rules.indexEtfs.includes(symbol)) return { aligned, vetoed: false, reason: `${line}; ${symbol} is an index ETF — the veto is for single names` };
  const against = direction === "bullish" ? s.regime === "below" && s.dayPct <= -rules.vetoDayPct : s.regime === "above" && s.dayPct >= rules.vetoDayPct;
  return { aligned, vetoed: against, reason: against ? `${line} — ${direction} single-name entries refused` : line };
}
export function marketState(bars: { SPY?: ResearchBar[]; QQQ?: ResearchBar[] }, vix: number | null, now: number, rules = OPTIONS_MARKET_RULES): MarketState {
  const stamp: MarketStamp = { spy: indexState(bars.SPY, now, rules), qqq: indexState(bars.QQQ, now, rules), vix: vix != null && Number.isFinite(vix) && vix > 0 ? round(vix) : null };
  return { ...stamp, alignedFor: (direction) => marketVeto(stamp, direction, "", rules) };
}
/** Intraday shock at the moment of entry: SPY's move from its previous close, against the trade. No quote → no veto, said so. */
export function intradayShock(quote: { last: number; previousClose: number; atMs: number } | null, direction: Direction, now: number, rules = OPTIONS_MARKET_RULES): { vetoed: boolean; movePct: number | null; stale: boolean; reason: string } {
  if (!quote || !(quote.last > 0) || !(quote.previousClose > 0)) return { vetoed: false, movePct: null, stale: false, reason: "SPY quote unavailable — shock check skipped (stamped unknown)" };
  if (!(now - quote.atMs <= rules.maxQuoteAgeMs)) return { vetoed: false, movePct: null, stale: true, reason: `SPY quote is ${((now - quote.atMs) / 60_000).toFixed(0)} min old — shock check skipped (stamped stale)` };
  const movePct = round((quote.last / quote.previousClose - 1) * 100);
  const against = direction === "bullish" ? movePct <= -rules.shockPct : movePct >= rules.shockPct;
  return { vetoed: against, movePct, stale: false, reason: against ? `SPY ${movePct >= 0 ? "+" : ""}${movePct}% intraday against a ${direction} entry` : `SPY ${movePct >= 0 ? "+" : ""}${movePct}% intraday` };
}
export const directionOfKind = (kind: string): Direction => (kind === "long_call" || kind === "call_debit" || kind === "put_credit" ? "bullish" : "bearish");

/** VIX close from Yahoo, stamped only. null on any failure. NEVER cross-asset.ts, which fabricates VIX=20 when the read fails. */
export async function vixLevel(fetchBars?: (symbol: string, days: number) => Promise<{ c: number }[]>, timeoutMs = OPTIONS_MARKET_RULES.vixTimeoutMs): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async () => { const fetch = fetchBars ?? (await import("./yahoo")).getHistoricalBars; return fetch("^VIX", 10); })();
    const bars = await Promise.race([read, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
    const last = bars?.at(-1)?.c;
    return typeof last === "number" && Number.isFinite(last) && last > 0 ? round(last) : null;
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}
