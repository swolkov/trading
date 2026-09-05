// STOCK PAPER BOOK — the model. PURE: no database, no network, no imports beyond one
// sizing helper shared with the crypto desk. Everything a unit test needs to pin down
// lives here; stock-shadow.ts does the I/O.
//
// WHY THIS EXISTS (Sep 5 2026). Spencer asked for "the Kraken margin system on Robinhood
// stocks". Robinhood's only official programmatic route (Agentic Trading, May 2026) is a
// separate CASH account: long-only, no margin borrowing yet, no shorting, no paper mode.
// Margin exists on his MAIN account, but nothing official can place orders there, and the
// reverse-engineered CLIs get accounts frozen. So the honest first step is the same one
// the crypto desk took: a PAPER book that scans, scores on real bars with realistic costs,
// posts high-conviction setups to Slack for him to take by hand in his margin account if
// he chooses, and keeps a statistical record. The day Robinhood enables margin on Agentic
// accounts, an executor can be bolted onto this record; until then no code touches
// Robinhood at all. Data is Yahoo (free, regular-session bars).
//
// The measurement model deliberately mirrors margin-shadow.ts (same sequential 1-minute
// candle walk, same managed exit, same risk-based conviction-scaled sizing, same verdict
// ladder) so a "stock edge" and a "crypto edge" mean the same thing. It is a SEPARATE
// implementation on purpose: the crypto evaluator is the live candidate's record and has
// been through three review rounds — refactoring it mid-sample to share code would put a
// measurement change inside a sample that must stay comparable.
import { liveRiskFraction } from "@/lib/margin-live-risk";

// The watch list: liquid, marginable at Robinhood (large caps + the high-beta names +
// the three index ETFs), 30 names so the 15-minute Yahoo scan stays under ~120 calls.
// Fixed list, not re-derived: a deterministic scan and a stable sample. Change it only
// with a note on the page — adding/removing names mid-sample changes the population.
export const STOCK_UNIVERSE: string[] = [
  "SPY", "QQQ", "IWM",
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD", "NFLX",
  "CRM", "ORCL", "COST", "JPM", "BAC", "GS", "XOM", "CVX", "LLY", "UNH",
  "PLTR", "COIN", "MSTR", "HOOD", "SMCI", "ARM", "UBER",
];

// Measurement cohort stamp — bump when fills/costs/exits change materially, exactly as
// the crypto desk's SIM_VERSION does. Aggregates fail CLOSED to this exact value.
export const STOCK_SIM_VERSION = "s1";
export const STOCK_COHORT_SQL = `sim_version='${STOCK_SIM_VERSION}'`;

// Two long-only sleeves — an A/B on the container, same entry rule (high-conviction
// breakout, not stretched), split by the timeframe that fired:
//   stock-fast   5m/15m breakouts · 2% stop · out by the next session's close (30h)
//   stock-swing  1h/1d breakouts  · 5% stop · up to ~10 trading days (14 calendar days)
// Longs only: Robinhood's agent route cannot short, and the crypto record found shorts
// on this signal lost on every slice. Stops are fixed % like the crypto sleeves so the
// risk-based sizer has a known 1R at entry.
export type StockSource = "stock-fast" | "stock-swing";
export const STOCK_SOURCES: StockSource[] = ["stock-fast", "stock-swing"];
export const STOCK_SOURCE_LABELS: Record<StockSource, string> = {
  "stock-fast": "Fast — high-conviction 5m/15m longs, 2% / next close",
  "stock-swing": "Swing — high-conviction 1h/1d longs, 5% / ~10 sessions",
};
export function stockExitParams(source: string | null): { oneRPct: number; maxHoldH: number } {
  if (source === "stock-swing") return { oneRPct: 0.05, maxHoldH: 24 * 14 };
  return { oneRPct: 0.02, maxHoldH: 30 };
}

