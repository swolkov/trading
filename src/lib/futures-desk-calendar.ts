// FUTURES DESK — the calendar (E3), pure. Three things the entry path asks before an order:
//   • the economic-event policy (paused / reduced / normal) — the guardian computes it from the
//     shared event-calendar module every run and writes `futures_desk_event_policy`; the entry
//     path reads that row back and refuses when it is missing or older than 20 minutes;
//   • CME holidays that close ENTRIES (a closed day, or the rest of a day after an early close) —
//     exits, queue drains, rolls and re-protection keep the plain `cmeOpen`;
//   • the roll-window refusal the pre-trade checklist reports, one helper, one string.
//
// STATIC TABLE ONLY. Finnhub's economic calendar is a premium endpoint on this account, so there is
// nothing to merge: `source` is always "static" and a feed being down can never refuse an entry.
// What CAN refuse is the guardian not having written the policy lately — fail closed on entries.
import { PAUSE_WINDOW_MIN, REDUCED_AFTER_H, REDUCED_BEFORE_H, eventPolicyNow, mergeCalendar, staticCalendar, type CalendarEvent, type EventMode } from "@/lib/event-calendar";
import { EVENT_POLICY_FRESH_MS, cmeOpen, etDayKey, rollDue } from "@/lib/futures-desk-rules";

export const EVENT_POLICY_KEY = "futures_desk_event_policy";
/** Reduced mode halves the budget; it composes with the drawdown tier's multiplier. */
export const EVENT_REDUCED_MULT = 0.5;

export interface DeskEventPolicy {
  mode: EventMode;
  reason: string;
  /** When the current mode ends (ISO) — null in normal mode. */
  until: string | null;
  /** When the policy was computed (ISO); the entry path refuses past 20 minutes. */
  at: string;
  source: "static";
  /** The print that set the mode, so the refusal can name it and its ET time. */
  event: { name: string; atMs: number; tier: 1 | 2 } | null;
}

/** Today's static calendar (events more than 24h past are dropped by the merge). */
export function deskCalendar(now: Date): CalendarEvent[] {
  return mergeCalendar([], staticCalendar(), now.getTime());
}

/** The event that put the policy in its mode: the tier-1 print inside ±30 min for `paused`; for
 *  `reduced`, the tier-1 print inside −12h..+2h or the tier-2 inside ±30 min — the one the reason
 *  names when it can be matched, else the nearest. */
function causeOf(mode: EventMode, reason: string, events: CalendarEvent[], nowMs: number): CalendarEvent | null {
  if (mode === "normal") return null;
  const pause = PAUSE_WINDOW_MIN * 60_000;
  const inPlay = events.filter((e) => {
    const dt = e.atMs - nowMs;
    if (mode === "paused") return e.tier === 1 && Math.abs(dt) <= pause;
    return e.tier === 1 ? Math.abs(dt) > pause && dt <= REDUCED_BEFORE_H * 3600_000 && dt >= -REDUCED_AFTER_H * 3600_000 : Math.abs(dt) <= pause;
  });
  return inPlay.find((e) => reason.startsWith(`${e.name} at `)) ?? inPlay.sort((a, b) => Math.abs(a.atMs - nowMs) - Math.abs(b.atMs - nowMs))[0] ?? null;
}

function untilMs(mode: EventMode, cause: CalendarEvent | null, nowMs: number): number | null {
  if (!cause || mode === "normal") return null;
  const pause = PAUSE_WINDOW_MIN * 60_000;
  if (mode === "paused" || cause.tier === 2) return cause.atMs + pause;
  // Reduced on a tier-1 print: until the pause window opens, or (after the print) until the +2h tail ends.
  return nowMs < cause.atMs - pause ? cause.atMs - pause : cause.atMs + REDUCED_AFTER_H * 3600_000;
}

/** The policy the guardian writes each run. Pure — the same clock and calendar always give the same row. */
export function deskEventPolicy(now: Date, events: CalendarEvent[] = deskCalendar(now)): DeskEventPolicy {
  const nowMs = now.getTime();
  const p = eventPolicyNow(nowMs, events);
  const cause = causeOf(p.mode, p.reason, events, nowMs);
  const until = untilMs(p.mode, cause, nowMs);
  return { mode: p.mode, reason: p.reason, until: until != null ? new Date(until).toISOString() : null, at: p.at, source: "static", event: cause ? { name: cause.name, atMs: cause.atMs, tier: cause.tier } : null };
}

/** Tolerant reader of `futures_desk_event_policy`: anything not shaped like a policy reads as MISSING
 *  (→ the entry path refuses), never as "normal". */
export function parseEventPolicy(raw: string | null | undefined): DeskEventPolicy | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || typeof v.at !== "string" || !["normal", "reduced", "paused"].includes(String(v.mode))) return null;
    const ev = v.event as Record<string, unknown> | null | undefined;
    const event = ev && typeof ev === "object" && typeof ev.name === "string" && typeof ev.atMs === "number" ? { name: ev.name, atMs: ev.atMs, tier: (ev.tier === 2 ? 2 : 1) as 1 | 2 } : null;
    return { mode: v.mode as EventMode, reason: typeof v.reason === "string" ? v.reason : "", until: typeof v.until === "string" ? v.until : null, at: v.at, source: "static", event };
  } catch { return null; }
}

