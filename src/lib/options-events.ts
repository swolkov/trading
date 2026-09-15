// EARNINGS AND EX-DIVIDEND RULES for the options desk (Sep 15 2026) — pure, no I/O.
//
// A 21–60 DTE single-name contract very often spans an earnings date, and the desk's breakout rule
// says nothing about earnings: that is an EARNINGS TRADE the rule never asked for. So every
// candidate carries the research snapshot's event row and is refused when earnings fall on or before
// expiry, or when the desk simply does not know (no row, or a row older than 36 hours). Index ETFs
// have no earnings. Ex-dividend matters to one structure only: a call debit spread whose short call
// could be in the money before the ex-date is the one that gets assigned early.
export interface ResearchEvent {
  earningsAt: string | null;          // YYYY-MM-DD of the next report inside the calendar window; null = calendar read, none inside it
  earningsTiming: "am" | "pm" | null;
  /** YYYY-MM-DD of the next ex-dividend date. null = fundamentals read, none scheduled. The key is ABSENT when fundamentals were not read. */
  exDivAt?: string | null;
  dividendAmount?: number | null;
  at: string;                         // when the broker was asked
}
export type ResearchEvents = Record<string, ResearchEvent>;
export const OPTIONS_EVENT_RULES = {
  indexEtfs: ["SPY", "QQQ", "IWM"],
  maxEventAgeHours: 36,
  exDivExitDays: 2,
};
export type EarningsClass = "none" | "EARNINGS TRADE" | "unknown";
export interface EarningsVerdict { permitted: boolean; earningsClass: EarningsClass; earningsAt: string | null; note: string }
const day = (s: string) => s.slice(0, 10);
const validDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(Date.parse(day(s)));

/** Does a contract expiring on `expiry` span the name's next earnings? Unknown counts as yes for anything but an index ETF. */
export function spansEarnings(symbol: string, expiry: string, events: ResearchEvents | undefined, now: number, rules = OPTIONS_EVENT_RULES): EarningsVerdict {
  if (rules.indexEtfs.includes(symbol)) return { permitted: true, earningsClass: "none", earningsAt: null, note: "index ETF — no earnings" };
  const row = events?.[symbol];
  if (!row || !validDay(row.at)) return { permitted: false, earningsClass: "unknown", earningsAt: null, note: `earnings unknown — no calendar read for ${symbol}` };
  const ageH = (now - Date.parse(row.at)) / 3_600_000;
  if (!(ageH <= rules.maxEventAgeHours)) return { permitted: false, earningsClass: "unknown", earningsAt: row.earningsAt, note: `earnings data for ${symbol} is ${ageH.toFixed(0)}h old (limit ${rules.maxEventAgeHours}h)` };
  if (row.earningsAt != null && validDay(row.earningsAt) && day(row.earningsAt) <= day(expiry) && day(row.earningsAt) >= new Date(now).toISOString().slice(0, 10))
    return { permitted: false, earningsClass: "EARNINGS TRADE", earningsAt: day(row.earningsAt), note: `earnings ${day(row.earningsAt)}${row.earningsTiming ? ` (${row.earningsTiming})` : ""} falls before expiry ${day(expiry)}` };
  return { permitted: true, earningsClass: "none", earningsAt: row.earningsAt ? day(row.earningsAt) : null, note: row.earningsAt ? `next earnings ${day(row.earningsAt)} is after expiry ${day(expiry)}` : "no earnings before expiry" };
}

/** Early-assignment risk on a call debit spread: a short call that the expected move can put in the money before an
 *  ex-dividend date inside the hold. `exDivAt` undefined = fundamentals never read → spreads refused; null = none scheduled. */
export function exDivRisk(kind: string, shortStrike: number | null, shortType: "call" | "put" | null, spot: number, expectedMovePct: number | null,
  exDivAt: string | null | undefined, expiry: string, now: number): { permitted: boolean; note: string } {
  const spread = kind.endsWith("_debit") || kind.endsWith("_credit");
  if (!spread) return { permitted: true, note: "single leg — no short option to be assigned" };
  if (exDivAt === undefined) return { permitted: false, note: "ex-dividend date unknown — spreads refused" };
  if (exDivAt === null) return { permitted: true, note: "no ex-dividend scheduled" };
  if (!validDay(exDivAt)) return { permitted: false, note: "ex-dividend date unreadable — spreads refused" };
  const today = new Date(now).toISOString().slice(0, 10), ex = day(exDivAt);
  if (!(ex > today && ex <= day(expiry))) return { permitted: true, note: `ex-dividend ${ex} is outside the hold` };
  if (shortType !== "call") return { permitted: true, note: `ex-dividend ${ex} inside the hold, but only a short call is assigned for it` };
  if (shortStrike == null || !(spot > 0)) return { permitted: false, note: `ex-dividend ${ex} inside the hold and the short strike is unknown — refused` };
  // No expected move on file → the desk cannot say the short call stays out of the money → refused.
  const reach = expectedMovePct == null ? Number.POSITIVE_INFINITY : spot * (1 + expectedMovePct / 100);
  if (shortStrike <= reach) return { permitted: false, note: `short call ${shortStrike} could be in the money before the ${ex} ex-dividend (spot ${spot}${expectedMovePct == null ? ", expected move unknown" : `, expected move ±${expectedMovePct}%`})` };
  return { permitted: true, note: `short call ${shortStrike} is beyond the expected move (${reach.toFixed(2)}) before the ${ex} ex-dividend` };
}

/** Guardian rule: close a call debit spread whose short call is in the money with the ex-dividend date two days out or less. */
export function guardianExDivExit(pos: { kind: string; exDivAt?: string | null; shortStrike?: number | null }, spot: number | null, nowMs: number, rules = OPTIONS_EVENT_RULES): { exit: boolean; reason: string } {
  if (pos.kind !== "call_debit") return { exit: false, reason: "not a call debit spread" };
  if (pos.exDivAt == null || !validDay(pos.exDivAt)) return { exit: false, reason: "no ex-dividend date on the record" };
  if (pos.shortStrike == null || !Number.isFinite(pos.shortStrike)) return { exit: false, reason: "no short strike on the record" };
  if (spot == null || !(spot > 0)) return { exit: false, reason: "underlying quote unavailable — ex-dividend rule skipped" };
  const daysTo = (Date.parse(`${day(pos.exDivAt)}T13:30:00Z`) - nowMs) / 86_400_000;   // ex-date takes effect at that session's open (09:30 ET)
  if (daysTo < 0) return { exit: false, reason: `ex-dividend ${day(pos.exDivAt)} has passed` };
  if (daysTo > rules.exDivExitDays) return { exit: false, reason: `ex-dividend ${day(pos.exDivAt)} is ${daysTo.toFixed(1)} days out` };
  if (!(spot > pos.shortStrike)) return { exit: false, reason: `short call ${pos.shortStrike} is out of the money (spot ${spot}) into the ${day(pos.exDivAt)} ex-dividend` };
  return { exit: true, reason: `ex-dividend exit: short call ${pos.shortStrike} is in the money (spot ${spot}) with ex-dividend ${day(pos.exDivAt)} ${daysTo.toFixed(1)} days out — assignment risk` };
}
