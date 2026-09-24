// THE SETUP FEED — I/O. Records each setup the chart posts (raw SQL table, so a schema push can never drop it),
// posts it to #futures-copilot, then — from the room's 5-minute tick — scores it on Yahoo's 1-minute bars once it
// has played out and marks whether Spencer took it (a journal trip, same market and side, entered within 15
// minutes of the setup's close). Once a weekday after the close it posts the day's recap. No order path.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { getIntradayBars } from "@/lib/yahoo";
import { INSTRUMENTS, etDayStartMs, etParts, type Bar, type RoomSymbol } from "@/lib/trading-room-rules";
import { recapText, resolveOutcome, setupText, type ScoredSetup, type Setup } from "@/lib/setup-feed-rules";
import { paperBotRecap, runPaperBotTick } from "@/lib/paper-bot";

const TAKEN_WINDOW_MS = 15 * 60_000;

export async function ensureSetupsTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS trading_room_setups (
    id text PRIMARY KEY, symbol text NOT NULL, side int NOT NULL, at timestamptz NOT NULL, price float8 NOT NULL, stop float8 NOT NULL,
    orh float8, orl float8, vwap float8, received_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'open', r float8, usd float8, how text, exit_at timestamptz,
    taken boolean, his_usd float8, trip_id text)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS trading_room_setups_at ON trading_room_setups (at)`);
}

/** Store and announce. A retry of the same 5-minute bar is a duplicate and says nothing. */
export async function recordSetup(s: Setup): Promise<{ duplicate: boolean }> {
  await ensureSetupsTable();
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO trading_room_setups (id, symbol, side, at, price, stop, orh, orl, vwap) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    s.id, s.symbol, s.side, new Date(s.at), s.price, s.stop, s.orh, s.orl, s.vwap,
  );
  if (!rows.length) return { duplicate: true };
  await sendNotification(setupText(s), "copilot").catch(() => {});
  return { duplicate: false };
}

interface Row { id: string; symbol: RoomSymbol; side: number; at: Date; price: number; stop: number; orh: number | null; orl: number | null; vwap: number | null; status: string; r: number | null; usd: number | null; exit_at: Date | null; taken: boolean | null; his_usd: number | null }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);
}
/** The same-day setups already decided (not in the open list) — for the one-position-at-a-time check. */
async function priorSameDay(s: Setup): Promise<Row[]> {
  return prisma.$queryRawUnsafe<Row[]>(`SELECT * FROM trading_room_setups WHERE symbol = $1 AND at < $2 AND at >= $3 AND status <> 'open'`,
    s.symbol, new Date(s.at), new Date(Date.parse(s.at) - 12 * 3_600_000));
}
const toSetup = (r: Row): Setup => ({ id: r.id, symbol: r.symbol, side: r.side === 1 ? 1 : -1, at: new Date(r.at).toISOString(), price: Number(r.price), stop: Number(r.stop), orh: r.orh, orl: r.orl, vwap: r.vwap });

/** Score open setups (10+ minutes old) and mark the ones he took. Then, once a weekday after the close, the recap. */
export async function resolveSetups(nowMs = Date.now()): Promise<{ resolved: number; recap: boolean; paper: number }> {
  await ensureSetupsTable();
  const open = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT * FROM trading_room_setups WHERE (status = 'open' OR taken IS NULL) AND at >= $1 AND at <= $2 ORDER BY at`,
    new Date(nowMs - 6 * 86_400_000), new Date(nowMs - 10 * 60_000));
  const bars = new Map<RoomSymbol, Bar[]>();
  let resolved = 0;
  for (const r of open) {
    const s = toSetup(r);
    if (r.status === "open") {
      if (!bars.has(s.symbol)) {
        const raw = await withTimeout(getIntradayBars(INSTRUMENTS[s.symbol].yahoo, "1m", "7d"), 15_000).catch(() => []);
        // A bar missing any price is dropped whole (an open of 0 would read as a gap through every stop).
        bars.set(s.symbol, raw.filter((b) => b.t > 0 && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0).map((b) => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
      }
      const b = bars.get(s.symbol)!;
      if (!b.length) continue;   // Yahoo down or empty: score on a later tick, never write "no-data" from an outage
      // One position at a time, as the study: a setup inside an earlier one's still-running bracket is not a new trade.
      const prev = open.concat(await priorSameDay(s)).filter((x) => x.symbol === s.symbol && x.id !== s.id && new Date(x.at).getTime() < Date.parse(s.at));
      const latest = prev.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime())[0];
      if (latest && latest.status === "open") continue;
      if (latest && latest.status === "done" && latest.exit_at && new Date(latest.exit_at).getTime() > Date.parse(s.at) + 5 * 60_000) {
        await prisma.$executeRawUnsafe(`UPDATE trading_room_setups SET status = 'overlap' WHERE id = $1`, s.id);
        resolved++; continue;
      }
      const o = resolveOutcome(s, b, nowMs);
      if (o.status !== "open") {
        await prisma.$executeRawUnsafe(`UPDATE trading_room_setups SET status = $2, r = $3, usd = $4, how = $5, exit_at = $6 WHERE id = $1`,
          s.id, o.status, o.r ?? null, o.usd ?? null, o.how ?? null, o.exitAt ? new Date(o.exitAt) : null);
        resolved++;
        r.status = o.status; r.exit_at = o.exitAt ? new Date(o.exitAt) : null;   // later setups in this pass see it
      }
    }
    if (r.taken == null) {
      // He trades the 1-minute chart, so an entry while the 5-minute trigger bar is still forming counts: from the bar's open.
      const openMs = Date.parse(s.at), closeMs = openMs + 5 * 60_000;
      const trips = await prisma.$queryRawUnsafe<{ id: string; net_usd: number; open: boolean }[]>(
        `SELECT id, net_usd, open FROM trading_room_trades WHERE symbol = $1 AND side = $2 AND entry_ts >= $3 AND entry_ts <= $4 ORDER BY entry_ts LIMIT 1`,
        s.symbol, s.side === 1 ? "long" : "short", new Date(openMs), new Date(closeMs + TAKEN_WINDOW_MS)).catch(() => null);
      if (trips) {
        const t = trips[0];
        // Taken is final once his trip has closed. NOT taken is final only after the session is over (a failed journal
        // fold earlier in the day must not write a permanent "not taken").
        const sessionOver = nowMs >= etDayStartMs(etParts(closeMs).dayKey, INSTRUMENTS[s.symbol].rthClose) + 30 * 60_000;
        if (t && !t.open) await prisma.$executeRawUnsafe(`UPDATE trading_room_setups SET taken = true, his_usd = $2, trip_id = $3 WHERE id = $1`, s.id, Number(t.net_usd), t.id);
        else if (!t && sessionOver) await prisma.$executeRawUnsafe(`UPDATE trading_room_setups SET taken = false WHERE id = $1`, s.id);
      }
    }
  }
  // The paper bot trades the same setups (PAPER ONLY — no order path). Its failure must never stop the scoring above.
  const paper = await runPaperBotTick(nowMs, bars).catch((e) => { console.error("[setup-feed] paper bot", e); return 0; });
  return { resolved, recap: await maybeRecap(nowMs), paper };
}