/** "14:00" in New York time. */
export function etHHMM(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });
}

/** `FOMC rate decision 14:00 ET — paused until 14:30` — the text after "event window: " in the refusal. */
export function eventWindowText(p: DeskEventPolicy): string | null {
  if (p.mode !== "paused") return null;
  const untilMsValue = p.until ? Date.parse(p.until) : NaN;
  const until = Number.isFinite(untilMsValue) ? etHHMM(untilMsValue) : "the window ends";
  return p.event ? `${p.event.name} ${etHHMM(p.event.atMs)} ET — paused until ${until}` : `tier-1 print within ${PAUSE_WINDOW_MIN} minutes — paused until ${until}`;
}

/** What the entry container carries about the calendar. `ageMs` null = missing/unreadable (a refusal);
 *  `budgetMult` is 0.5 only while a FRESH policy reads `reduced`. */
export interface EventContext { mode: EventMode | null; ageMs: number | null; window: string | null; budgetMult: number; policy: DeskEventPolicy | null }
export function eventContextOf(raw: string | null | undefined, nowMs: number): EventContext {
  const policy = parseEventPolicy(raw);
  const at = policy ? Date.parse(policy.at) : NaN;
  const ageMs = Number.isFinite(at) ? nowMs - at : null;
  const fresh = ageMs != null && ageMs <= EVENT_POLICY_FRESH_MS;
  return { mode: policy?.mode ?? null, ageMs, window: policy ? eventWindowText(policy) : null, budgetMult: fresh && policy?.mode === "reduced" ? EVENT_REDUCED_MULT : 1, policy };
}

// ---- CME holidays (entries only) ------------------------------------------------------------------
export interface CmeHoliday { date: string; name: string; /** ET "HH:MM" of an early close; null = closed all day. */ closeEt: string | null }
/** CME equity-index / metals holiday schedule from Thanksgiving 2026 through Presidents' Day 2027.
 *  Refresh when the 2027 schedule publishes. Early-close times are the index products' (metals close
 *  at the same or a later time — the earlier one is the safe rule for entries). */
export const CME_HOLIDAYS_2026: readonly CmeHoliday[] = [
  { date: "2026-11-26", name: "Thanksgiving", closeEt: "13:00" },
  { date: "2026-11-27", name: "day after Thanksgiving", closeEt: "13:15" },
  { date: "2026-12-24", name: "Christmas Eve", closeEt: "13:15" },
  { date: "2026-12-25", name: "Christmas Day", closeEt: null },
  { date: "2027-01-01", name: "New Year's Day", closeEt: null },
  { date: "2027-01-18", name: "Martin Luther King Jr. Day", closeEt: "13:00" },
  { date: "2027-02-15", name: "Presidents' Day", closeEt: "13:00" },
];

export function cmeHolidayOn(now: Date, table: readonly CmeHoliday[] = CME_HOLIDAYS_2026): CmeHoliday | null {
  const day = etDayKey(now);
  return table.find((h) => h.date === day) ?? null;
}

/** The holiday refusal for an ENTRY: a closed day refuses all day; an early close refuses from the
 *  close through the rest of that ET day (the evening reopen is holiday-thin). Null on a normal day. */
export function cmeHolidayRefusal(now: Date, table: readonly CmeHoliday[] = CME_HOLIDAYS_2026): string | null {
  const h = cmeHolidayOn(now, table);
  if (!h) return null;
  if (h.closeEt == null) return `CME holiday: ${h.name} — closed; entry refused`;
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const [hh, mm] = h.closeEt.split(":").map(Number);
  if (et.getHours() * 60 + et.getMinutes() < hh * 60 + mm) return null;
  return `CME early close ${h.closeEt} ET (${h.name}) — entry refused for the rest of the day`;
}

/** The entry path's clock: the plain CME hours AND no holiday closure. Nothing else uses this. */
export function cmeOpenForEntry(now: Date, table: readonly CmeHoliday[] = CME_HOLIDAYS_2026): boolean {
  return cmeOpen(now) && cmeHolidayRefusal(now, table) == null;
}

// ---- the roll window ----------------------------------------------------------------------------
/** `MESU6 expires in 1 day — inside the roll window; entry refused` once `rollDue` says the month is
 *  about to roll (the guardian would close what was just opened). Null outside the window. */
export function rollWindowRefusal(contract: string, expiryIso: string | null, now: Date, guardDays: number): string | null {
  if (!rollDue(expiryIso, now.getTime(), guardDays)) return null;
  const days = Math.max(0, Math.round((Date.parse(expiryIso as string) - now.getTime()) / 86_400_000));
  return `${contract} expires in ${days} day${days === 1 ? "" : "s"} — inside the roll window; entry refused`;
}
