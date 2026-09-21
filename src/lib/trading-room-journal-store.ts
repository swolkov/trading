// THE JOURNAL — I/O (Sprint 2). Folds trading_room_fills into trading_room_trades every room tick,
// stamps each round trip with the chart's context at entry and the excursions inside it, keeps
// Spencer's own tag / why on the row, and serves the scoreboard. Read-only against the broker
// (fills, positions, stop orders) — the room has no order path.
import { prisma } from "@/lib/db";
import { getHistoricalBars, getIntradayBars } from "@/lib/yahoo";
import { getTradovateStopOrders, resolveContractSymbol } from "@/lib/tradovate";
import { deskCalendar } from "@/lib/futures-desk-calendar";
import { INSTRUMENTS, ROOM_SYMBOLS, buildLevels, etParts, type Bar, type RoomSymbol } from "@/lib/trading-room-rules";
import { TEST_RULES, excursion, riskPerContract, roundTripsFromFills, scoreboard, sessionBucket, type JournalFill, type JournalRow, type RoundTrip, type Scoreboard } from "@/lib/trading-room-journal";

const EVENT_WINDOW_MS = 30 * 60_000;
const LOOKBACK_DAYS = 14;

export async function ensureJournalTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS trading_room_trades (
    id text PRIMARY KEY, symbol text NOT NULL, side text NOT NULL, qty int NOT NULL,
    entry_ts timestamptz NOT NULL, exit_ts timestamptz NOT NULL, entry_px float8 NOT NULL, exit_px float8 NOT NULL,
    gross_usd float8 NOT NULL, fees_usd float8 NOT NULL, net_usd float8 NOT NULL,
    stop_px float8, risk_usd float8, risk_source text NOT NULL DEFAULT 'none',
    net_r float8, mfe_r float8, mae_r float8, hold_min float8 NOT NULL,
    session text NOT NULL, dow int NOT NULL, nearest_level text, nearest_level_px float8, dist_atr float8, event_flag text,
    setup_tag text, why text, open boolean NOT NULL DEFAULT false, fill_ids text NOT NULL DEFAULT '[]',
    updated_at timestamptz NOT NULL DEFAULT now())`);
  await prisma.$executeRawUnsafe(`ALTER TABLE trading_room_trades ADD COLUMN IF NOT EXISTS grade text`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS trading_room_trades_entry ON trading_room_trades (entry_ts)`);
}

interface FillRow { id: number; contract: string | null; ts: Date; action: string; qty: number; price: number }
async function loadFills(nowMs: number): Promise<JournalFill[]> {
  const since = new Date(nowMs - LOOKBACK_DAYS * 24 * 3_600_000);
  const rows = await prisma.$queryRawUnsafe<FillRow[]>(`SELECT id, contract, ts, action, qty, price FROM trading_room_fills WHERE ts >= $1 ORDER BY ts, id`, since);
  return rows.flatMap((r) => {
    const sym = ROOM_SYMBOLS.find((s) => s === (r.contract ?? "").toUpperCase());
    const action = r.action === "Buy" ? "Buy" : r.action === "Sell" ? "Sell" : null;
    if (!sym || !action || !(r.qty > 0)) return [];
    return [{ id: Number(r.id), symbol: sym, ts: new Date(r.ts).getTime(), action, qty: Number(r.qty), price: Number(r.price) }];
  });
}

const tripId = (t: RoundTrip) => `${t.symbol}-${t.entryTs}-${t.fillIds[0]}`;

/** Per-symbol bars for the stamps: 5-minute (levels, ATR at entry) and 1-minute (excursions). Fetched once per fold. */
async function barsFor(symbol: RoomSymbol): Promise<{ bars5m: Bar[]; bars1m: Bar[]; daily: Bar[] }> {
  const y = INSTRUMENTS[symbol].yahoo;
  const [i5, i1, hist] = await Promise.all([getIntradayBars(y, "5m", "5d"), getIntradayBars(y, "1m", "7d"), getHistoricalBars(y, 45)]);
  const conv = (b: { t: number; o: number; h: number; l: number; c: number; v: number }): Bar => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  return { bars5m: i5.filter((b) => b.t > 0).map(conv), bars1m: i1.filter((b) => b.t > 0).map(conv), daily: hist.filter((b) => b.t).map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })) };
}

