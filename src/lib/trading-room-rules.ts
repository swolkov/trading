// THE TRADING ROOM — pure rules (Sep 19 2026). Spencer trades MES / MNQ / MGC BY HAND on his live
// Tradovate account; this room shows him the same numbers on the admin page and on his TradingView
// chart (pine/trading-room-levels.pine): the level set, the size his own rule allows, the news clock,
// and the tape of level breaks the chart reports. NOTHING in this module or its callers places,
// changes or cancels an order — the room is a mirror, not a hand on the wheel.
//
// Evidence behind what is (and is not) here: Research/orb-study-sep19.md (0 of 192 ORB cells survive
// on 15 years of our own 1-minute data) and Research/fable-futures-assist-sep19.md. Levels are
// REFERENCE — where stops cluster and where the crowd acts — not signals; the tape records breaks so
// the journal can later say whether the ones he took paid.
//
// Definitions (all ET, and identical on the chart so the two never disagree):
//   prior day   = the previous EXCHANGE day (18:00 → 17:00), the bar TradingView's "D" shows as [1]
//   overnight   = from the RTH close to the next RTH open (so it spans the 17:00 break)
//   week        = the running week since Sunday 18:00
//   opening range = the first ORB_MINUTES of the RTH session (MES/MNQ 09:30, MGC 08:20 — the COMEX
//                 open, not the equity open; the study tested both and gold respects neither, so
//                 this is a reference line, labelled as such)
//   VWAP        = volume-weighted from the exchange-day open (18:00), the chart's session VWAP

export const ROOM_SYMBOLS = ["MES", "MNQ", "MGC"] as const;
export type RoomSymbol = (typeof ROOM_SYMBOLS)[number];

export interface InstrumentSpec {
  symbol: RoomSymbol;
  label: string;
  /** Yahoo chart symbol the levels are built from (the full-size contract: same prices, deeper data). */
  yahoo: string;
  pointValue: number;   // $ per 1.00 of price, one micro contract
  tick: number;
  rthOpen: number;      // ET hour, fractional
  rthClose: number;
  /** Tradovate's published intraday margin per micro, for the "margin is not the constraint" line. */
  dayMarginUsd: number;
}

export const INSTRUMENTS: Record<RoomSymbol, InstrumentSpec> = {
  MES: { symbol: "MES", label: "Micro S&P 500", yahoo: "ES=F", pointValue: 5, tick: 0.25, rthOpen: 9.5, rthClose: 16, dayMarginUsd: 50 },
  MNQ: { symbol: "MNQ", label: "Micro Nasdaq-100", yahoo: "NQ=F", pointValue: 2, tick: 0.25, rthOpen: 9.5, rthClose: 16, dayMarginUsd: 100 },
  MGC: { symbol: "MGC", label: "Micro Gold", yahoo: "GC=F", pointValue: 10, tick: 0.1, rthOpen: 8 + 20 / 60, rthClose: 13.5, dayMarginUsd: 100 },
};

export const ORB_MINUTES = 15;
export const EXCHANGE_OPEN_HOUR = 18;   // Globex day starts 18:00 ET the prior calendar day
export const CARD_POST_ET = "08:55";    // the morning card goes to Slack once a day at this minute
export const EVENT_HEADS_UP_MIN = 15;
export const MORNING_END_HOUR = 10.5;   // the one robust intraday effect on these markets is time of day

// ---- ET clock ---------------------------------------------------------------------------------
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
export interface EtParts { dayKey: string; weekday: number; hour: number; minute: number; hourFrac: number; hhmm: string }
export function etParts(ms: number): EtParts {
  const p: Record<string, string> = {};
  for (const part of etFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  let hour = Number(p.hour); if (hour === 24) hour = 0;
  const minute = Number(p.minute);
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? ""),
    hour, minute, hourFrac: hour + minute / 60,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}
export function etDayStartMs(dayKey: string, hourFrac: number): number {
  // Walk from the UTC midnight of that date to the ET instant — the offset is 4 or 5 hours, resolved exactly.
  const utcMidnight = Date.parse(`${dayKey}T00:00:00Z`);
  for (const offsetH of [4, 5]) {
    const guess = utcMidnight + (hourFrac + offsetH) * 3_600_000;
    const p = etParts(guess);
    if (p.dayKey === dayKey && Math.abs(p.hourFrac - hourFrac) < 1 / 120) return guess;
  }
  return utcMidnight + (hourFrac + 4) * 3_600_000;
}

