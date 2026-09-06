import { pairBase } from "@/lib/kraken-pairs";

// One set of number/time formatters for every admin page. Before this, each page carried
// its own copy of money()/money2()/usd()/col() with slightly different sign conventions.

/** Whole dollars with a true minus sign: −$1,234 · $0 · $56 (no plus sign). */
export const money = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** Signed whole dollars for P&L: +$1,234 · −$56 · $0. */
export const pnl0 = (n: number) =>
  n === 0 ? "$0" : `${n < 0 ? "−" : "+"}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** Signed cents for P&L: +$12.34 · −$0.56. */
export const pnl2 = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;

/**
 * Price with precision scaled to magnitude. Crypto spans PEPE at $0.0000094 to BTC at
 * $100k; a fixed 2-decimal format renders every sub-cent coin as "$0".
 */
export const usd = (n: number) => {
  const a = Math.abs(n);
  const digits = a === 0 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: a > 0 && a < 1 ? Math.min(digits, 4) : 2 })}`;
};

export const usd0 = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export const pct = (ratio: number | null | undefined, digits = 0) =>
  ratio == null ? "—" : `${(ratio * 100).toFixed(digits)}%`;

/** Green above zero, red below, muted at zero. The only place P&L colour is decided. */
export const tone = (n: number | null | undefined) =>
  n == null || n === 0 ? "text-muted-foreground" : n > 0 ? "text-up" : "text-down";

/** Minutes → 42m · 3.5h · 2.1d */
export const hold = (m: number) => (m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`);

/** "just now" · "12m ago" · "3.5h ago" · "2d ago" */
export const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const m = (Date.now() - t) / 60000;
  return m < 1 ? "just now" : m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${(m / 60).toFixed(1)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** "Sep 5, 3:42 PM" in the viewer's locale — the one timestamp format for tables. */
export const when = (iso: string | number | Date) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
};

export const timeOnly = (iso: string | number | Date) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Kraken pair → coin, via the one canonical normaliser: XBTUSD:BTNL → BTC · SOL/USD → SOL · XXBTZUSD → BTC */
export const coinOf = (pair: string) => pairBase(pair.replace("/", ""));

/** Minutes elapsed since an ISO timestamp (0 when missing/invalid). */
export const minutesSince = (iso: string | null | undefined) => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 60000 : 0;
};
