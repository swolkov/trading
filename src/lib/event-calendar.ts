// THE ECONOMIC-EVENT CALENDAR AND POLICY — shared by every desk (crypto margin today, the
// futures desk next). Pure: no database, no fetch, no desk imports. The desks supply the
// Finnhub rows and the static table, and read back a MODE:
//
//   paused  — a tier-1 print (FOMC decision, CPI, NFP) is within ±30 minutes: no new entries.
//   reduced — a tier-1 print is within the 12h before or 2h after, or a tier-2 print (PPI,
//             PCE, FOMC minutes) is within ±30 minutes: entries at half risk.
//   normal  — otherwise.
//
// Finnhub wins on TIME when both sources carry the same event (its schedule is the live
// one); the static table guarantees the big prints exist even when the feed is down. The
// merge labels which source spoke, so a stale static date is visible rather than silent.
import { MACRO_EVENTS, eventUtcMs, type MacroEvent } from "@/lib/macro-events";

export type EventTier = 1 | 2;
export type EventFamily = "fomc" | "cpi" | "nfp" | "ppi" | "pce" | "minutes";
export type EventSource = "finnhub" | "static" | "finnhub+static";
export interface CalendarEvent { name: string; atMs: number; tier: EventTier; family: EventFamily; source: EventSource; approx: boolean }
export type EventMode = "normal" | "reduced" | "paused";
export interface EventPolicy {
  mode: EventMode;
  reason: string;
  nextEvent: { name: string; atMs: number; tier: EventTier; source: EventSource } | null;
  at: string;   // when the policy was computed (ISO)
}

export const HIGH_IMPACT_RE = /CPI|FOMC|Nonfarm|Payroll|PPI|PCE|Fed Interest Rate|Minutes/i;
export const PAUSE_WINDOW_MIN = 30;
export const REDUCED_BEFORE_H = 12;
export const REDUCED_AFTER_H = 2;

/** Which family a name belongs to — Minutes is checked before FOMC so "FOMC Minutes" is tier 2. */
export function familyOf(name: string): EventFamily | null {
  if (/Minutes/i.test(name)) return "minutes";
  if (/FOMC|Fed Interest Rate/i.test(name)) return "fomc";
  if (/\bCPI\b|Consumer Price/i.test(name)) return "cpi";
  if (/Nonfarm|Non-Farm|Payroll/i.test(name)) return "nfp";
  if (/\bPPI\b|Producer Price/i.test(name)) return "ppi";
  if (/\bPCE\b/i.test(name)) return "pce";
  return null;
}
export function tierOf(family: EventFamily): EventTier {
  return family === "fomc" || family === "cpi" || family === "nfp" ? 1 : 2;
}

/** Finnhub's economic-calendar rows → high-impact events. `time` is "YYYY-MM-DD HH:MM:SS" in UTC. */
export function normalizeFinnhub(rows: { event: string; time: string; impact: string; country?: string }[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const r of rows ?? []) {
    if (!r || typeof r.event !== "string" || typeof r.time !== "string") continue;
    if (r.country != null && r.country !== "US") continue;
    if (String(r.impact).toLowerCase() !== "high") continue;
    if (!HIGH_IMPACT_RE.test(r.event)) continue;
    const family = familyOf(r.event);
    if (!family) continue;
    const atMs = Date.parse(r.time.trim().replace(" ", "T") + (/[Zz]$|[+-]\d\d:?\d\d$/.test(r.time.trim()) ? "" : "Z"));
    if (!Number.isFinite(atMs)) continue;
    out.push({ name: r.event, atMs, tier: tierOf(family), family, source: "finnhub", approx: false });
  }
  return out;
}

export function staticCalendar(events: MacroEvent[] = MACRO_EVENTS): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const e of events) {
    const family = familyOf(e.name);
    const atMs = eventUtcMs(e);
    if (!family || !Number.isFinite(atMs)) continue;
    out.push({ name: e.name, atMs, tier: e.tier, family, source: "static", approx: e.approx });
  }
  return out;
}

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