// ---- bars → levels ------------------------------------------------------------------------------
export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }   // t = ms

export interface LevelSet {
  symbol: RoomSymbol;
  at: string;                       // when built
  /** "chart" = the Pine study's own numbers, posted at the last 5-minute close (real time);
   *  "yahoo" = built server-side from Yahoo bars (~10 minutes delayed) when the chart is silent. */
  source: "chart" | "yahoo";
  last: number | null; lastAt: string | null;
  priorDay: { high: number; low: number; close: number; dayKey: string } | null;
  overnight: { high: number; low: number; complete: boolean } | null;
  week: { high: number; low: number } | null;
  openingRange: { high: number; low: number; complete: boolean } | null;
  vwap: number | null;
  atrDaily: number | null;          // ATR(14) of exchange days
  atr5m: number | null;             // ATR(14) of the last 5-minute bars
  /** Where the last price sits relative to each level, in points (positive = above). */
  distances: { level: string; price: number; pts: number; atrs: number | null }[];
  note?: string;
}

const hi = (bars: Bar[]) => Math.max(...bars.map((b) => b.h));
const lo = (bars: Bar[]) => Math.min(...bars.map((b) => b.l));

/** ATR over consecutive bars (simple mean of true ranges, the convention in scripts/timeframe-sweep.ts). */
export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const tail = bars.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < tail.length; i++) sum += Math.max(tail[i].h - tail[i].l, Math.abs(tail[i].h - tail[i - 1].c), Math.abs(tail[i].l - tail[i - 1].c));
  return sum / period;
}

/** Group intraday bars into EXCHANGE days (18:00 ET → 17:00 ET), keyed by the day the session settles on. */
export function exchangeDays(bars: Bar[]): { dayKey: string; bars: Bar[] }[] {
  const out: { dayKey: string; bars: Bar[] }[] = [];
  for (const b of bars) {
    const p = etParts(b.t);
    const key = p.hourFrac >= EXCHANGE_OPEN_HOUR ? etParts(b.t + 24 * 3_600_000).dayKey : p.dayKey;
    const last = out[out.length - 1];
    if (last && last.dayKey === key) last.bars.push(b); else out.push({ dayKey: key, bars: [b] });
  }
  return out;
}

