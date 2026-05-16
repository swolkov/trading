// ============ DST-AWARE SESSION TIME HELPER ============
// All session boundaries in Eastern Time — automatically handles EDT/EST via Intl API.
// Single source of truth for session timing across cron agent + realtime engine.

const ET_TZ = "America/New_York";

/** Current Eastern Time hour as decimal (e.g., 9.5 = 9:30 AM ET) */
export function getETHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
  return hour + minute / 60;
}

/** Current day of week in ET (0=Sun, 6=Sat) */
export function getETDayOfWeek(): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    weekday: "short",
  });
  const day = formatter.format(new Date());
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[day] ?? new Date().getDay();
}

/** Current date string in ET (YYYY-MM-DD) */
export function getETDateString(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

/** Get today's 9:30 AM ET as a UTC timestamp (for VWAP anchoring etc.) */
export function getRTHStartUTC(): number {
  const dateStr = getETDateString();
  // Create a date string in ET and convert to UTC
  const etDateStr = `${dateStr}T09:30:00`;
  // Use Intl to figure out the UTC offset for today
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(new Date());
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "GMT-5";
  // Parse offset like "GMT-4" or "GMT-5"
  const offsetMatch = tzPart.match(/GMT([+-]?\d+)/);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[1], 10) : -5;
  // 9:30 AM ET in UTC
  const utcHour = 9 - offsetHours; // e.g., 9 - (-5) = 14, or 9 - (-4) = 13
  const date = new Date(`${dateStr}T${String(utcHour).padStart(2, "0")}:30:00Z`);
  return date.getTime();
}

/** Is it currently a weekend (futures closed)? */
export function isWeekend(): boolean {
  const day = getETDayOfWeek();
  const hour = getETHour();
  // Saturday all day, Sunday before 6 PM ET (futures open Sunday 6 PM ET)
  return day === 6 || (day === 0 && hour < 18);
}

/** Is it the daily futures halt window? (5:00 PM - 6:00 PM ET) */
export function isHalt(): boolean {
  const hour = getETHour();
  return hour >= 17 && hour < 18;
}

// US market holidays (fixed dates) — update annually
// Early closes (1 PM ET) not included, but these are full closures
const MARKET_HOLIDAYS_2026 = [
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day observed
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
];

/** Is today a market holiday? */
export function isMarketHoliday(): boolean {
  return MARKET_HOLIDAYS_2026.includes(getETDateString());
}

/** Is it Regular Trading Hours? (9:30 AM - 4:00 PM ET, not holiday) */
export function isRTH(): boolean {
  if (isMarketHoliday()) return false;
  const hour = getETHour();
  return hour >= 9.5 && hour < 16;
}

// Session types
export type Session =
  | "pre_market"
  | "open"
  | "morning"
  | "midday"
  | "afternoon"
  | "close"
  | "eth_evening"
  | "eth_overnight"
  | "eth_asia"
  | "eth_europe"
  | "halt";

/** Get current trading session name (DST-aware) */
export function getSessionName(): Session {
  if (isWeekend() || isHalt()) return "halt";

  const etH = getETHour();

  // RTH sessions
  if (etH >= 9.5 && etH < 16) {
    const minutesSinceOpen = (etH - 9.5) * 60;
    if (minutesSinceOpen < 15) return "open";       // 9:30-9:45 AM — opening chaos
    if (etH < 12) return "morning";                   // 9:45 AM - 12:00 PM — prime time
    if (etH < 14) return "midday";                    // 12:00 - 2:00 PM — lunch chop
    if (etH < 15.75) return "afternoon";              // 2:00 - 3:45 PM — second wind
    return "close";                                    // 3:45 - 4:00 PM — closing chaos
  }

  // Post-close / pre-halt
  if (etH >= 16 && etH < 17) return "eth_evening";   // 4:00 - 5:00 PM ET

  // Post-halt evening
  if (etH >= 18 && etH < 22) return "eth_evening";   // 6:00 - 10:00 PM ET

  // Asia session
  if (etH >= 22 || etH < 3) return "eth_asia";       // 10:00 PM - 3:00 AM ET

  // Europe/London session
  if (etH >= 3 && etH < 9) return "eth_europe";      // 3:00 - 9:00 AM ET

  // Pre-market
  return "pre_market";                                 // 9:00 - 9:30 AM ET
}

/** Minutes since RTH open (9:30 AM ET). Returns 0 if before open. */
export function getMinutesSinceRTHOpen(): number {
  const etH = getETHour();
  return Math.max(0, (etH - 9.5) * 60);
}

/** Get session info bundle (convenience) */
export function getSessionInfo(): {
  session: Session;
  isRTH: boolean;
  isETH: boolean;
  minutesSinceOpen: number;
  etHour: number;
} {
  const session = getSessionName();
  const rth = isRTH();
  return {
    session,
    isRTH: rth,
    isETH: !rth && session !== "halt",
    minutesSinceOpen: getMinutesSinceRTHOpen(),
    etHour: getETHour(),
  };
}
