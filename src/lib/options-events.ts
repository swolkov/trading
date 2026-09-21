// EARNINGS AND EX-DIVIDEND RULES for the options desk (Sep 15 2026) — pure, no I/O.
//
// A 21–60 DTE single-name contract very often spans an earnings date, and the desk's breakout rule
// says nothing about earnings: that is an EARNINGS TRADE the rule never asked for. So every
// candidate carries the research snapshot's event row and is refused when earnings fall on or before
// expiry, or when the desk simply does not know (no row, or a row older than 36 MARKET hours — the
// clock stops over the weekend, so Friday's 17:45 read still covers Monday's open; Sep 21 2026). Index ETFs
// have no earnings. Ex-dividend matters to one structure only: a call debit spread whose short call
// could be in the money before the ex-date is the one that gets assigned early.
export interface ResearchEvent {
  earningsAt: string | null;          // YYYY-MM-DD of the next report inside the calendar window; null = calendar read, none inside it
  earningsTiming: "am" | "pm" | null;
  /** Last day (YYYY-MM-DD) the earnings calendar was proven to cover, contiguously from the capture day. An expiry past it is unknown. */
  calendarThrough: string;
  /** YYYY-MM-DD of the next ex-dividend date. null = fundamentals read, no dividend. The key is ABSENT when fundamentals were not read or the next date cannot be placed. */
  exDivAt?: string | null;
  /** "scheduled" = the broker's own upcoming ex-date; "projected" = last ex-date + the distribution period, read as a ±7-day window. */
  exDivSource?: ExDivSource;
  dividendAmount?: number | null;
  at: string;                         // when the broker was asked
}
export type ResearchEvents = Record<string, ResearchEvent>;
export const OPTIONS_EVENT_RULES = {
  indexEtfs: ["SPY", "QQQ", "IWM"],
  maxEventAgeHours: 36,
  maxQuoteAgeMs: 15 * 60_000,   // an underlying quote older than this is "unavailable" to every rule that reads one
  exDivExitDays: 2,
  projectedWindowDays: 7,   // a projected ex-date is the last one plus the period — right to about a week either side
  periodDays: { Quarterly: 91, Monthly: 30, "Semi-Annual": 182, Annual: 365 } as Record<string, number>,
};
const ET_WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
const isWeekendEt = (ms: number) => { const w = ET_WEEKDAY.format(new Date(ms)); return w === "Sat" || w === "Sun"; };
/** Hours from `fromMs` to `nowMs` with Saturday and Sunday (ET) not counted — the age of a research row in market time.
 *  Whole-hour buckets, keyed on the bucket's start; a partial hour at the end counts in full only on a weekday. */
export function marketAgeHours(fromMs: number, nowMs: number): number {
  if (!(nowMs > fromMs)) return 0;
  let hours = 0;
  for (let t = fromMs; t < nowMs; t += 3_600_000) if (!isWeekendEt(t)) hours += Math.min(1, (nowMs - t) / 3_600_000);
  return hours;
}
const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The next ex-dividend date from a broker fundamentals row (`ex_dividend_date` is the MOST RECENT scheduled ex-date, past or
 *  upcoming). All dividend fields null → no dividend. Past date + a known distribution frequency → projected forward. */
