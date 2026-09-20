// THE TRADING ROOM — I/O (Sep 19 2026). Builds the card from free Yahoo bars (10-minute delayed —
// fine for REFERENCE levels; the real-time twin is the Pine study on Spencer's chart), reads his
// LIVE Tradovate account READ-ONLY (balance, positions, the day's fills — the journal's raw
// material), keeps the tape of level breaks the chart posts, and speaks on Slack at 08:55 ET and
// 15 minutes before a tier-1 print. Nothing here can place, change or cancel an order: the only
// Tradovate calls are GETs, and the room never imports the demo desk's executor.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { getHistoricalBars, getIntradayBars } from "@/lib/yahoo";
import { getTradovateAccountSummary, getTradovateFills, getTradovatePositions, resolveContractSymbol } from "@/lib/tradovate";
import { deskCalendar } from "@/lib/futures-desk-calendar";
import { foldJournal, journalView } from "@/lib/trading-room-journal-store";
import { dayTally } from "@/lib/trading-room-journal";
import { syncLedger } from "@/lib/trading-room-ledger";
import {
  CARD_POST_ET, CHART_LEVELS_FRESH_MS, EVENT_HEADS_UP_MIN, FEED_LABEL, INSTRUMENTS, ROOM_SYMBOLS, appendFeed, buildLevels, etParts, eventNote, levelsFromChart, parseSettings, sizingFor, weeklyPrints,
  type Bar, type ChartLevels, type FeedEvent, type LevelSet, type RoomEvent, type RoomSettings, type SizingLine,
} from "@/lib/trading-room-rules";

export const SETTINGS_KEY = "trading_room_settings";
export const CARD_KEY = "trading_room_card";
export const FEED_KEY = "trading_room_feed";
export const STATE_KEY = "trading_room_state";
export const LIVE_KEY = "trading_room_live";
export const CHART_KEY = "trading_room_chart_levels";
const LANE = "futures" as const;

async function cfg(key: string): Promise<string | null> {
  return (await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null))?.value ?? null;
}
async function setKey(key: string, value: string): Promise<void> {
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// ---- the fills table: raw SQL so a schema push can never drop it (same rule as the desk's tables) ----
export async function ensureRoomTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS trading_room_fills (
    id bigint PRIMARY KEY, order_id bigint, contract_id bigint, contract text, ts timestamptz NOT NULL,
    trade_date date, action text NOT NULL, qty int NOT NULL, price float8 NOT NULL, received_at timestamptz NOT NULL DEFAULT now())`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS trading_room_fills_ts ON trading_room_fills (ts)`);
}

// ---- the card ----------------------------------------------------------------------------------
export interface RoomCard { at: string; levels: Record<string, LevelSet>; events: RoomEvent[]; errors: string[] }