/**
 * One list: deduped by (UTC date, family). Finnhub's time wins; the static entry's presence is
 * recorded in `source`. Events more than 24h in the past are dropped. Sorted by time.
 */
export function mergeCalendar(finnhub: CalendarEvent[], statics: CalendarEvent[], nowMs: number): CalendarEvent[] {
  const byKey = new Map<string, CalendarEvent>();
  for (const e of statics) byKey.set(`${utcDay(e.atMs)}|${e.family}`, { ...e, source: "static" });
  for (const e of finnhub) {
    const key = `${utcDay(e.atMs)}|${e.family}`;
    const prev = byKey.get(key);
    byKey.set(key, { ...e, source: prev ? "finnhub+static" : "finnhub", approx: false });
  }
  const cutoff = nowMs - 24 * 3600_000;
  return [...byKey.values()].filter((e) => e.atMs >= cutoff).sort((a, b) => a.atMs - b.atMs);
}

function fmtRel(ms: number): string {
  const min = Math.round(ms / 60_000);
  const abs = Math.abs(min);
  const txt = abs < 120 ? `${abs} min` : `${(abs / 60).toFixed(1)} h`;
  return min >= 0 ? `in ${txt}` : `${txt} ago`;
}
function fmtUtc(ms: number): string { return new Date(ms).toISOString().slice(11, 16) + "Z"; }

/** The policy at `nowMs`. Pure — the same inputs always give the same mode. */
export function eventPolicyNow(nowMs: number, events: CalendarEvent[]): EventPolicy {
  const at = new Date(nowMs).toISOString();
  const pauseMs = PAUSE_WINDOW_MIN * 60_000;
  let paused: CalendarEvent | null = null;
  let reduced: CalendarEvent | null = null;
  for (const e of events) {
    const dt = e.atMs - nowMs;   // positive = ahead
    if (e.tier === 1) {
      if (Math.abs(dt) <= pauseMs) { if (!paused || Math.abs(dt) < Math.abs(paused.atMs - nowMs)) paused = e; }
      else if (dt <= REDUCED_BEFORE_H * 3600_000 && dt >= -REDUCED_AFTER_H * 3600_000) { if (!reduced || Math.abs(dt) < Math.abs(reduced.atMs - nowMs)) reduced = e; }
    } else if (Math.abs(dt) <= pauseMs) {
      if (!reduced || Math.abs(dt) < Math.abs(reduced.atMs - nowMs)) reduced = e;
    }
  }
  const upcoming = events.filter((e) => e.atMs >= nowMs - pauseMs).sort((a, b) => a.atMs - b.atMs)[0] ?? null;
  const nextEvent = upcoming ? { name: upcoming.name, atMs: upcoming.atMs, tier: upcoming.tier, source: upcoming.source } : null;
  if (paused) return { mode: "paused", reason: `${paused.name} at ${fmtUtc(paused.atMs)} (${fmtRel(paused.atMs - nowMs)}) — tier 1 within ±${PAUSE_WINDOW_MIN} min`, nextEvent, at };
  if (reduced) {
    const why = reduced.tier === 1 ? `tier 1 within −${REDUCED_BEFORE_H}h..+${REDUCED_AFTER_H}h` : `tier 2 within ±${PAUSE_WINDOW_MIN} min`;
    return { mode: "reduced", reason: `${reduced.name} at ${fmtUtc(reduced.atMs)} (${fmtRel(reduced.atMs - nowMs)}) — ${why}`, nextEvent, at };
  }
  return { mode: "normal", reason: nextEvent ? `next: ${nextEvent.name} ${utcDay(nextEvent.atMs)} ${fmtUtc(nextEvent.atMs)}` : "no high-impact event on the calendar", nextEvent, at };
}