const contractRoots = new Map<number, string | null>();
async function rootOf(contractId: number): Promise<string | null> {
  if (!contractRoots.has(contractId)) contractRoots.set(contractId, await resolveContractSymbol(contractId, "live").catch(() => null));
  return contractRoots.get(contractId) ?? null;
}

/** The stop Spencer placed for a trip: a stop order on the same root, opposite side, placed at or after entry. First one seen wins. */
async function stopFor(trip: RoundTrip, stops: { contractId: number; action: string; ordStatus: string; stopPrice: number | null; timestamp: string }[]): Promise<number | null> {
  const want = trip.side === "long" ? "Sell" : "Buy";
  for (const s of stops) {
    if (s.action !== want || s.stopPrice == null) continue;
    const t = Date.parse(s.timestamp);
    if (!Number.isFinite(t) || t < trip.entryTs - 5 * 60_000 || t > trip.exitTs + 5 * 60_000) continue;
    if ((await rootOf(s.contractId)) !== trip.symbol) continue;
    return s.stopPrice;
  }
  return null;
}

/** `force` recomputes every trip in the lookback (fees, excursion, levels) — tags, whys, grades and stops are kept. */
export async function foldJournal(nowMs = Date.now(), force = false): Promise<{ trips: number; open: number; updated: number }> {
  await ensureJournalTable();
  const fills = await loadFills(nowMs);
  const trips = roundTripsFromFills(fills);
  if (!trips.length) return { trips: 0, open: 0, updated: 0 };
  const existing = await prisma.$queryRawUnsafe<{ id: string; stop_px: number | null; open: boolean; exit_ts: Date; mfe_r: number | null }[]>(`SELECT id, stop_px, open, exit_ts, mfe_r FROM trading_room_trades WHERE entry_ts >= $1`, new Date(nowMs - LOOKBACK_DAYS * 24 * 3_600_000));
  const known = new Map(existing.map((e) => [e.id, e]));
  const stops = await getTradovateStopOrders("live");
  const events = deskCalendar(new Date(nowMs));
  const barsCache = new Map<RoomSymbol, Awaited<ReturnType<typeof barsFor>>>();
  let updated = 0;
  for (const trip of trips) {
    const id = tripId(trip);
    const prev = known.get(id);
    // A closed trip already folded with the same exit AND a measured excursion is final — nothing to recompute, and the
    // tag/why stay. (Yahoo's bars run ~10 minutes behind, so a trip folded right after it closed waits for its bars.)
    if (!force && prev && !prev.open && !trip.open && new Date(prev.exit_ts).getTime() === trip.exitTs && prev.mfe_r != null) continue;
    const spec = INSTRUMENTS[trip.symbol];
    if (!barsCache.has(trip.symbol)) barsCache.set(trip.symbol, await barsFor(trip.symbol).catch(() => ({ bars5m: [], bars1m: [], daily: [] })));
    const { bars5m, bars1m, daily } = barsCache.get(trip.symbol)!;
    const lv = bars5m.length ? buildLevels(spec, bars5m, daily, trip.entryTs) : null;
    const nearest = lv?.distances.length ? [...lv.distances].sort((a, b) => Math.abs(a.pts) - Math.abs(b.pts))[0] : null;
    const stopPx = prev?.stop_px ?? (await stopFor(trip, stops));
    const risk = riskPerContract(spec, trip.entryPx, stopPx, lv?.atr5m ?? null);
    const riskUsd = risk ? risk.usd * trip.qty : null;
    // Excursion only once the 1-minute bars reach the exit; until then it is left null and measured on a later tick.
    const covered = bars1m.length > 0 && bars1m[bars1m.length - 1].t >= (trip.open ? trip.entryTs : trip.exitTs);
    const excRaw = covered ? excursion(bars1m, trip.side, trip.entryPx, trip.entryTs, trip.exitTs) : null;
    // The exit itself is an excursion the bars may have missed (a fill between prints): MFE is at least the exit's gain, MAE at least its loss.
    const exitFav = (trip.side === "long" ? 1 : -1) * (trip.exitPx - trip.entryPx);
    const exc = excRaw && !trip.open ? { mfePts: Math.max(excRaw.mfePts, exitFav), maePts: Math.max(excRaw.maePts, -exitFav) } : excRaw;
    const perContractR = risk?.usd ?? null;
    const ev = events.find((e) => Math.abs(e.atMs - trip.entryTs) <= EVENT_WINDOW_MS);
    const row = {
      id, symbol: trip.symbol, side: trip.side, qty: trip.qty,
      entry_ts: new Date(trip.entryTs), exit_ts: new Date(trip.exitTs), entry_px: trip.entryPx, exit_px: trip.exitPx,
      gross_usd: trip.grossUsd, fees_usd: trip.feesUsd, net_usd: trip.netUsd,
      stop_px: stopPx, risk_usd: riskUsd, risk_source: risk?.source ?? "none",
      net_r: riskUsd ? trip.netUsd / riskUsd : null,
      mfe_r: exc && perContractR ? (exc.mfePts * spec.pointValue) / perContractR : null,
      mae_r: exc && perContractR ? (exc.maePts * spec.pointValue) / perContractR : null,
      hold_min: (trip.exitTs - trip.entryTs) / 60_000,
      session: sessionBucket(trip.entryTs), dow: etParts(trip.entryTs).weekday,
      nearest_level: nearest?.level ?? null, nearest_level_px: nearest?.price ?? null, dist_atr: nearest?.atrs ?? null,
      event_flag: ev?.name ?? null, open: trip.open, fill_ids: JSON.stringify(trip.fillIds),
    };
    await prisma.$executeRawUnsafe(
      `INSERT INTO trading_room_trades (id, symbol, side, qty, entry_ts, exit_ts, entry_px, exit_px, gross_usd, fees_usd, net_usd, stop_px, risk_usd, risk_source, net_r, mfe_r, mae_r, hold_min, session, dow, nearest_level, nearest_level_px, dist_atr, event_flag, open, fill_ids, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26, now())
       ON CONFLICT (id) DO UPDATE SET qty = EXCLUDED.qty, exit_ts = EXCLUDED.exit_ts, entry_px = EXCLUDED.entry_px, exit_px = EXCLUDED.exit_px,
         gross_usd = EXCLUDED.gross_usd, fees_usd = EXCLUDED.fees_usd, net_usd = EXCLUDED.net_usd,
         stop_px = COALESCE(trading_room_trades.stop_px, EXCLUDED.stop_px), risk_usd = EXCLUDED.risk_usd, risk_source = EXCLUDED.risk_source,
         net_r = EXCLUDED.net_r, mfe_r = EXCLUDED.mfe_r, mae_r = EXCLUDED.mae_r, hold_min = EXCLUDED.hold_min, session = EXCLUDED.session, dow = EXCLUDED.dow,
         nearest_level = EXCLUDED.nearest_level, nearest_level_px = EXCLUDED.nearest_level_px, dist_atr = EXCLUDED.dist_atr, event_flag = EXCLUDED.event_flag,
         open = EXCLUDED.open, fill_ids = EXCLUDED.fill_ids, updated_at = now()`,
      row.id, row.symbol, row.side, row.qty, row.entry_ts, row.exit_ts, row.entry_px, row.exit_px, row.gross_usd, row.fees_usd, row.net_usd,
      row.stop_px, row.risk_usd, row.risk_source, row.net_r, row.mfe_r, row.mae_r, row.hold_min, row.session, row.dow,
      row.nearest_level, row.nearest_level_px, row.dist_atr, row.event_flag, row.open, row.fill_ids,
    );
    updated++;
  }
  return { trips: trips.length, open: trips.filter((t) => t.open).length, updated };
}