export function buildLevels(spec: InstrumentSpec, bars5m: Bar[], daily: Bar[], nowMs: number): LevelSet {
  const at = new Date(nowMs).toISOString();
  const empty: LevelSet = { symbol: spec.symbol, at, source: "yahoo", last: null, lastAt: null, priorDay: null, overnight: null, week: null, openingRange: null, vwap: null, atrDaily: atr(daily), atr5m: null, distances: [] };
  const bars = bars5m.filter((b) => b.t <= nowMs && b.c > 0).sort((a, b) => a.t - b.t);
  if (!bars.length) return { ...empty, note: "no intraday bars" };
  const lastBar = bars[bars.length - 1];
  const now = etParts(nowMs);
  const todayKey = now.dayKey;
  // Today's RTH open/close instants; the "trade day" is the ET calendar date of `now`.
  const rthOpenMs = etDayStartMs(todayKey, spec.rthOpen);
  const rthCloseMs = etDayStartMs(todayKey, spec.rthClose);
  const days = exchangeDays(bars);
  const todayIdx = days.findIndex((d) => d.dayKey === todayKey);
  // Prior EXCHANGE day = the last complete day before today (or before the newest day when today has no bars yet).
  const priorDays = days.filter((d) => d.dayKey < todayKey);
  const prior = priorDays.length ? priorDays[priorDays.length - 1] : null;
  const priorDay = prior ? { high: hi(prior.bars), low: lo(prior.bars), close: prior.bars[prior.bars.length - 1].c, dayKey: prior.dayKey } : null;
  // Overnight: from the prior RTH close to today's RTH open.
  const prevKey = prior?.dayKey ?? null;
  const prevRthCloseMs = prevKey ? etDayStartMs(prevKey, spec.rthClose) : null;
  const onBars = prevRthCloseMs != null ? bars.filter((b) => b.t >= prevRthCloseMs && b.t < rthOpenMs) : [];
  const overnight = onBars.length ? { high: hi(onBars), low: lo(onBars), complete: nowMs >= rthOpenMs } : null;
  // Week: since the most recent Sunday 18:00 ET.
  const daysBack = (now.weekday + 7 - 0) % 7;   // days since Sunday
  const sundayKey = etParts(nowMs - daysBack * 24 * 3_600_000).dayKey;
  let weekStartMs = etDayStartMs(sundayKey, EXCHANGE_OPEN_HOUR);
  if (weekStartMs > nowMs) weekStartMs -= 7 * 24 * 3_600_000;
  const wkBars = bars.filter((b) => b.t >= weekStartMs);
  const week = wkBars.length ? { high: hi(wkBars), low: lo(wkBars) } : null;
  // Opening range: the first ORB_MINUTES of today's RTH.
  const orEndMs = rthOpenMs + ORB_MINUTES * 60_000;
  const orBars = bars.filter((b) => b.t >= rthOpenMs && b.t < orEndMs);
  const openingRange = orBars.length ? { high: hi(orBars), low: lo(orBars), complete: nowMs >= orEndMs } : null;
  // VWAP from the exchange-day open of the day the last bar belongs to.
  const curDay = todayIdx >= 0 ? days[todayIdx] : days[days.length - 1];
  let pv = 0, vv = 0;
  for (const b of curDay.bars) { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; }
  const vwap = vv > 0 ? pv / vv : null;
  const atrDaily = atr(daily);
  const atr5m = atr(bars.slice(-60));
  const last = lastBar.c;
  const distances: LevelSet["distances"] = [];
  const push = (level: string, price: number | null | undefined) => { if (price == null || !Number.isFinite(price)) return; const pts = last - price; distances.push({ level, price, pts, atrs: atrDaily ? pts / atrDaily : null }); };
  push("Prior-day high", priorDay?.high); push("Prior-day low", priorDay?.low); push("Prior-day close", priorDay?.close);
  push("Overnight high", overnight?.high); push("Overnight low", overnight?.low);
  push("Week high", week?.high); push("Week low", week?.low);
  if (openingRange?.complete) { push(`OR${ORB_MINUTES} high`, openingRange.high); push(`OR${ORB_MINUTES} low`, openingRange.low); }
  push("VWAP", vwap);
  const note = rthCloseMs < nowMs && now.hourFrac < EXCHANGE_OPEN_HOUR ? "after the RTH close — tomorrow's card builds from 18:00 ET" : undefined;
  return { symbol: spec.symbol, at, source: "yahoo", last, lastAt: new Date(lastBar.t).toISOString(), priorDay, overnight, week, openingRange, vwap, atrDaily, atr5m, distances, note };
}