async function yahooBars(symbol: string): Promise<{ bars5m: Bar[]; daily: Bar[] }> {
  const [intra, hist] = await Promise.all([getIntradayBars(symbol, "5m", "5d"), getHistoricalBars(symbol, 45)]);
  const bars5m: Bar[] = intra.filter((b) => b.t > 0).map((b) => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  const daily: Bar[] = hist.filter((b) => b.t).map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  return { bars5m, daily };
}

export function roomEvents(nowMs: number, days = 7): RoomEvent[] {
  const horizon = nowMs + days * 24 * 3_600_000;
  const macro: RoomEvent[] = deskCalendar(new Date(nowMs))
    .filter((e) => e.atMs >= nowMs - 2 * 3_600_000 && e.atMs <= horizon)
    .map((e) => ({ name: e.name, atMs: e.atMs, tier: e.tier, note: eventNote(e.tier), approx: e.approx }));
  const weekly = weeklyPrints(nowMs, days).filter((e) => e.atMs >= nowMs - 2 * 3_600_000 && e.atMs <= horizon);
  return [...macro, ...weekly].sort((a, b) => a.atMs - b.atMs);
}

/** The chart's level sets, one per symbol, as last posted by the Pine study. */
export async function loadChartLevels(): Promise<Record<string, ChartLevels>> { return parseJson<Record<string, ChartLevels>>(await cfg(CHART_KEY), {}); }
export async function recordChartLevels(cl: ChartLevels): Promise<void> {
  const all = await loadChartLevels();
  all[cl.symbol] = cl;
  await setKey(CHART_KEY, JSON.stringify(all));
}

export async function buildCard(nowMs = Date.now()): Promise<RoomCard> {
  const levels: Record<string, LevelSet> = {};
  const errors: string[] = [];
  const chart = await loadChartLevels();
  for (const sym of ROOM_SYMBOLS) {
    const spec = INSTRUMENTS[sym];
    // The chart's own numbers win while they are fresh; Yahoo fills in when the chart is silent.
    const cl = chart[sym];
    if (cl && nowMs - Date.parse(cl.receivedAt) < CHART_LEVELS_FRESH_MS) { levels[sym] = levelsFromChart(spec, cl, nowMs); continue; }
    try {
      const { bars5m, daily } = await yahooBars(spec.yahoo);
      levels[sym] = buildLevels(spec, bars5m, daily, nowMs);
      if (!bars5m.length) errors.push(`${sym}: Yahoo returned no intraday bars`);
    } catch (e) {
      errors.push(`${sym}: ${String(e).slice(0, 160)}`);
    }
  }
  const card: RoomCard = { at: new Date(nowMs).toISOString(), levels, events: roomEvents(nowMs), errors };
  await setKey(CARD_KEY, JSON.stringify(card));
  return card;
}

// ---- the live account, read-only -----------------------------------------------------------------
const contractNames = new Map<number, string | null>();   // contractId → "MESZ6"; one broker read per contract per process
async function contractName(contractId: number): Promise<string | null> {
  if (!contractNames.has(contractId)) contractNames.set(contractId, await resolveContractSymbol(contractId, "live").catch(() => null));
  return contractNames.get(contractId) ?? null;
}
export interface LiveSnapshot {
  at: string; ok: boolean; error?: string;
  balance: number | null; netLiq: number | null; realizedPnl: number | null; unrealizedPnl: number | null; marginUsed: number | null;
  positions: { contract: string; netPos: number; netPrice: number }[];
  fillsToday: number;
}
export async function refreshLive(nowMs = Date.now()): Promise<LiveSnapshot> {
  const at = new Date(nowMs).toISOString();
  try {
    const [summary, positions, fills] = await Promise.all([getTradovateAccountSummary("live"), getTradovatePositions("live"), getTradovateFills("live")]);
    await ensureRoomTables();
    // Persist every fill the session reports (idempotent on the broker's fill id). /fill/list is
    // session-scoped, so this runs through the day; the journal (Sprint 2) reads from this table.
    let stored = 0;
    for (const f of fills) {
      if (!f || typeof f.id !== "number") continue;
      const contract = await contractName(f.contractId);
      const tradeDate = f.tradeDate ? `${f.tradeDate.year}-${String(f.tradeDate.month).padStart(2, "0")}-${String(f.tradeDate.day).padStart(2, "0")}` : null;
      await prisma.$executeRawUnsafe(
        `INSERT INTO trading_room_fills (id, order_id, contract_id, contract, ts, trade_date, action, qty, price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        f.id, f.orderId ?? null, f.contractId ?? null, contract, new Date(f.timestamp), tradeDate, String(f.action), Number(f.qty) || 0, Number(f.price) || 0,
      );
      stored++;
    }
    const open = positions.filter((p) => p.netPos !== 0).map((p) => ({ contract: p.contractName, netPos: p.netPos, netPrice: p.netPrice }));
    const snap: LiveSnapshot = { at, ok: true, balance: summary.balance, netLiq: summary.netLiq, realizedPnl: summary.realizedPnl, unrealizedPnl: summary.unrealizedPnl, marginUsed: summary.marginUsed, positions: open, fillsToday: stored };
    await setKey(LIVE_KEY, JSON.stringify(snap));
    return snap;
  } catch (e) {
    const prev = parseJson<LiveSnapshot | null>(await cfg(LIVE_KEY), null);
    const snap: LiveSnapshot = { ...(prev ?? { balance: null, netLiq: null, realizedPnl: null, unrealizedPnl: null, marginUsed: null, positions: [], fillsToday: 0 }), at: prev?.at ?? at, ok: false, error: String(e).slice(0, 200) };
    await setKey(LIVE_KEY, JSON.stringify(snap)).catch(() => {});
    return snap;
  }
}

// ---- the tape ---------------------------------------------------------------------------------
export async function loadFeed(): Promise<FeedEvent[]> { return parseJson<FeedEvent[]>(await cfg(FEED_KEY), []); }
export async function recordFeed(e: FeedEvent): Promise<{ duplicate: boolean }> {
  const { feed, duplicate } = appendFeed(await loadFeed(), e);
  if (duplicate) return { duplicate: true };
  await setKey(FEED_KEY, JSON.stringify(feed));
  const vol = e.volRatio != null ? ` · vol ${e.volRatio.toFixed(1)}× avg` : "";
  const lvl = e.level != null ? ` (level ${e.level})` : "";
  await sendNotification(`📈 ${e.symbol} ${FEED_LABEL[e.kind]} at ${e.price}${lvl}${vol} · ${etParts(Date.parse(e.at)).hhmm} ET`, LANE).catch(() => {});
  return { duplicate: false };
}

// ---- the tick (cron, every 5 minutes on weekdays) ------------------------------------------------
interface RoomState { cardPostedDay?: string; headsUp?: Record<string, string>; lossLineDay?: string; flattenWarnDay?: string; tradeCountDay?: string; announced?: string[]; lastTickAt?: string; lastError?: string }

function cardText(card: RoomCard, sizing: Record<string, SizingLine | null>, live: LiveSnapshot): string {
  const lines: string[] = [`☀️ Trading Room · ${etParts(Date.parse(card.at)).dayKey}`];
  for (const sym of ROOM_SYMBOLS) {
    const lv = card.levels[sym]; if (!lv) continue;
    const f = (x: number | null | undefined) => (x == null ? "—" : x.toFixed(sym === "MGC" ? 1 : 2));   // Yahoo's floats carry noise
    const pd = lv.priorDay ? `PDH ${f(lv.priorDay.high)} · PDL ${f(lv.priorDay.low)} · PDC ${f(lv.priorDay.close)}` : "prior day n/a";
    const on = lv.overnight ? `ON ${f(lv.overnight.low)}–${f(lv.overnight.high)}` : "overnight n/a";
    const wk = lv.week ? `week ${f(lv.week.low)}–${f(lv.week.high)}` : "";
    const a = lv.atrDaily != null ? `ATR(d) ${f(lv.atrDaily)}` : "";
    const s = sizing[sym];
    const size = s ? `${s.contracts} ${sym} = $${s.perPointUsd}/pt · ${s.choices.map((c) => `${c.name} ${c.stopPts}pt = $${Math.round(c.riskUsd).toLocaleString()}`).join(" · ")}` : "";
    lines.push(`• ${sym} ${f(lv.last)} · ${pd} · ${on} · ${wk} · ${a}\n   ${size}`);
  }
  const today = etParts(Date.parse(card.at)).dayKey;
  const ev = card.events.filter((e) => etParts(e.atMs).dayKey === today);
  lines.push(ev.length ? `📅 ${ev.map((e) => `${etParts(e.atMs).hhmm} ${e.name}${e.tier === 1 ? " (tier 1 · lockout ±30m)" : ""}`).join(" · ")}` : "📅 no scheduled prints today");
  if (live.ok && live.netLiq != null) lines.push(`💼 Tradovate live: net liq $${Math.round(live.netLiq).toLocaleString()}${live.positions.length ? ` · open: ${live.positions.map((p) => `${p.contract} ${p.netPos > 0 ? "+" : ""}${p.netPos}`).join(", ")}` : ""}`);
  return lines.join("\n");
}

export async function roomTick(nowMs = Date.now()): Promise<{ ok: boolean; notes: string[] }> {
  const notes: string[] = [];
  const state = parseJson<RoomState>(await cfg(STATE_KEY), {});
  const now = etParts(nowMs);
  let card: RoomCard | null = null;
  try { card = await buildCard(nowMs); notes.push(`card: ${Object.keys(card.levels).length} instruments${card.errors.length ? ` · ${card.errors.join("; ")}` : ""}`); }
  catch (e) { notes.push(`card failed: ${String(e).slice(0, 160)}`); state.lastError = String(e).slice(0, 200); }
  const live = await refreshLive(nowMs);
  notes.push(live.ok ? `live: net liq ${live.netLiq} · ${live.positions.length} open · ${live.fillsToday} fills seen` : `live read failed: ${live.error}`);
  // The broker's own ledger (realized P&L and fees per trade) — the money truth, kept even when fills expire.
  try { const l = await syncLedger(); notes.push(`ledger: ${l.seen} rows seen · ${l.stored} new`); }
  catch (e) { notes.push(`ledger failed: ${String(e).slice(0, 160)}`); }
  // The journal: fills → round trips, stamped and scored. Its failure never blocks the card.
  try { const j = await foldJournal(nowMs); notes.push(`journal: ${j.trips} trips (${j.open} open) · ${j.updated} written`); }
  catch (e) { notes.push(`journal failed: ${String(e).slice(0, 160)}`); }
  const settings = parseSettings(await cfg(SETTINGS_KEY));
  // The morning card: once per weekday, at or after CARD_POST_ET, before the RTH open.
  if (card && now.weekday >= 1 && now.weekday <= 5 && now.hhmm >= CARD_POST_ET && now.hourFrac < 9.5 && state.cardPostedDay !== now.dayKey) {
    const sizing: Record<string, SizingLine | null> = {};
    for (const sym of ROOM_SYMBOLS) sizing[sym] = card.levels[sym] ? sizingFor(INSTRUMENTS[sym], card.levels[sym], settings) : null;
    await sendNotification(cardText(card, sizing, live), LANE).catch((e) => notes.push(`slack: ${String(e).slice(0, 100)}`));
    state.cardPostedDay = now.dayKey;
    notes.push("morning card posted");
  }
  // Heads-up 15 minutes before a tier-1 or tier-2 print, once per event.
  if (card) {
    state.headsUp ??= {};
    for (const e of card.events) {
      if (e.tier === 3) continue;
      const key = `${e.name}@${e.atMs}`;
      const minsTo = (e.atMs - nowMs) / 60_000;
      if (minsTo <= EVENT_HEADS_UP_MIN && minsTo > 0 && !state.headsUp[key]) {
        await sendNotification(`⏰ ${e.name} in ${Math.round(minsTo)} min (${etParts(e.atMs).hhmm} ET) — ${e.note}`, LANE).catch(() => {});
        state.headsUp[key] = new Date(nowMs).toISOString();
        notes.push(`heads-up: ${e.name}`);
      }
    }
    for (const k of Object.keys(state.headsUp)) if (nowMs - Date.parse(state.headsUp[k]) > 3 * 24 * 3_600_000) delete state.headsUp[k];
  }
  // THE TRADE METER: one line per closed round trip — the trade, then the day so far with the fee total in it. On Sep 18 he
  // was gross +$14.50 and paid $643 without seeing either number until Saturday; now he sees both after every trade.
  try {
    const rows = (await journalView(60)).rows;
    state.announced ??= [];
    const fresh = rows.filter((r) => !r.open && !state.announced!.includes(r.id) && nowMs - Date.parse(r.exitTs) < 6 * 3_600_000).sort((a, b) => Date.parse(a.exitTs) - Date.parse(b.exitTs));
    for (const r of fresh) {
      const t = dayTally(rows, (ms) => etParts(ms).dayKey, etParts(Date.parse(r.exitTs)).dayKey);
      const money = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(Math.round(x)).toLocaleString()}`;
      const rr = r.netR == null ? "" : ` · ${r.netR >= 0 ? "+" : "−"}${Math.abs(r.netR).toFixed(1)}R${r.riskSource === "atr-proxy" ? "*" : ""}`;
      await sendNotification(`${r.netUsd >= 0 ? "✅" : "❌"} ${r.symbol} ${r.side} ×${r.qty} · ${money(r.netUsd)} net${rr} · ${Math.round(r.holdMin)} min · ${r.session}${r.nearestLevel ? ` · near ${r.nearestLevel}` : ""}\n   today: trade ${t.n} · ${money(t.netUsd)} net · fees $${Math.round(t.feesUsd)} · ${t.wins}W/${t.losses}L${settings.maxTradesPerDay ? ` · your line ${settings.maxTradesPerDay}` : ""}`, LANE).catch(() => {});
      state.announced.push(r.id);
      if (settings.maxTradesPerDay != null && t.n >= settings.maxTradesPerDay && state.tradeCountDay !== now.dayKey) {
        await sendNotification(`🛑 That is trade ${t.n} today — your own line is ${settings.maxTradesPerDay}. Fees so far $${Math.round(t.feesUsd)}. Sep 18 was 22 trades and $643 in fees for +$14.50 gross.`, LANE).catch(() => {});
        state.tradeCountDay = now.dayKey;
        notes.push("trade count line crossed");
      }
    }
    if (fresh.length) notes.push(`announced ${fresh.length} closed trade(s)`);
    if (state.announced.length > 300) state.announced = state.announced.slice(-300);
  } catch (e) { notes.push(`trade meter failed: ${String(e).slice(0, 120)}`); }
  // His own daily loss line: one message the moment the day's realized loss crosses it. His number, his call — the room only says it.
  if (live.ok && settings.dailyLossUsd != null && live.realizedPnl != null && -live.realizedPnl >= settings.dailyLossUsd && state.lossLineDay !== now.dayKey) {
    await sendNotification(`🛑 Past your daily loss line: realized ${Math.round(live.realizedPnl)} today vs. your line of −$${Math.round(settings.dailyLossUsd)}${live.positions.length ? ` · still open: ${live.positions.map((p) => `${p.contract} ${p.netPos > 0 ? "+" : ""}${p.netPos}`).join(", ")}` : ""}`, LANE).catch(() => {});
    state.lossLineDay = now.dayKey;
    notes.push("loss line crossed");
  }
  // The broker flattens intraday positions at ~4:45 PM ET and charges a liquidation fee. One nudge at 4:30 if anything is open.
  if (live.ok && live.positions.length && now.weekday >= 1 && now.weekday <= 5 && now.hourFrac >= 16.5 && now.hourFrac < 16.75 && state.flattenWarnDay !== now.dayKey) {
    await sendNotification(`⏳ 4:30 PM ET — still open: ${live.positions.map((p) => `${p.contract} ${p.netPos > 0 ? "+" : ""}${p.netPos}`).join(", ")}. Tradovate auto-flattens intraday positions around 4:45 PM and charges a $50 liquidation fee (it did on Sep 18).`, LANE).catch(() => {});
    state.flattenWarnDay = now.dayKey;
    notes.push("flatten warning");
  }
  state.lastTickAt = new Date(nowMs).toISOString();
  await setKey(STATE_KEY, JSON.stringify(state));
  return { ok: !!card && live.ok, notes };
}

// ---- the page's read ---------------------------------------------------------------------------
export interface RoomView {
  at: string;
  settings: RoomSettings;
  card: RoomCard | null;
  sizing: Record<string, SizingLine | null>;
  live: LiveSnapshot | null;
  feed: FeedEvent[];
  state: RoomState;
}
export async function roomView(): Promise<RoomView> {
  const [settingsRaw, cardRaw, liveRaw, feed, stateRaw] = await Promise.all([cfg(SETTINGS_KEY), cfg(CARD_KEY), cfg(LIVE_KEY), loadFeed(), cfg(STATE_KEY)]);
  const settings = parseSettings(settingsRaw);
  const card = parseJson<RoomCard | null>(cardRaw, null);
  const live = parseJson<LiveSnapshot | null>(liveRaw, null);
  const sizing: Record<string, SizingLine | null> = {};
  for (const sym of ROOM_SYMBOLS) sizing[sym] = card?.levels[sym] ? sizingFor(INSTRUMENTS[sym], card.levels[sym], settings) : null;
  return { at: new Date().toISOString(), settings, card, sizing, live, feed: feed.slice(0, 60), state: parseJson<RoomState>(stateRaw, {}) };
}
export async function saveSettings(patch: Partial<RoomSettings>): Promise<RoomSettings> {
  const cur = parseSettings(await cfg(SETTINGS_KEY));
  const next = parseSettings(JSON.stringify({ ...cur, ...patch }));
  await setKey(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