interface TradeRow {
  id: string; symbol: string; side: string; qty: number; entry_ts: Date; exit_ts: Date; entry_px: number; exit_px: number;
  gross_usd: number; fees_usd: number; net_usd: number; stop_px: number | null; risk_usd: number | null; risk_source: string;
  net_r: number | null; mfe_r: number | null; mae_r: number | null; hold_min: number; session: string; dow: number;
  nearest_level: string | null; nearest_level_px: number | null; dist_atr: number | null; event_flag: string | null;
  setup_tag: string | null; why: string | null; grade: string | null; open: boolean; fill_ids: string;
}
function toRow(r: TradeRow): JournalRow {
  return {
    id: r.id, symbol: r.symbol as RoomSymbol, side: r.side as "long" | "short", qty: Number(r.qty),
    entryTs: new Date(r.entry_ts).toISOString(), exitTs: new Date(r.exit_ts).toISOString(), entryPx: Number(r.entry_px), exitPx: Number(r.exit_px),
    grossUsd: Number(r.gross_usd), feesUsd: Number(r.fees_usd), netUsd: Number(r.net_usd),
    stopPx: r.stop_px == null ? null : Number(r.stop_px), riskUsd: r.risk_usd == null ? null : Number(r.risk_usd), riskSource: (r.risk_source as JournalRow["riskSource"]) ?? "none",
    netR: r.net_r == null ? null : Number(r.net_r), mfeR: r.mfe_r == null ? null : Number(r.mfe_r), maeR: r.mae_r == null ? null : Number(r.mae_r),
    holdMin: Number(r.hold_min), session: r.session as JournalRow["session"], dow: Number(r.dow),
    nearestLevel: r.nearest_level, nearestLevelPx: r.nearest_level_px == null ? null : Number(r.nearest_level_px), distAtr: r.dist_atr == null ? null : Number(r.dist_atr),
    eventFlag: r.event_flag, setupTag: r.setup_tag, why: r.why, grade: r.grade ?? null, open: r.open, fillIds: JSON.parse(r.fill_ids || "[]"),
  };
}

