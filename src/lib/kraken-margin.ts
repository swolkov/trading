// Kraken margin data layer — multi-timeframe OHLC, margin positions/health, and the
// owner's full trade history synced into the DB so his real edge can be measured.
//
// This file READS state and never places orders. The (config-gated, default-off)
// executor lives separately. All private calls go through kraken.ts's signed client;
// keys come only from env and the module is inert without them.
import { prisma } from "@/lib/db";
import { krakenPublic, krakenPrivate, krakenPair } from "@/lib/kraken";

// ---- multi-timeframe OHLC ----
// Kraken's native intervals (minutes). 3m is aggregated from 1m because Kraken has no
// native 3. Each interval returns at most 720 candles and `since` does not page further
// back — a hard API limit, so short intervals only reach hours-to-days of history.
export const KRAKEN_INTERVALS = [1, 3, 5, 15, 30, 60, 240, 1440] as const;
export type KrakenInterval = (typeof KRAKEN_INTERVALS)[number];

export interface KrakenBar { t: number; o: number; h: number; l: number; c: number; v: number }

export async function getKrakenOHLC(symbol: string, interval: KrakenInterval, since?: number): Promise<KrakenBar[]> {
  const pair = krakenPair(symbol);
  const native = interval === 3 ? 1 : interval;
  // `since` (epoch secs, exclusive) trims the response server-side — Kraken otherwise
  // returns up to 720 bars when a caller may only need the last few minutes.
  const res = await krakenPublic("OHLC", { pair, interval: String(native), ...(since ? { since: String(Math.floor(since)) } : {}) });
  const rows = Object.entries(res).find(([k]) => k !== "last")?.[1] as unknown[][] | undefined;
  if (!rows?.length) throw new Error(`Kraken OHLC empty for ${symbol}@${interval}m`);
  const bars: KrakenBar[] = rows.map((r) => ({
    t: Number(r[0]),
    o: parseFloat(r[1] as string),
    h: parseFloat(r[2] as string),
    l: parseFloat(r[3] as string),
    c: parseFloat(r[4] as string),
    v: parseFloat(r[6] as string),
  }));
  if (interval !== 3) return bars;
  // Aggregate 1m → 3m on aligned 180-second buckets.
  const out: KrakenBar[] = [];
  for (const b of bars) {
    const bucket = Math.floor(b.t / 180) * 180;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else {
      out.push({ t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
  }
  return out;
}

// ---- margin account health ----
// TradeBalance is the liquidation math: Kraken margin-calls at margin level 80% and
// force-liquidates at 40%. `ml` is that margin level in percent (equity/margin*100);
// it is 0/absent when no margin is in use.
export interface KrakenMarginHealth {
  equity: number;        // e  — equity (balance + unrealized)
  tradeBalance: number;  // tb — balance available for trading
  marginUsed: number;    // m  — initial margin of open positions (0 when genuinely flat)
  marginUsedRaw: number | null;  // same, but NULL when Kraken omitted the field entirely —
                                 // callers that must distinguish "flat" from "unreadable"
                                 // (stop reconciliation) have to use this one
  freeMargin: number;    // mf — usable margin
  unrealized: number;    // n  — unrealized net P&L of open positions
  marginLevel: number | null; // ml — percent; null when flat
}

export async function getKrakenMarginHealth(): Promise<KrakenMarginHealth> {
  const res = await krakenPrivate("TradeBalance", { asset: "ZUSD" });
  const f = (k: string) => parseFloat((res[k] as string) ?? "0") || 0;
  // A degraded Kraken 200 can return a partial body. Coercing every missing field to 0
  // makes "we could not read your margin" look identical to "you hold nothing" — and the
  // stop reconciler, seeing a flat account, would cancel every stop off a LIVE position.
  // So preserve absence for the one field that decision depends on.
  const mRaw = res.m != null && String(res.m).trim() !== "" ? parseFloat(String(res.m)) : NaN;
  const ml = res.ml != null ? parseFloat(res.ml as string) : NaN;
  return {
    equity: f("e"),
    tradeBalance: f("tb"),
    marginUsed: f("m"),
    marginUsedRaw: Number.isFinite(mRaw) ? mRaw : null,
    freeMargin: f("mf"),
    unrealized: f("n"),
    marginLevel: isFinite(ml) && ml > 0 ? ml : null,
  };
}

// ---- open margin positions ----
export interface KrakenMarginPosition {
  id: string;           // the position/TRADE txid ("T…") — NOT the order txid
  ordertxid: string;    // the OPENING ORDER's txid ("O…") — this is what AddOrder returns,
                        // so it is the only field that can attribute a position to the bot.
                        // One order can fill in several tranches sharing one ordertxid
                        // (verified on the real account: 115 fills from 72 orders, and
                        // ZERO of them had txid === ordertxid).
  pair: string;
  side: "long" | "short";
  vol: number;          // position size in base units (remaining open)
  cost: number;         // opening cost in quote (USD)
  entryPrice: number;   // cost / vol
  fee: number;          // opening fee
  margin: number;       // initial margin posted
  value: number | null; // current value (docalcs)
  net: number | null;   // unrealized P&L (docalcs)
  rolloverAt: string;   // when the next 4-hour rollover fee hits
  openedAt: string;
  leverage: number;     // cost / margin — the position's actual leverage
}

export async function getKrakenMarginPositions(): Promise<KrakenMarginPosition[]> {
  const res = await krakenPrivate("OpenPositions", { docalcs: "true" });
  const out: KrakenMarginPosition[] = [];
  for (const [id, p0] of Object.entries(res)) {
    const p = p0 as Record<string, string | number | undefined>;
    // cost/fee/margin describe the FULL original position; vol_closed is what's been
    // peeled off. Entry price must divide by the ORIGINAL volume — dividing by the
    // remaining volume made a half-closed position show double its entry price.
    const volTotal = parseFloat(String(p.vol ?? "0")) || 0;
    const volOpen = volTotal - (parseFloat(String(p.vol_closed ?? "0")) || 0);
    const cost = parseFloat(String(p.cost ?? "0")) || 0;
    const margin = parseFloat(String(p.margin ?? "0")) || 0;
    if (!(volOpen > 0)) continue;
    // ⚠️ ordertxid is the ONLY field that attributes a position to the bot. If Kraken ever
    // stops returning it, String(undefined ?? "") yields "" — which silently matches
    // nothing, turning every close into a no-op and switching off the naked-position guard,
    // exactly the failure this field was added to fix. Never let that be quiet.
    if (!p.ordertxid) {
      void import("@/lib/notifications").then((n) => n.sendNotification(
        `🚨 Kraken OpenPositions returned a position (${id}, ${String(p.pair ?? "?")}) with NO ordertxid. Bot-position attribution is broken: closes and the naked-stop guard will skip it. Do not arm until this is understood.`,
        "margin_urgent",
      )).catch(() => {});
    }
    out.push({
      id,
      ordertxid: String(p.ordertxid ?? ""),
      pair: String(p.pair ?? ""),
      side: p.type === "sell" ? "short" : "long",
      vol: volOpen,
      cost,
      entryPrice: volTotal > 0 ? cost / volTotal : 0,
      fee: parseFloat(String(p.fee ?? "0")) || 0,
      margin,
      value: p.value != null ? parseFloat(String(p.value)) : null,
      net: p.net != null ? parseFloat(String(p.net)) : null,
      rolloverAt: p.rollovertm ? new Date(Number(p.rollovertm) * 1000).toISOString() : "",
      openedAt: p.time ? new Date(Number(p.time) * 1000).toISOString() : "",
      leverage: margin > 0 ? cost / margin : 1,
    });
  }
  return out;
}

// Liquidation ESTIMATE for one position, from Kraken's documented mechanics: margin
// call at margin level 80%, forced liquidation at 40%. Losing 60% of posted margin ends
// it, so the adverse move is ~0.6/leverage (3% at 20x, 6% at 10x).
//
// ⚠️ This is per-position math. Kraken actually liquidates on the ACCOUNT-level margin
// level, so other positions and spare equity move the real line in either direction.
// The account margin level (TradeBalance.ml) is the authoritative danger number; this
// estimate exists to make the per-position stakes visible and is labeled "est." in UI.
export function liquidationEstimate(pos: KrakenMarginPosition, currentPrice: number): {
  liqPrice: number;
  pctAway: number;   // signed: positive = cushion remaining, negative = past the line
} {
  const adverse = 0.6 / Math.max(1, pos.leverage);
  const liqPrice = pos.side === "long"
    ? pos.entryPrice * (1 - adverse)
    : pos.entryPrice * (1 + adverse);
  const pctAway = pos.side === "long"
    ? (currentPrice - liqPrice) / currentPrice
    : (liqPrice - currentPrice) / currentPrice;
  return { liqPrice, pctAway };
}

// ---- trade history sync (the "was I winning" dataset) ----
// Raw-SQL table, created idempotently at first touch — the same pattern as bars_cache /
// execution_quality. NEVER managed by prisma migrate/db push (which would drop it).
const TRADES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kraken_my_trades (
  txid text PRIMARY KEY,
  ordertxid text,
  pair text NOT NULL,
  time timestamptz NOT NULL,
  type text NOT NULL,
  ordertype text,
  price double precision,
  cost double precision,
  fee double precision,
  vol double precision,
  margin double precision,
  posstatus text DEFAULT '',
  net double precision,
  misc text
)`;

// One table for the margin-relevant ledger rows: 'rollover' (the 4-hourly financing
// charge) and 'margin' (Kraken's own canonical P&L/fee postings on position closes).
const LEDGER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kraken_my_ledger (
  id text PRIMARY KEY,
  refid text,
  time timestamptz NOT NULL,
  ltype text,
  asset text,
  amount double precision,
  fee double precision
)`;

export async function ensureMarginTables(): Promise<void> {
  await prisma.$executeRawUnsafe(TRADES_TABLE_SQL);
  await prisma.$executeRawUnsafe(LEDGER_TABLE_SQL);
}

// Kraken's private-API rate limiter: ~15-20 counter points, TradesHistory/Ledgers cost
// 2 each, decay ~0.5/s. A full backfill must pace itself or it 500s after ~8 pages.
const PAGE_DELAY_MS = 1200;
async function pagedPrivate(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  try {
    return await krakenPrivate(method, params);
  } catch (e) {
    if (String(e).includes("Rate limit")) {
      await new Promise((r) => setTimeout(r, 6000));
      return await krakenPrivate(method, params);
    }
    throw e;
  }
}

// Pull the COMPLETE trade history (newest first, 50/page) and upsert. Idempotent: txid
// is the primary key, so re-running is safe. `full=false` stops at the first page whose
// trades are all already stored — the cheap incremental mode for the 5-minute cron.
export async function syncKrakenTrades(full: boolean): Promise<{ fetched: number; total: number }> {
  await ensureMarginTables();
  let fetched = 0;
  for (let ofs = 0; ofs < 10000; ofs += 50) {
    if (ofs > 0) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    const res = await pagedPrivate("TradesHistory", { ofs: String(ofs) });
    const trades = (res.trades ?? {}) as Record<string, Record<string, unknown>>;
    const entries = Object.entries(trades);
    if (!entries.length) break;

    let newInPage = 0;
    for (const [txid, t] of entries) {
      const inserted = await prisma.$executeRawUnsafe(
        `INSERT INTO kraken_my_trades (txid, ordertxid, pair, time, type, ordertype, price, cost, fee, vol, margin, posstatus, net, misc)
         VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (txid) DO NOTHING`,
        txid,
        String(t.ordertxid ?? ""),
        String(t.pair ?? ""),
        Number(t.time ?? 0),
        String(t.type ?? ""),
        String(t.ordertype ?? ""),
        parseFloat(String(t.price ?? "0")) || 0,
        parseFloat(String(t.cost ?? "0")) || 0,
        parseFloat(String(t.fee ?? "0")) || 0,
        parseFloat(String(t.vol ?? "0")) || 0,
        parseFloat(String(t.margin ?? "0")) || 0,
        // Present on position-closing fills; the tell that a fill belongs to the
        // margin book even when `margin` is 0 on the close.
        String(t.posstatus ?? ""),
        t.net != null ? parseFloat(String(t.net)) || 0 : null,
        String(t.misc ?? ""),
      );
      newInPage += Number(inserted) || 0;
    }
    fetched += entries.length;

    const count = Number(res.count ?? 0);
    if (ofs + 50 >= count) break;
    if (!full && newInPage === 0) break;   // incremental: everything past here is already stored
  }

  // Rollover (financing) and margin (Kraken's canonical close P&L) ledger rows.
  for (const ltype of ["rollover", "margin"]) {
    for (let ofs = 0; ofs < 10000; ofs += 50) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      const res = await pagedPrivate("Ledgers", { type: ltype, ofs: String(ofs) });
      const ledger = (res.ledger ?? {}) as Record<string, Record<string, unknown>>;
      const entries = Object.entries(ledger);
      if (!entries.length) break;
      let newInPage = 0;
      for (const [id, e] of entries) {
        const inserted = await prisma.$executeRawUnsafe(
          `INSERT INTO kraken_my_ledger (id, refid, time, ltype, asset, amount, fee)
           VALUES ($1,$2,to_timestamp($3),$4,$5,$6,$7)
           ON CONFLICT (id) DO NOTHING`,
          id,
          String(e.refid ?? ""),
          Number(e.time ?? 0),
          ltype,
          String(e.asset ?? ""),
          parseFloat(String(e.amount ?? "0")) || 0,
          Math.abs(parseFloat(String(e.fee ?? "0")) || 0),
        );
        newInPage += Number(inserted) || 0;
      }
      const count = Number(res.count ?? 0);
      if (ofs + 50 >= count) break;
      if (!full && newInPage === 0) break;
    }
  }

  const [{ total }] = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT count(*)::bigint AS total FROM kraken_my_trades`,
  );
  return { fetched, total: Number(total) };
}

// ---- round-trip reconstruction + scoreboard ----
// MARGIN trades only (margin > 0): the bot never uses margin and Spencer's meme spot
// buys never do either, so margin>0 isolates exactly his discretionary margin book.
// Round trips are rebuilt per pair from the signed position: entries extend it at a
// volume-weighted average price; any reduction realizes P&L against that average.
export interface RoundTrip {
  pair: string;
  side: "long" | "short";
  openedAt: string;
  closedAt: string;
  holdMinutes: number;
  entryPrice: number;
  exitPrice: number;
  volume: number;       // base units closed
  grossPnl: number;
  fees: number;         // entry+exit trade fees allocated to this round trip
  netPnl: number;       // gross − fees (rollover reported separately, account-level)
}

export interface MarginScoreboard {
  trades: number;              // completed round trips
  wins: number;
  hitRate: number | null;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  totalNetPnl: number;
  totalFees: number;
  totalRollover: number;       // account-level financing paid (from the ledger)
  pnlAfterRollover: number;
  expectancy: number | null;   // net P&L per round trip, after allocating rollover
  byPair: Record<string, { trades: number; wins: number; netPnl: number }>;
  byHold: Record<string, { trades: number; wins: number; netPnl: number }>;
  openPositions: number;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  gate: { target: number; required: number; progress: string };
}

interface DbTradeRow {
  txid: string; pair: string; time: Date; type: string; price: number; cost: number;
  fee: number; vol: number; margin: number;
}

function holdBucket(minutes: number): string {
  if (minutes < 60) return "minutes";
  if (minutes < 24 * 60) return "hours";
  if (minutes < 7 * 24 * 60) return "days";
  return "weeks+";
}

// Rebuild round trips from raw fills using FIFO LOTS — Kraken closes margin positions
// first-in-first-out, so an average-cost book would report different per-trip P&L than
// the exchange did (total P&L over a flat-to-flat cycle matches either way, but the
// per-trip hit rate feeding the automation gate would be wrong). Shared by the
// scoreboard and the analysis script so the two can never disagree.
interface Lot { vol: number; price: number; fee: number; openedAt: Date }

function reconstructTrips(rows: DbTradeRow[]): { trips: RoundTrip[]; openPositions: number } {
  const trips: RoundTrip[] = [];
  // Per-pair FIFO queue of open lots. dir: +1 = long lots, -1 = short lots.
  const book = new Map<string, { dir: 1 | -1; lots: Lot[] }>();

  for (const r of rows) {
    const dir: 1 | -1 = r.type === "buy" ? 1 : -1;
    let remaining = r.vol;
    let feeRemaining = r.fee;
    let st = book.get(r.pair);

    // Reduce opposite-direction lots FIFO, realizing one trip per lot consumed.
    if (st && st.lots.length && st.dir !== dir) {
      while (remaining > 1e-12 && st.lots.length) {
        const lot = st.lots[0];
        const closeVol = Math.min(lot.vol, remaining);
        const side: "long" | "short" = st.dir > 0 ? "long" : "short";
        const gross = side === "long"
          ? (r.price - lot.price) * closeVol
          : (lot.price - r.price) * closeVol;
        const entryFeeShare = lot.fee * (closeVol / lot.vol);
        const exitFeeShare = r.vol > 0 ? feeRemaining * (closeVol / r.vol) : 0;
        trips.push({
          pair: r.pair,
          side,
          openedAt: lot.openedAt.toISOString(),
          closedAt: r.time.toISOString(),
          holdMinutes: (r.time.getTime() - lot.openedAt.getTime()) / 60000,
          entryPrice: lot.price,
          exitPrice: r.price,
          volume: closeVol,
          grossPnl: gross,
          fees: entryFeeShare + exitFeeShare,
          netPnl: gross - entryFeeShare - exitFeeShare,
        });
        lot.vol -= closeVol;
        lot.fee -= entryFeeShare;
        feeRemaining -= exitFeeShare;
        remaining -= closeVol;
        if (lot.vol <= 1e-12) st.lots.shift();
      }
      if (!st.lots.length) st = undefined;
    }

    // Whatever volume is left opens/extends a position in this trade's direction.
    if (remaining > 1e-12) {
      if (!st || st.dir !== dir) {
        st = { dir, lots: [] };
      }
      st.lots.push({ vol: remaining, price: r.price, fee: feeRemaining, openedAt: r.time });
    }
    if (st) book.set(r.pair, st); else book.delete(r.pair);
  }
  const openPositions = [...book.values()].filter((s) => s.lots.length > 0).length;
  return { trips, openPositions };
}

async function loadMarginFills(): Promise<DbTradeRow[]> {
  await ensureMarginTables();
  // Margin-book membership: opening fills post `margin` > 0; CLOSING fills post
  // margin 0 but carry `posstatus` — filtering on margin alone would drop every exit
  // and fabricate trips out of unrelated entries.
  return prisma.$queryRawUnsafe<DbTradeRow[]>(
    `SELECT txid, pair, time, type, price, cost, fee, vol, margin
     FROM kraken_my_trades
     WHERE margin > 0 OR COALESCE(posstatus, '') <> ''
     ORDER BY time ASC`,
  );
}

export async function computeMarginScoreboard(): Promise<MarginScoreboard> {
  const rows = await loadMarginFills();
  // Rollover total: USD-denominated fee postings only — a fee charged in another asset
  // must not be summed as if it were dollars.
  const [{ rollover }] = await prisma.$queryRawUnsafe<{ rollover: number | null }[]>(
    `SELECT COALESCE(sum(fee), 0)::float AS rollover FROM kraken_my_ledger
     WHERE ltype = 'rollover' AND asset IN ('ZUSD', 'USD')`,
  );
  const { trips, openPositions } = reconstructTrips(rows);

  // A scratch (|net| < 1 cent) is neither a win nor a loss — counting scratches as
  // losses would drag the hit rate that gates automation.
  const wins = trips.filter((t) => t.netPnl > 0.01);
  const losses = trips.filter((t) => t.netPnl < -0.01);
  const decided = wins.length + losses.length;
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const totalNetPnl = trips.reduce((s, t) => s + t.netPnl, 0);
  const totalRollover = rollover || 0;

  const byPair: MarginScoreboard["byPair"] = {};
  const byHold: MarginScoreboard["byHold"] = {};
  for (const t of trips) {
    const p = (byPair[t.pair] ??= { trades: 0, wins: 0, netPnl: 0 });
    p.trades++; if (t.netPnl > 0) p.wins++; p.netPnl += t.netPnl;
    const h = (byHold[holdBucket(t.holdMinutes)] ??= { trades: 0, wins: 0, netPnl: 0 });
    h.trades++; if (t.netPnl > 0) h.wins++; h.netPnl += t.netPnl;
  }

  const GATE_TRADES = 100;
  const GATE_HITRATE = 0.6;

  return {
    trades: trips.length,
    wins: wins.length,
    hitRate: decided > 0 ? wins.length / decided : null,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    totalNetPnl,
    totalFees: trips.reduce((s, t) => s + t.fees, 0),
    totalRollover,
    pnlAfterRollover: totalNetPnl - totalRollover,
    expectancy: trips.length > 0 ? (totalNetPnl - totalRollover) / trips.length : null,
    byPair,
    byHold,
    openPositions,
    firstTradeAt: trips[0]?.openedAt ?? null,
    lastTradeAt: trips[trips.length - 1]?.closedAt ?? null,
    gate: {
      target: GATE_TRADES,
      required: GATE_HITRATE,
      progress: `${trips.length}/${GATE_TRADES} round trips at ${decided > 0 ? ((wins.length / decided) * 100).toFixed(0) : "—"}% (needs ≥${GATE_HITRATE * 100}%)`,
    },
  };
}

// All round trips, for the analysis script and the cockpit's trade list.
export async function listRoundTrips(): Promise<RoundTrip[]> {
  const rows = await loadMarginFills();
  return reconstructTrips(rows).trips;
}
