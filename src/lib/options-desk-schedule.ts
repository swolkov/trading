// WHEN the options desk worker does what — pure, so the calendar is unit-tested. Times in ET.
//   guard   every 5 minutes from 09:30 to 16:05 (the last tick settles the day)
//   entry   at :05 and :35 from 09:35 to 15:35 (the desk itself refuses the last 30 minutes)
//   collect the account snapshot once at 17:32 on weekdays (was the Mac's 17:32 launchd job)
export interface TickPlan { guard: boolean; entry: boolean; collect: boolean; etMinute: string }
export function etClock(ms: number): { weekday: number; hour: number; minute: number; key: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24, minute = Number(p.minute);
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? ""), hour, minute, key: `${p.year}-${p.month}-${p.day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}
export function tickPlan(ms: number): TickPlan {
  const { weekday, hour, minute, key } = etClock(ms);
  const weekdayOk = weekday >= 1 && weekday <= 5;
  const t = hour * 60 + minute;
  const inGuardWindow = t >= 9 * 60 + 30 && t <= 16 * 60 + 5;
  const inEntryWindow = t >= 9 * 60 + 35 && t <= 15 * 60 + 35;
  return {
    guard: weekdayOk && inGuardWindow && minute % 5 === 0,
    entry: weekdayOk && inEntryWindow && (minute === 5 || minute === 35),
    collect: weekdayOk && hour === 17 && minute === 32,
    etMinute: key,
  };
}
