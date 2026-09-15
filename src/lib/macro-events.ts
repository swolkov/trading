// High-impact US macro dates (FOMC decisions, CPI releases, and since Sep 15 2026 NFP, PPI
// and the FOMC minutes) shared by the cockpit's news route, the margin-watch guardian and the
// event-calendar policy — imported directly, never fetched over HTTP (the app's auth proxy
// would reject the cron's own unauthenticated request).
//
// Kept static because the schedule is published quarters ahead; the daily brief routine
// verifies exact dates, and this table gets refreshed when the Fed/BLS publish the next
// year. Marked "approx" where not verified against the primary source. The live Finnhub
// calendar (event-calendar.ts) overrides these times when it is reachable; this table is
// the fallback that guarantees the FOMC is never missed because a feed was down.
//
// tier 1 = the prints that move a 20× cushion in a minute (FOMC decision, CPI, NFP);
// tier 2 = the ones that usually only widen spreads (PPI, PCE, FOMC minutes).
export interface MacroEvent { date: string; time: string; name: string; approx: boolean; tier: 1 | 2 }

// Remaining 2026 high-impact events (ET dates). Refresh when 2027 schedules publish.
export const MACRO_EVENTS: MacroEvent[] = [
  { date: "2026-09-11", time: "08:30 ET", name: "CPI (Aug)", approx: true, tier: 1 },
  { date: "2026-09-16", time: "14:00 ET", name: "FOMC rate decision", approx: true, tier: 1 },
  { date: "2026-10-02", time: "08:30 ET", name: "Nonfarm payrolls (Sep)", approx: true, tier: 1 },
  { date: "2026-10-07", time: "14:00 ET", name: "FOMC minutes", approx: true, tier: 2 },
  { date: "2026-10-13", time: "08:30 ET", name: "CPI (Sep)", approx: true, tier: 1 },
  { date: "2026-10-14", time: "08:30 ET", name: "PPI (Sep)", approx: true, tier: 2 },
  { date: "2026-10-28", time: "14:00 ET", name: "FOMC rate decision", approx: true, tier: 1 },
  { date: "2026-11-06", time: "08:30 ET", name: "Nonfarm payrolls (Oct)", approx: true, tier: 1 },
  { date: "2026-11-12", time: "08:30 ET", name: "CPI (Oct)", approx: true, tier: 1 },
  { date: "2026-11-13", time: "08:30 ET", name: "PPI (Oct)", approx: true, tier: 2 },
  { date: "2026-11-18", time: "14:00 ET", name: "FOMC minutes", approx: true, tier: 2 },
  { date: "2026-12-04", time: "08:30 ET", name: "Nonfarm payrolls (Nov)", approx: true, tier: 1 },
  { date: "2026-12-09", time: "14:00 ET", name: "FOMC rate decision", approx: true, tier: 1 },
  { date: "2026-12-10", time: "08:30 ET", name: "CPI (Nov)", approx: true, tier: 1 },
  { date: "2026-12-11", time: "08:30 ET", name: "PPI (Nov)", approx: true, tier: 2 },
  { date: "2026-12-30", time: "14:00 ET", name: "FOMC minutes", approx: true, tier: 2 },
];

/** The n-th (1-based) given weekday (0 = Sunday) of a month, as a UTC day-of-month. */
function nthWeekdayUtc(year: number, month0: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/**
 * Hours BEHIND UTC for US Eastern on an ISO date: 4 under daylight time (second Sunday of
 * March through the first Sunday of November), 5 under standard time. 2026 flips on Nov 1.
 * Computed from the rule rather than pinned to one year so 2027's table needs no code change.
 */
export function etOffsetHours(dateIso: string): number {
  const [y, m, d] = dateIso.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 5;
  const dstStart = Date.UTC(y, 2, nthWeekdayUtc(y, 2, 0, 2));    // 2nd Sunday of March
  const dstEnd = Date.UTC(y, 10, nthWeekdayUtc(y, 10, 0, 1));    // 1st Sunday of November
  const day = Date.UTC(y, m - 1, d);
  return day >= dstStart && day < dstEnd ? 4 : 5;
}

/** The event's instant in UTC ms, from its ET date + "HH:MM ET". NaN when unparseable. */
export function eventUtcMs(e: { date: string; time: string }): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(e.time.trim());
  if (!m) return NaN;
  const base = Date.parse(`${e.date}T${m[1].padStart(2, "0")}:${m[2]}:00Z`);
  if (!Number.isFinite(base)) return NaN;
  return base + etOffsetHours(e.date) * 3600_000;
}

// Events in the next two weeks, and the subset within ~24h (the "you are levered into
// a print" window).
export function macroEventWindows(now: Date): { upcoming: MacroEvent[]; imminent: MacroEvent[] } {
  const soon = new Date(now.getTime() + 14 * 24 * 3600_000);
  const upcoming = MACRO_EVENTS
    .filter((e) => new Date(e.date + "T23:59:59Z") >= now && new Date(e.date) <= soon)
    .sort((a, b) => a.date.localeCompare(b.date));
  const imminent = upcoming.filter((e) => {
    const dt = new Date(e.date + "T17:00:00Z").getTime() - now.getTime();
    return dt > -12 * 3600_000 && dt < 36 * 3600_000;
  });
  return { upcoming, imminent };
}