export interface JournalView { rows: JournalRow[]; scoreboard: Scoreboard; rules: typeof TEST_RULES }
export async function journalView(limit = 200): Promise<JournalView> {
  await ensureJournalTable();
  const rows = (await prisma.$queryRawUnsafe<TradeRow[]>(`SELECT * FROM trading_room_trades ORDER BY entry_ts DESC LIMIT $1`, limit)).map(toRow);
  const eventTimes = deskCalendar(new Date(Date.now() - 90 * 24 * 3_600_000)).map((e) => e.atMs);
  return { rows, scoreboard: scoreboard(rows, EVENT_WINDOW_MS, eventTimes), rules: TEST_RULES };
}

/** Spencer's words on a trade — a one-word setup tag, a one-line why, a grade A–F. The only write the journal accepts.
 *  A field left undefined is kept; an empty string clears it. */
export async function setJournalNote(id: string, note: { setupTag?: string | null; why?: string | null; grade?: string | null }): Promise<boolean> {
  await ensureJournalTable();
  const sets: string[] = [], vals: unknown[] = [id];
  const put = (col: string, v: string | null) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (note.setupTag !== undefined) put("setup_tag", note.setupTag == null ? null : String(note.setupTag).trim().slice(0, 24) || null);
  if (note.why !== undefined) put("why", note.why == null ? null : String(note.why).trim().slice(0, 240) || null);
  if (note.grade !== undefined) { const g = note.grade == null ? "" : String(note.grade).trim().toUpperCase().slice(0, 1); put("grade", ["A", "B", "C", "D", "F"].includes(g) ? g : null); }
  if (!sets.length) return false;
  const n = await prisma.$executeRawUnsafe(`UPDATE trading_room_trades SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, ...vals);
  return Number(n) > 0;
}