export function nextExDiv(fund: { ex_dividend_date?: unknown; distribution_frequency?: unknown; dividend_yield?: unknown; dividend_per_share?: unknown; payable_date?: unknown; record_date?: unknown }, today: string, rules = OPTIONS_EVENT_RULES): { known: boolean; exDivAt: string | null; source: ExDivSource | null; amount: number | null } {
  const fields = [fund.dividend_yield, fund.dividend_per_share, fund.distribution_frequency, fund.payable_date, fund.ex_dividend_date, fund.record_date];
  const amountRaw = Number(fund.dividend_per_share), amount = typeof fund.dividend_per_share === "string" || typeof fund.dividend_per_share === "number" ? (Number.isFinite(amountRaw) ? amountRaw : null) : null;
  if (fields.every((f) => f == null)) return { known: true, exDivAt: null, source: null, amount: null };
  const last = typeof fund.ex_dividend_date === "string" ? day(fund.ex_dividend_date) : "";
  if (!validDay(last)) return { known: false, exDivAt: null, source: null, amount };
  if (last >= today) return { known: true, exDivAt: last, source: "scheduled", amount };
  const period = typeof fund.distribution_frequency === "string" ? rules.periodDays[fund.distribution_frequency] : undefined;
  if (!period) return { known: false, exDivAt: null, source: null, amount };
  let next = shiftDay(last, period);
  for (let i = 0; i < 24 && next < today; i++) next = shiftDay(next, period);
  if (next < today) return { known: false, exDivAt: null, source: null, amount };   // too stale to project honestly
  return { known: true, exDivAt: next, source: "projected", amount };
}
export type ExDivSource = "scheduled" | "projected";
export type EarningsClass = "none" | "EARNINGS TRADE" | "unknown";
export interface EarningsVerdict { permitted: boolean; earningsClass: EarningsClass; earningsAt: string | null; note: string }
const day = (s: string) => s.slice(0, 10);
const validDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(Date.parse(day(s)));

/** Does a contract expiring on `expiry` span the name's next earnings? Unknown counts as yes for anything but an index ETF. */
export function spansEarnings(symbol: string, expiry: string, events: ResearchEvents | undefined, now: number, rules = OPTIONS_EVENT_RULES): EarningsVerdict {
  if (rules.indexEtfs.includes(symbol)) return { permitted: true, earningsClass: "none", earningsAt: null, note: "index ETF — no earnings" };
  const row = events?.[symbol];
  if (!row || !validDay(row.at)) return { permitted: false, earningsClass: "unknown", earningsAt: null, note: `earnings unknown — no calendar read for ${symbol}` };
  const ageH = marketAgeHours(Date.parse(row.at), now);
  if (!(ageH <= rules.maxEventAgeHours)) return { permitted: false, earningsClass: "unknown", earningsAt: row.earningsAt, note: `earnings data for ${symbol} is ${ageH.toFixed(0)} market hours old (limit ${rules.maxEventAgeHours}h)` };
  if (!validDay(row.calendarThrough) || day(expiry) > day(row.calendarThrough)) return { permitted: false, earningsClass: "unknown", earningsAt: row.earningsAt, note: `earnings calendar for ${symbol} is proven only through ${validDay(row.calendarThrough) ? day(row.calendarThrough) : "nothing"}; expiry ${day(expiry)} is beyond it` };
  if (row.earningsAt != null && validDay(row.earningsAt) && day(row.earningsAt) <= day(expiry) && day(row.earningsAt) >= new Date(now).toISOString().slice(0, 10))
    return { permitted: false, earningsClass: "EARNINGS TRADE", earningsAt: day(row.earningsAt), note: `earnings ${day(row.earningsAt)}${row.earningsTiming ? ` (${row.earningsTiming})` : ""} falls before expiry ${day(expiry)}` };
  return { permitted: true, earningsClass: "none", earningsAt: row.earningsAt ? day(row.earningsAt) : null, note: row.earningsAt ? `next earnings ${day(row.earningsAt)} is after expiry ${day(expiry)}` : "no earnings before expiry" };
}

/** Early-assignment risk on a call debit spread: a short call that the expected move can put in the money before an
 *  ex-dividend date inside the hold. `exDivAt` undefined = fundamentals never read → spreads refused; null = none scheduled. */
