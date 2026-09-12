export interface DayState { date: string; entries: number; lastEntryIso: string | null }

export function parseDayState(raw: string | null, nowMs = Date.now()): DayState {
  if (!raw) throw new Error("daily entry state missing; reconcile entries before trading");
  const s = JSON.parse(raw) as Partial<DayState> | null;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (!s || typeof s.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)
    || !Number.isFinite(Date.parse(s.date)) || new Date(s.date).toISOString().slice(0, 10) !== s.date || s.date > today
    || !Number.isSafeInteger(s.entries) || !(s.entries! >= 0)
    || (s.lastEntryIso !== null && (typeof s.lastEntryIso !== "string" || !Number.isFinite(Date.parse(s.lastEntryIso))))
    || (s.entries! > 0 && s.lastEntryIso === null)) throw new Error("daily entry state malformed; failing closed");
  return { date: today, entries: s.date === today ? s.entries! : 0, lastEntryIso: s.lastEntryIso! };
}

export function nextDayReservation(prev: DayState, nowMs = Date.now()): DayState {
  const current = parseDayState(JSON.stringify(prev), nowMs);
  return { date: current.date, entries: current.entries + 1, lastEntryIso: new Date(nowMs).toISOString() };
}
