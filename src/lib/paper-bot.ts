// THE PAPER BOT — I/O (Sep 23 2026). PAPER ONLY: this file places no order and imports nothing that can. From the
// room's 5-minute tick (via resolveSetups) it replays the setups his chart posted through the bot's rules on Yahoo's
// 1-minute bars, stores each paper trade (raw SQL table, so a schema push can never drop it), and says each entry and
// exit once in #futures-copilot. Final rows are never recomputed — a revised Yahoo bar can't rewrite the record.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { getIntradayBars } from "@/lib/yahoo";
import { INSTRUMENTS, type Bar, type RoomSymbol } from "@/lib/trading-room-rules";
import type { Setup } from "@/lib/setup-feed-rules";
import { botDay, botEntryText, botExitText, botRecapText, botSkipText, runPaperBot, type BotDayRow, type PaperTrade, type Settled } from "@/lib/paper-bot-rules";

const WINDOW_MS = 6 * 86_400_000;   // Yahoo's 1-minute history is 7 days
const ANNOUNCE_MS = 60 * 60_000;     // only events from the last hour are said in Slack (a first run / backfill is recorded quietly)
const LATE_MS = 15 * 60_000;         // a setup that reached us this long after its bar opened is not traded

export async function ensurePaperTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS paper_bot_trades (
    id text PRIMARY KEY, symbol text NOT NULL, side int NOT NULL, at timestamptz NOT NULL, status text NOT NULL,
    skip text, entered boolean, entry_at timestamptz, contracts int, runner int, entry float8, stop float8, risk_usd float8,
    exit_at timestamptz, free_at timestamptz, how text, usd float8, gross_usd float8, r float8, peak_r float8, trade_no int,
    posted_entry boolean NOT NULL DEFAULT false, posted_final boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now())`);
  await prisma.$executeRawUnsafe(`ALTER TABLE paper_bot_trades ADD COLUMN IF NOT EXISTS free_at timestamptz`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS paper_bot_trades_at ON paper_bot_trades (at)`);
}

interface SetupRow { id: string; symbol: RoomSymbol; side: number; at: Date; received_at: Date; price: number; stop: number; orh: number | null; orl: number | null; vwap: number | null }
interface PaperRow { id: string; symbol: RoomSymbol; free_at: Date | null; status: string; entered: boolean | null; entry_at: Date | null; exit_at: Date | null; gross_usd: number | null; trade_no: number | null }

const ms = (d: Date | null) => (d ? new Date(d).getTime() : undefined);
const num = (x: number | null) => (x == null ? undefined : Number(x));