// ---- the chart's own level set --------------------------------------------------------------------
// The Pine study posts this once per confirmed 5-minute bar. When it is fresh it IS the card: the
// admin page then shows exactly what the chart shows, in real time, and Yahoo is not consulted.
export const CHART_LEVELS_FRESH_MS = 15 * 60_000;
export interface ChartLevels {
  symbol: RoomSymbol; at: string; receivedAt: string; tf: string;
  price: number; pdh: number | null; pdl: number | null; pdc: number | null; onh: number | null; onl: number | null;
  wh: number | null; wl: number | null; orh: number | null; orl: number | null; orDone: boolean; vwap: number | null;
  atr: number | null; atrD: number | null;
}
export type ParsedChartLevels = { ok: true; levels: ChartLevels } | { ok: false; reason: string };
export function parseChartLevels(body: unknown, receivedMs: number): ParsedChartLevels {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "not an object" };
  const b = body as Record<string, unknown>;
  if (b.room !== "trading" || b.kind !== "levels") return { ok: false, reason: "not a levels message" };
  const root = String(b.symbol ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const symbol = ROOT_TO_SYMBOL[root];
  if (!symbol) return { ok: false, reason: `symbol '${String(b.symbol ?? "")}' is not one of ES/NQ/GC or their micros` };
  const num = (x: unknown): number | null => { const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
  const price = num(b.price);
  if (price == null) return { ok: false, reason: "price missing" };
  const barMs = num(b.bar);
  const at = barMs != null && barMs > 1e12 ? new Date(barMs).toISOString() : new Date(receivedMs).toISOString();
  return { ok: true, levels: { symbol, at, receivedAt: new Date(receivedMs).toISOString(), tf: String(b.tf ?? "").slice(0, 8), price,
    pdh: num(b.pdh), pdl: num(b.pdl), pdc: num(b.pdc), onh: num(b.onh), onl: num(b.onl), wh: num(b.wh), wl: num(b.wl),
    orh: num(b.orh), orl: num(b.orl), orDone: b.orDone === true || b.orDone === "true", vwap: num(b.vwap), atr: num(b.atr), atrD: num(b.atrD) } };
}
export function levelsFromChart(spec: InstrumentSpec, cl: ChartLevels, nowMs: number): LevelSet {
  const last = cl.price;
  const distances: LevelSet["distances"] = [];
  const push = (level: string, price: number | null | undefined) => { if (price == null) return; const pts = last - price; distances.push({ level, price, pts, atrs: cl.atrD ? pts / cl.atrD : null }); };
  push("Prior-day high", cl.pdh); push("Prior-day low", cl.pdl); push("Prior-day close", cl.pdc);
  push("Overnight high", cl.onh); push("Overnight low", cl.onl);
  push("Week high", cl.wh); push("Week low", cl.wl);
  if (cl.orDone) { push(`OR${ORB_MINUTES} high`, cl.orh); push(`OR${ORB_MINUTES} low`, cl.orl); }
  push("VWAP", cl.vwap);
  return {
    symbol: spec.symbol, at: new Date(nowMs).toISOString(), source: "chart", last, lastAt: cl.at,
    priorDay: cl.pdh != null && cl.pdl != null && cl.pdc != null ? { high: cl.pdh, low: cl.pdl, close: cl.pdc, dayKey: etParts(Date.parse(cl.at)).dayKey } : null,
    overnight: cl.onh != null && cl.onl != null ? { high: cl.onh, low: cl.onl, complete: true } : null,
    week: cl.wh != null && cl.wl != null ? { high: cl.wh, low: cl.wl } : null,
    openingRange: cl.orh != null && cl.orl != null ? { high: cl.orh, low: cl.orl, complete: cl.orDone } : null,
    vwap: cl.vwap, atrDaily: cl.atrD, atr5m: cl.atr, distances,
  };
}

// ---- sizing ------------------------------------------------------------------------------------
// Spencer sets his own size (he trades 20+ micros by hand). The room does not size him; it turns HIS
// number into dollars per point and dollars at each stop width, so the card reads as fact, not advice.
export interface RoomSettings {
  contracts: number;           // what he trades, per market
  dailyLossUsd: number | null; // his own line in the sand; null = not set (no default is invented)
  maxTradesPerDay: number | null; // his own count; null = not set. The room says it once when crossed, nothing more.
}
export const DEFAULT_SETTINGS: RoomSettings = { contracts: 20, dailyLossUsd: null, maxTradesPerDay: null };
export function parseSettings(raw: string | null): RoomSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const o = JSON.parse(raw) as Partial<RoomSettings>;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);
    const mt = num(o.maxTradesPerDay);
    return { contracts: Math.min(500, Math.max(1, Math.round(num(o.contracts) ?? DEFAULT_SETTINGS.contracts))), dailyLossUsd: num(o.dailyLossUsd), maxTradesPerDay: mt == null ? null : Math.max(1, Math.round(mt)) };
  } catch { return DEFAULT_SETTINGS; }
}

export interface StopChoice { name: "tight" | "normal" | "wide"; stopPts: number; riskPerContract: number; riskUsd: number }
export interface SizingLine { symbol: RoomSymbol; contracts: number; perPointUsd: number; choices: StopChoice[] }

// Round to the tick and then to the tick's own decimals, so 19 × 0.1 reads 1.9, not 1.9000000000000001.
const roundToTick = (x: number, tick: number) => { const d = Math.max(0, Math.ceil(-Math.log10(tick)) + 1); return Number((Math.round(x / tick) * tick).toFixed(d)); };
/** Three stop widths from the level set's own volatility: tight = 1× 5m ATR, normal = 2× 5m ATR, wide = ¼ daily ATR — each priced at his size. */
export function stopChoices(spec: InstrumentSpec, lv: Pick<LevelSet, "atr5m" | "atrDaily">, contracts: number): StopChoice[] {
  const defs: [StopChoice["name"], number | null][] = [["tight", lv.atr5m], ["normal", lv.atr5m != null ? lv.atr5m * 2 : null], ["wide", lv.atrDaily != null ? lv.atrDaily / 4 : null]];
  const out: StopChoice[] = [];
  for (const [name, raw] of defs) {
    if (raw == null || !(raw > 0)) continue;
    const stopPts = Math.max(spec.tick, roundToTick(raw, spec.tick));
    const riskPerContract = stopPts * spec.pointValue;
    out.push({ name, stopPts, riskPerContract, riskUsd: riskPerContract * contracts });
  }
  return out;
}
export function sizingFor(spec: InstrumentSpec, lv: LevelSet, settings: RoomSettings): SizingLine {
  return { symbol: spec.symbol, contracts: settings.contracts, perPointUsd: spec.pointValue * settings.contracts, choices: stopChoices(spec, lv, settings.contracts) };
}

