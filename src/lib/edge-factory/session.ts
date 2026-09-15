// New York session structure over a bar array — the pieces the prompt's intraday families read:
// the 09:30 ET open, the opening range, the prior RTH day's high/low, the overnight range and the
// session VWAP. Every function walks BACK from an index and never reads a later bar.
import type { ResearchBar } from "./types";

export interface EtStamp { date: string; hour: number; minute: number; /** minutes since midnight ET */ tod: number }

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const etCache = new Map<number, EtStamp>();
export function et(t: number): EtStamp {
  const cached = etCache.get(t); if (cached) return cached;
  const parts: Record<string, string> = {};
  for (const part of etFormatter.formatToParts(t)) parts[part.type] = part.value;
  const hour = Number(parts.hour) % 24, minute = Number(parts.minute);
  const value = { date: `${parts.year}-${parts.month}-${parts.day}`, hour, minute, tod: hour * 60 + minute };
  etCache.set(t, value); return value;
}

export const RTH_OPEN = 9 * 60 + 30;
export const RTH_CLOSE = 16 * 60;
export const GLOBEX_OPEN = 18 * 60;

/** The bar stamped exactly 09:30 ET on the same ET date as `bars[index]`, searching back at most
 *  `maxBack` bars. −1 when the index is before the open or the open bar is missing (a holiday, a gap). */
export function rthOpenIndex(bars: readonly ResearchBar[], index: number, maxBack: number): number {
  const stamp = et(bars[index].t);
  if (stamp.tod < RTH_OPEN) return -1;
  for (let i = index; i >= Math.max(0, index - maxBack); i--) {
    const s = et(bars[i].t);
    if (s.date !== stamp.date || s.tod < RTH_OPEN) return -1;
    if (s.tod === RTH_OPEN) return i;
  }
  return -1;
}

/** Bars left until 16:00 ET from a bar that starts at `tod` — the time stop for a session trade (≥ 1). */
export function barsToRthClose(tod: number, barMinutes: number): number {
  return Math.max(1, Math.floor((RTH_CLOSE - tod) / barMinutes));
}

export interface SessionRange { high: number; low: number; close: number; startIndex: number; endIndex: number }

/** The previous ET date's 09:30–16:00 bars (walking back from the open bar), or null when none are found
 *  inside `maxBack` bars. */
export function priorRthRange(bars: readonly ResearchBar[], openIndex: number, maxBack: number): SessionRange | null {
  let i = openIndex - 1;
  const floor = Math.max(0, openIndex - maxBack);
  while (i >= floor) {
    const s = et(bars[i].t);
    if (s.tod >= RTH_OPEN && s.tod < RTH_CLOSE) break;
    i--;
  }
  if (i < floor) return null;
  const date = et(bars[i].t).date;
  const out: SessionRange = { high: -Infinity, low: Infinity, close: bars[i].c, startIndex: i, endIndex: i };
  while (i >= floor) {
    const s = et(bars[i].t);
    if (s.date !== date || s.tod < RTH_OPEN || s.tod >= RTH_CLOSE) break;
    out.high = Math.max(out.high, bars[i].h); out.low = Math.min(out.low, bars[i].l); out.startIndex = i;
    i--;
  }
  return out;
}

/** The overnight session: every bar from the prior 18:00 ET Globex open up to (not including) the
 *  09:30 open bar. Null when fewer than `minBars` bars are found inside `maxBack`. */
export function overnightRange(bars: readonly ResearchBar[], openIndex: number, maxBack: number, minBars: number): SessionRange | null {
  let i = openIndex - 1;
  const floor = Math.max(0, openIndex - maxBack);
  const out: SessionRange = { high: -Infinity, low: Infinity, close: bars[Math.max(0, openIndex - 1)].c, startIndex: openIndex, endIndex: openIndex - 1 };
  while (i >= floor) {
    const s = et(bars[i].t);
    if (s.tod >= RTH_OPEN && s.tod < GLOBEX_OPEN) break;
    out.high = Math.max(out.high, bars[i].h); out.low = Math.min(out.low, bars[i].l); out.startIndex = i;
    i--;
  }
  return out.endIndex - out.startIndex + 1 >= minBars ? out : null;
}

export interface Vwap { vwap: number; sigma: number; volume: number }

/** Session VWAP anchored at `openIndex`, through `index` inclusive, on the typical price, with the
 *  volume-weighted standard deviation around it. Null when no volume printed. */
export function sessionVwap(bars: readonly ResearchBar[], openIndex: number, index: number): Vwap | null {
  let pv = 0, vol = 0;
  for (let i = openIndex; i <= index; i++) { const tp = (bars[i].h + bars[i].l + bars[i].c) / 3; pv += tp * bars[i].v; vol += bars[i].v; }
  if (!(vol > 0)) return null;
  const vwap = pv / vol;
  let dev = 0;
  for (let i = openIndex; i <= index; i++) { const tp = (bars[i].h + bars[i].l + bars[i].c) / 3; dev += bars[i].v * (tp - vwap) ** 2; }
  return { vwap, sigma: Math.sqrt(dev / vol), volume: vol };
}