export function exDivRisk(kind: string, shortStrike: number | null, shortType: "call" | "put" | null, spot: number, expectedMovePct: number | null,
  exDivAt: string | null | undefined, expiry: string, now: number, exDivSource: ExDivSource = "scheduled", rules = OPTIONS_EVENT_RULES): { permitted: boolean; note: string } {
  const spread = kind.endsWith("_debit") || kind.endsWith("_credit");
  if (!spread) return { permitted: true, note: "single leg — no short option to be assigned" };
  if (exDivAt === undefined) return { permitted: false, note: "ex-dividend date unknown — spreads refused" };
  if (exDivAt === null) return { permitted: true, note: "no dividend — nothing to be assigned for" };
  if (!validDay(exDivAt)) return { permitted: false, note: "ex-dividend date unreadable — spreads refused" };
  const today = new Date(now).toISOString().slice(0, 10), ex = day(exDivAt), w = exDivSource === "projected" ? rules.projectedWindowDays : 0;
  const label = exDivSource === "projected" ? `projected ex-dividend ${ex} (±${w}d)` : `ex-dividend ${ex}`;
  const [from, to] = [shiftDay(ex, -w), shiftDay(ex, w)];
  if (!(to > today && from <= day(expiry))) return { permitted: true, note: `${label} is outside the hold` };
  if (shortType !== "call") return { permitted: true, note: `${label} inside the hold, but only a short call is assigned for it` };
  if (shortStrike == null || !(spot > 0)) return { permitted: false, note: `${label} inside the hold and the short strike is unknown — refused` };
  // No expected move on file → the desk cannot say the short call stays out of the money → refused.
  const reach = expectedMovePct == null ? Number.POSITIVE_INFINITY : spot * (1 + expectedMovePct / 100);
  if (shortStrike <= reach) return { permitted: false, note: `short call ${shortStrike} could be in the money before the ${label} (spot ${spot}${expectedMovePct == null ? ", expected move unknown" : `, expected move ±${expectedMovePct}%`})` };
  return { permitted: true, note: `short call ${shortStrike} is beyond the expected move (${reach.toFixed(2)}) before the ${label}` };
}

/** Guardian rule: close a call debit spread whose short call is in the money with the ex-dividend date two days out or less. */
export function guardianExDivExit(pos: { kind: string; exDivAt?: string | null; exDivSource?: ExDivSource; shortStrike?: number | null }, quote: { last: number; atMs: number } | null, nowMs: number, rules = OPTIONS_EVENT_RULES): { exit: boolean; reason: string } {
  if (pos.kind !== "call_debit") return { exit: false, reason: "not a call debit spread" };
  if (pos.exDivAt == null || !validDay(pos.exDivAt)) return { exit: false, reason: "no ex-dividend date on the record" };
  if (pos.shortStrike == null || !Number.isFinite(pos.shortStrike)) return { exit: false, reason: "no short strike on the record" };
  if (quote == null || !(quote.last > 0)) return { exit: false, reason: "underlying quote unavailable — ex-dividend rule skipped" };
  if (!(nowMs - quote.atMs <= rules.maxQuoteAgeMs)) return { exit: false, reason: `underlying quote is ${((nowMs - quote.atMs) / 60_000).toFixed(0)} min old — treated as unavailable, ex-dividend rule skipped` };
  const spot = quote.last;
  // A projected date is a window: act from its earliest plausible day, and until its latest has passed.
  const projected = pos.exDivSource === "projected", w = projected ? rules.projectedWindowDays : 0;
  const label = projected ? `projected ex-dividend ${day(pos.exDivAt)} (±${w}d)` : `ex-dividend ${day(pos.exDivAt)}`;
  const daysTo = (Date.parse(`${shiftDay(day(pos.exDivAt), -w)}T13:30:00Z`) - nowMs) / 86_400_000;   // ex-date takes effect at that session's open (09:30 ET)
  const daysToEnd = (Date.parse(`${shiftDay(day(pos.exDivAt), w)}T13:30:00Z`) - nowMs) / 86_400_000;
  if (daysToEnd < 0) return { exit: false, reason: `${label} has passed` };
  if (daysTo > rules.exDivExitDays) return { exit: false, reason: `${label} is ${daysTo.toFixed(1)} days out` };
  if (!(spot > pos.shortStrike)) return { exit: false, reason: `short call ${pos.shortStrike} is out of the money (spot ${spot}) into the ${label}` };
  return { exit: true, reason: `ex-dividend exit: short call ${pos.shortStrike} is in the money (spot ${spot}) with ${label} ${Math.max(daysTo, 0).toFixed(1)} days out — assignment risk` };
}