// ---- the tape: level-break events from the chart ---------------------------------------------------
export const FEED_KINDS = ["or_up", "or_down", "pdh_up", "pdl_down", "onh_up", "onl_down", "wh_up", "wl_down", "vwap_up", "vwap_down"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const FEED_LABEL: Record<FeedKind, string> = {
  or_up: "broke the opening-range high", or_down: "broke the opening-range low",
  pdh_up: "broke the prior-day high", pdl_down: "broke the prior-day low",
  onh_up: "broke the overnight high", onl_down: "broke the overnight low",
  wh_up: "broke the week high", wl_down: "broke the week low",
  vwap_up: "reclaimed VWAP", vwap_down: "lost VWAP",
};
export interface FeedEvent {
  at: string;             // ISO, the chart bar's close
  receivedAt: string;
  symbol: RoomSymbol;
  kind: FeedKind;
  price: number;
  level: number | null;
  atr: number | null;
  volRatio: number | null;
  tf: string;
}
export const FEED_MAX = 200;
export type ParsedFeed = { ok: true; event: FeedEvent } | { ok: false; reason: string };
const ROOT_TO_SYMBOL: Record<string, RoomSymbol> = { ES: "MES", MES: "MES", NQ: "MNQ", MNQ: "MNQ", GC: "MGC", MGC: "MGC" };

/** Shape guard for the chart's JSON. Never throws; a bad message is a refusal with a reason. */
export function parseFeed(body: unknown, receivedMs: number): ParsedFeed {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "not an object" };
  const b = body as Record<string, unknown>;
  if (b.room !== "trading") return { ok: false, reason: "room is not 'trading'" };
  const root = String(b.symbol ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const symbol = ROOT_TO_SYMBOL[root];
  if (!symbol) return { ok: false, reason: `symbol '${String(b.symbol ?? "")}' is not one of ES/NQ/GC or their micros` };
  const kind = FEED_KINDS.find((k) => k === b.kind);
  if (!kind) return { ok: false, reason: `kind '${String(b.kind ?? "")}' is not a level break the room knows` };
  const num = (x: unknown): number | null => { const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN; return Number.isFinite(n) ? n : null; };
  const price = num(b.price);
  if (price == null || price <= 0) return { ok: false, reason: "price missing" };
  const barMs = num(b.bar);
  const at = barMs != null && barMs > 1e12 ? new Date(barMs).toISOString() : new Date(receivedMs).toISOString();
  return { ok: true, event: { at, receivedAt: new Date(receivedMs).toISOString(), symbol, kind, price, level: num(b.level), atr: num(b.atr), volRatio: num(b.volRatio), tf: String(b.tf ?? "").slice(0, 8) } };
}
export const feedKey = (e: Pick<FeedEvent, "symbol" | "kind" | "at">) => `${e.symbol}|${e.kind}|${e.at}`;

/** Prepend and cap; a retry of the same bar+kind is one event. */
export function appendFeed(feed: FeedEvent[], e: FeedEvent): { feed: FeedEvent[]; duplicate: boolean } {
  const key = feedKey(e);
  if (feed.some((x) => feedKey(x) === key)) return { feed, duplicate: true };
  return { feed: [e, ...feed].slice(0, FEED_MAX), duplicate: false };
}

// ---- the news clock ----------------------------------------------------------------------------
export interface RoomEvent { name: string; atMs: number; tier: 1 | 2 | 3; note: string; approx: boolean }
/** Deterministic weekly prints the macro table does not carry: initial jobless claims, every Thursday 08:30 ET. */
export function weeklyPrints(nowMs: number, days = 7): RoomEvent[] {
  const out: RoomEvent[] = [];
  for (let d = 0; d <= days; d++) {
    const p = etParts(nowMs + d * 24 * 3_600_000);
    if (p.weekday === 4) out.push({ name: "Initial jobless claims", atMs: etDayStartMs(p.dayKey, 8.5), tier: 3, note: "08:30 ET · weekly · moves the open for a few minutes", approx: false });
  }
  return out;
}
export function eventNote(tier: 1 | 2 | 3): string {
  if (tier === 1) return "Tier 1 · desk lockout ±30 min · Tradovate raises intraday margin to 4× before the print";
  if (tier === 2) return "Tier 2 · reduced size ±30 min";
  return "Tier 3 · watch the first minutes";
}
