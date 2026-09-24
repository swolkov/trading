// HIS DAY RULES, AS A READ-ONLY VIEW (Sep 24 2026). The rules themselves live in copilot-rules.ts and are enforced
// (as Slack messages) only by the co-pilot cron. This file only READS the co-pilot's saved state and says where the
// day stands: window, trades used, losses, cooldown, hands off. Pure: saved state + a clock in → the view out. Every
// limit comes from copilot-rules.ts; the one thing copilot-rules keeps inline (the 9:30–14:00 window, inside step()) is
// pinned to it by a test that runs step() at the edges.
import { COOLDOWN_AFTER_LOSS_MS, DAY_MAX_LOSSES, DAY_MAX_TRADES, HANDS_OFF_MS, PLAN_SYMBOL, tradingDay, type CopilotState } from "@/lib/copilot-rules";
import { ROOM_SYMBOLS, etDayStartMs, etParts, type RoomSymbol } from "@/lib/trading-room-rules";

export const WINDOW_OPEN_H = 9.5;    // = copilot-rules step(): entryRules.window = hh >= 9.5 && hh < 14
export const WINDOW_CLOSE_H = 14;
/** The co-pilot polls every 15 s; a state older than this may be missing a trade. */
export const COPILOT_STALE_MS = 5 * 60_000;

/** The co-pilot's saved row: its state plus the poll bookkeeping copilot.ts writes next to it. */
export type SavedCopilotState = CopilotState & { lastOkMs?: number; lastPollMs?: number; lastError?: string };

export interface DayRulesView {
  atMs: number;
  tradingDay: string;                       // 18:00 ET → 17:00 ET, the co-pilot's own day
  planSymbol: RoomSymbol;
  window: { open: boolean; opensAtMs: number | null; closesAtMs: number | null };
  trades: number | null;                    // null = the co-pilot has never saved a state
  maxTrades: number;
  losses: number | null;
  maxLosses: number;
  done: boolean;
  doneReason: string | null;
  cooldownUntilMs: number | null;           // set only while a post-loss cooldown is running
  handsOff: { symbol: RoomSymbol; untilMs: number }[];
  copilot: { enabled: boolean; lastOkMs: number | null; stale: boolean; lastError: string | null };
}

/** Is this moment inside the entry window? Mon–Fri only (the co-pilot's check is hour-only; the market is shut at weekends). */
export function inWindow(ms: number): boolean {
  const p = etParts(ms);
  return p.weekday >= 1 && p.weekday <= 5 && p.hourFrac >= WINDOW_OPEN_H && p.hourFrac < WINDOW_CLOSE_H;
}

/** Window state with the next open (or this window's close), exact across DST. Exchange holidays are not known here. */
export function windowState(nowMs: number): DayRulesView["window"] {
  const today = etParts(nowMs).dayKey;
  if (inWindow(nowMs)) return { open: true, opensAtMs: null, closesAtMs: etDayStartMs(today, WINDOW_CLOSE_H) };
  const noon = etDayStartMs(today, 12);
  for (let d = 0; d <= 7; d++) {
    const key = etParts(noon + d * 86_400_000).dayKey;
    const opensAtMs = etDayStartMs(key, WINDOW_OPEN_H);
    if (opensAtMs > nowMs && inWindow(opensAtMs)) return { open: false, opensAtMs, closesAtMs: null };
  }
  return { open: false, opensAtMs: null, closesAtMs: null };
}

/** Where the day stands, from the co-pilot's saved state. Counts reset at the trading-day roll exactly as step() does. */
export function dayRulesView(saved: SavedCopilotState | null, nowMs: number, enabled = true): DayRulesView {
  const dayKey = tradingDay(nowMs);
  const day = saved ? (saved.day && saved.day.key === dayKey ? saved.day : { trades: 0, losses: 0 }) : null;
  const trades = day ? day.trades : null;
  const losses = day ? day.losses : null;
  const reasons: string[] = [];
  if (losses != null && losses >= DAY_MAX_LOSSES) reasons.push(`${losses} losses`);
  if (trades != null && trades >= DAY_MAX_TRADES) reasons.push(`${trades} trades`);
  const lastClose = saved?.lastCloseMs;
  const cooling = !!saved?.lastCloseLoss && lastClose != null && nowMs - lastClose < COOLDOWN_AFTER_LOSS_MS;
  const handsOff: DayRulesView["handsOff"] = [];
  for (const sym of ROOM_SYMBOLS) {
    const t = saved?.trips?.[sym];
    if (t && nowMs - t.openedMs < HANDS_OFF_MS) handsOff.push({ symbol: sym, untilMs: t.openedMs + HANDS_OFF_MS });
  }
  const lastOkMs = saved?.lastOkMs ?? null;
  return {
    atMs: nowMs,
    tradingDay: dayKey,
    planSymbol: PLAN_SYMBOL,
    window: windowState(nowMs),
    trades, maxTrades: DAY_MAX_TRADES,
    losses, maxLosses: DAY_MAX_LOSSES,
    done: reasons.length > 0,
    doneReason: reasons.length ? reasons.join(" · ") : null,
    cooldownUntilMs: cooling ? lastClose + COOLDOWN_AFTER_LOSS_MS : null,
    handsOff,
    copilot: { enabled, lastOkMs, stale: lastOkMs == null || nowMs - lastOkMs > COPILOT_STALE_MS, lastError: saved?.lastError ?? null },
  };
}

/** 9:41 → "09:41"; a countdown for anything under an hour. */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** A longer countdown: "3h 05m", "2d 4h", or mm:ss under an hour. */
export function untilText(ms: number): string {
  if (ms < 3_600_000) return mmss(ms);
  const m = Math.floor(ms / 60_000);
  if (m < 1440) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