// Which sleeve (if any) a fresh signal opens. Long-only, high conviction only, not
// stretched — the same cut the crypto desk narrowed to on Sep 4, applied here from day
// one so the two records answer the same question.
export function stockPaperPlans(kind: string, timeframe: string, conv: { tier: string; factors: string[] }): StockSource[] {
  if (kind !== "breakout") return [];
  if (conv.tier !== "high") return [];
  if (conv.factors.some((f) => /stretched/i.test(f))) return [];
  if (timeframe === "5m" || timeframe === "15m") return ["stock-fast"];
  if (timeframe === "1h" || timeframe === "1d") return ["stock-swing"];
  return [];
}

// SIZING — risk-based and conviction-scaled, the same arithmetic as the crypto desk:
// notional = risk × equity ÷ stop distance, so every trade has a fixed max loss and a
// tighter stop buys a bigger position. Capped at 2× equity: Reg T margin on a Robinhood
// margin account is 2× overnight, and this book is not a day-trading book.
export const STOCK_MAX_LEVERAGE = 2;
export function stockRiskFraction(basePct: number, conviction: string | null): number {
  return liveRiskFraction(basePct, conviction);   // 3% base, high 2×, low 0.5×, 6% ceiling
}
export function stockNotional(source: string | null, refEquity: number, riskFrac: number): number {
  const { oneRPct } = stockExitParams(source);
  const cap = refEquity * STOCK_MAX_LEVERAGE;
  if (!(oneRPct > 0) || !(riskFrac > 0) || !(refEquity > 0)) return 0;
  return Math.min((riskFrac * refEquity) / oneRPct, cap);
}

// COSTS — the honest stock version of the crypto fee model. Robinhood charges no
// commission; what a stock trade actually pays is the spread/slippage on each side and
// margin interest on anything borrowed above equity. Entry: a 0.05% chase applied to the
// fill price at open time (a 15-minute scan sees a break late, like the crypto 0.1%
// chase, but large-cap spreads are ~5× tighter). Exit: 0.05% slippage. Interest: 5% APR
// (Robinhood's tier under $50k, Sep 2026; Gold's first $1k free is ignored — conservative)
// on the borrowed portion, pro-rated by calendar hold time. Long-only means no borrow fee.
export const STOCK_ENTRY_CHASE = 0.0005;
export const STOCK_EXIT_SLIP = 0.0005;
export const STOCK_MARGIN_APR = 0.05;
export function stockEntryPrice(signalPrice: number): number {
  return signalPrice * (1 + STOCK_ENTRY_CHASE);
}
/** Total cost as a FRACTION of notional: exit slippage + margin interest accrued. */
export function stockCostFrac(notional: number, refEquity: number, holdHours: number): number {
  if (!(notional > 0)) return 0;
  const borrowed = Math.max(0, notional - refEquity);
  const interest = borrowed * STOCK_MARGIN_APR * (Math.max(0, holdHours) / (365 * 24));
  return STOCK_EXIT_SLIP + interest / notional;
}

// VERDICT LADDER — identical rules to the crypto scoreboard so "REAL EDGE" means the
// same thing on both desks: 30+ resolved, positive net, t ≥ 2, resolutions spanning 7+
// distinct days (correlated same-day trades ≈ one bet; stocks all move with the index).
export function stockVerdict(resolved: number, net: number, tStat: number | null, days: number): string {
  if (resolved < 30) return `gathering (${resolved}/30)`;
  if (net <= 0) return "not paying";
  if (tStat != null && tStat >= 2) {
    if (days < 7) return `promising — significant, needs ${7 - days} more day${7 - days === 1 ? "" : "s"} of data`;
    return "REAL EDGE — significant";
  }
  return "promising (could be luck)";
}
export function tStatOf(mean: number | null, std: number | null, n: number): number | null {
  return n > 1 && mean != null && std != null && std > 0 ? (mean * Math.sqrt(n)) / std : null;
}

// Pure RTH check for a given instant — 9:30–16:00 America/New_York, weekdays, minus the
// given holidays (ISO dates). session-time.ts has the app-wide version; this one takes
// the instant and the holiday list as inputs so it can be tested without a clock.
export function isStockRthAt(at: Date, holidays: readonly string[]): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;
  const iso = `${get("year")}-${get("month")}-${get("day")}`;
  if (holidays.includes(iso)) return false;
  const minutes = (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