const RECAP_KEY = "setup_feed_recap_day";
async function maybeRecap(nowMs: number): Promise<boolean> {
  const now = etParts(nowMs);
  // 16:35 ET: after the 16:30 backstop that decides any index bracket Yahoo's lag left open (gold is decided by 14:00).
  if (now.weekday < 1 || now.weekday > 5 || now.hourFrac < 16 + 35 / 60 || now.hourFrac >= 18) return false;
  const done = (await prisma.agentConfig.findUnique({ where: { key: RECAP_KEY } }).catch(() => null))?.value;
  if (done === now.dayKey) return false;
  const rows = await prisma.$queryRawUnsafe<Row[]>(`SELECT * FROM trading_room_setups WHERE at >= $1 ORDER BY at`, new Date(nowMs - 20 * 3_600_000));
  const today: ScoredSetup[] = rows.filter((r) => etParts(new Date(r.at).getTime()).dayKey === now.dayKey)
    .map((r) => ({ symbol: r.symbol, side: r.side === 1 ? 1 : -1, r: r.r == null ? null : Number(r.r), usd: r.usd == null ? null : Number(r.usd), taken: r.taken === true, hisUsd: r.his_usd == null ? null : Number(r.his_usd) }));
  const text = recapText(now.dayKey, today);
  const bot = await paperBotRecap(nowMs).catch(() => null);
  const out = [text, bot].filter(Boolean).join("\n");
  if (out) await sendNotification(out, "copilot").catch(() => {});
  await prisma.agentConfig.upsert({ where: { key: RECAP_KEY }, update: { value: now.dayKey }, create: { key: RECAP_KEY, value: now.dayKey } });
  return !!out;
}
