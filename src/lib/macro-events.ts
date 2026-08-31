// High-impact US macro dates (FOMC decisions, CPI releases) shared by the cockpit's
// news route AND the margin-watch guardian — imported directly, never fetched over
// HTTP (the app's auth proxy would reject the cron's own unauthenticated request).
//
// Kept static because the schedule is published quarters ahead; the daily brief
// routine verifies exact dates, and this table gets refreshed when the Fed/BLS
// publish the next year. Marked "approx" where not verified against the primary source.
export interface MacroEvent { date: string; time: string; name: string; approx: boolean }

// Remaining 2026 high-impact events (ET dates). Refresh when 2027 schedules publish.
export const MACRO_EVENTS: MacroEvent[] = [
  { date: "2026-09-11", time: "08:30 ET", name: "CPI (Aug)", approx: true },
  { date: "2026-09-16", time: "14:00 ET", name: "FOMC rate decision", approx: true },
  { date: "2026-10-13", time: "08:30 ET", name: "CPI (Sep)", approx: true },
  { date: "2026-10-28", time: "14:00 ET", name: "FOMC rate decision", approx: true },
  { date: "2026-11-12", time: "08:30 ET", name: "CPI (Oct)", approx: true },
  { date: "2026-12-09", time: "14:00 ET", name: "FOMC rate decision", approx: true },
  { date: "2026-12-10", time: "08:30 ET", name: "CPI (Nov)", approx: true },
];

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