async function barsFor(sym: RoomSymbol, cache: Map<RoomSymbol, Bar[]>): Promise<Bar[] | undefined> {
  if (!cache.has(sym)) {
    const raw = await Promise.race([
      getIntradayBars(INSTRUMENTS[sym].yahoo, "1m", "7d"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 15_000)),
    ]).catch(() => []);
    cache.set(sym, raw.filter((b) => b.t > 0 && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0).map((b) => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
  }
  const b = cache.get(sym)!;
  return b.length ? b : undefined;   // empty = Yahoo down: leave the trade open, never "no-data" from an outage
}

/** One pass. `cache` = bars the setup feed already fetched this tick (same shape), reused. Returns messages posted. */
export async function runPaperBotTick(nowMs: number, cache: Map<RoomSymbol, Bar[]> = new Map()): Promise<number> {
  await ensurePaperTable();
  const from = new Date(nowMs - WINDOW_MS), to = new Date(nowMs - 5 * 60_000);
  const setupRows: SetupRow[] = await prisma.$queryRawUnsafe<SetupRow[]>(`SELECT id, symbol, side, at, received_at, price, stop, orh, orl, vwap FROM trading_room_setups WHERE at >= $1 AND at <= $2 ORDER BY at`, from, to);
  if (!setupRows.length) return 0;
  const rows: PaperRow[] = await prisma.$queryRawUnsafe<PaperRow[]>(`SELECT id, symbol, status, entered, entry_at, free_at, exit_at, gross_usd, trade_no FROM paper_bot_trades WHERE at >= $1`, from);
  const settled = new Map<string, Settled>();
  for (const r of rows as PaperRow[]) if (r.status !== "open") settled.set(r.id, { id: r.id, symbol: r.symbol, status: r.status as Settled["status"], entered: r.entered ?? undefined, entryMs: ms(r.entry_at), freeMs: ms(r.free_at), exitMs: ms(r.exit_at), grossUsd: num(r.gross_usd), tradeNo: r.trade_no ?? undefined });
  const setups: Setup[] = setupRows.map((r: SetupRow) => ({ id: r.id, symbol: r.symbol, side: r.side === 1 ? 1 : -1, at: new Date(r.at).toISOString(), price: Number(r.price), stop: Number(r.stop), orh: r.orh, orl: r.orl, vwap: r.vwap }));
  const late = new Set(setupRows.filter((r: SetupRow) => new Date(r.received_at).getTime() - new Date(r.at).getTime() > LATE_MS).map((r: SetupRow) => r.id));
  const need = [...new Set(setups.filter((s) => !settled.has(s.id)).map((s) => s.symbol))];
  if (!need.length) return 0;
  const bars: Partial<Record<RoomSymbol, Bar[]>> = {};
  for (const sym of need) bars[sym] = await barsFor(sym, cache);

  let posted = 0;
  for (const t of runPaperBot(setups, bars, settled, nowMs, late)) {
    if (settled.has(t.id)) continue;
    // 1) record the state (posted flags untouched), 2) CLAIM each announcement in the DB, 3) post only if the claim won.
    // Two overlapping ticks can't both win a claim, so a line is said at most once; a failed Slack post is not retried.
    await prisma.$executeRawUnsafe(
      `INSERT INTO paper_bot_trades (id, symbol, side, at, status, skip, entered, entry_at, contracts, runner, entry, stop, risk_usd, exit_at, how, usd, gross_usd, r, peak_r, trade_no, free_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())
       ON CONFLICT (id) DO UPDATE SET status=$5, skip=$6, entered=$7, entry_at=$8, contracts=$9, runner=$10, entry=$11, stop=$12, risk_usd=$13, exit_at=$14, how=$15, usd=$16, gross_usd=$17, r=$18, peak_r=$19, trade_no=$20, free_at=$21, updated_at = now()`,
      t.id, t.symbol, t.side, new Date(t.at), t.status, t.skip ?? null, t.entered ?? null, t.entryMs ? new Date(t.entryMs) : null,
      t.contracts ?? null, t.runner ?? null, t.entry ?? null, t.stop ?? null, t.riskUsd ?? null, t.exitMs ? new Date(t.exitMs) : null,
      t.how ?? null, t.usd ?? null, t.grossUsd ?? null, t.r ?? null, t.peakR ?? null, t.tradeNo ?? null, t.freeMs ? new Date(t.freeMs) : null);
    const recent = (evMs: number | undefined) => evMs != null && nowMs - evMs <= ANNOUNCE_MS;
    const claim = async (col: "posted_entry" | "posted_final") =>
      (await prisma.$queryRawUnsafe<{ id: string }[]>(`UPDATE paper_bot_trades SET ${col} = true WHERE id = $1 AND NOT ${col} RETURNING id`, t.id)).length > 0;
    if (t.entered && (await claim("posted_entry")) && recent(t.entryMs)) {
      await sendNotification(botEntryText(t), "copilot").catch(() => {}); posted++;
    }
    if (t.status !== "open" && (await claim("posted_final"))) {
      const evMs = t.status === "done" ? t.exitMs : Date.parse(t.at) + 5 * 60_000;
      if (t.status !== "no-data" && recent(evMs)) {
        await sendNotification(t.status === "done" ? botExitText(t) : botSkipText(t), "copilot").catch(() => {}); posted++;
      } else if (t.status === "no-data" && t.entered) {
        await sendNotification(`🤖 PAPER bot · ${t.symbol} trade from ${new Date(t.at).toISOString().slice(0, 16)}Z had no price data to close it — not counted in the P&L`, "copilot").catch(() => {}); posted++;
      }
    }
  }
  return posted;
}

/** The recap line for the trading day of `nowMs`, or null when the bot has no rows yet. */
export async function paperBotRecap(nowMs: number): Promise<string | null> {
  await ensurePaperTable();
  type AllRow = { at: Date; status: string; usd: number | null };
  const all: AllRow[] = await prisma.$queryRawUnsafe<AllRow[]>(`SELECT at, status, usd FROM paper_bot_trades`);
  if (!all.length) return null;
  const key = botDay(nowMs);
  const toRow = (r: { status: string; usd: number | null }): BotDayRow => ({ status: r.status, usd: r.usd == null ? null : Number(r.usd) });
  const today = all.filter((r: AllRow) => botDay(new Date(r.at).getTime() + 5 * 60_000) === key).map(toRow);
  type HisRow = { entry_ts: Date; net_usd: number | null; open: boolean };
  const his: HisRow[] | null = await prisma.$queryRawUnsafe<HisRow[]>(
    `SELECT entry_ts, net_usd, open FROM trading_room_trades WHERE entry_ts >= $1`, new Date(nowMs - 30 * 3_600_000)).catch(() => null);
  const hisToday = his ? his.filter((t: HisRow) => !t.open && botDay(new Date(t.entry_ts).getTime()) === key).reduce((a: number, t: HisRow) => a + Number(t.net_usd ?? 0), 0) : null;
  return botRecapText(today, all.map(toRow), hisToday);
}

export type { PaperTrade };
