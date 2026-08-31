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

export async function getKrakenOHLC(symbol: string, interval: KrakenInterval): Promise<KrakenBar[]> {
  const pair = krakenPair(symbol);
  const native = interval === 3 ? 1 : interval;
  const res = await krakenPublic("OHLC", { pair, interval: String(native) });
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
  marginUsed: number;    // m  — initial margin of open positions
  freeMargin: number;    // mf — usable margin
  unrealized: number;    // n  — unrealized net P&L of open positions
  marginLevel: number | null; // ml — percent; null when flat
}

export async function getKrakenMarginHealth(): Promise<KrakenMarginHealth> {
  const res = await krakenPrivate("TradeBalance", { asset: "ZUSD" });
  const f = (k: string) => parseFloat((res[k] as string) ?? "0") || 0;
  const ml = res.ml != null ? parseFloat(res.ml as string) : NaN;
  return {
    equity: f("e"),
    tradeBalance: f("tb"),
    marginUsed: f("m"),
    freeMargin: f("mf"),
    unrealized: f("n"),
    marginLevel: isFinite(ml) && ml > 0 ? ml : null,
  };
}

// ---- open margin positions ----
export interface KrakenMarginPosition {
  id: string;
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
    const vol = parseFloat(String(p.vol ?? "0")) - parseFloat(String(p.vol_closed ?? "0"));
    const cost = parseFloat(String(p.cost ?? "0")) || 0;
    const margin = parseFloat(String(p.margin ?? "0")) || 0;
    if (!(vol > 0)) continue;
    out.push({
      id,
      pair: String(p.pair ?? ""),
      side: p.type === "sell" ? "short" : "long",
      vol,
      cost,
      entryPrice: vol > 0 ? cost / vol : 0,
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

// Liquidation math for one position, from Kraken's documented mechanics: margin call at
// margin level 80%, forced liquidation at 40%. Losing 60% of posted margin ends it, so
// the adverse move that kills a position is 0.6/leverage (3% at 20x, 6% at 10x).
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
  misc text
)`;

const ROLLOVER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kraken_my_rollovers (
  id text PRIMARY KEY,
  refid text,
  time timestamptz NOT NULL,
  fee double precision
)`;

export async function ensureMarginTables(): Promise<void> {
  await prisma.$executeRawUnsafe(TRADES_TABLE_SQL);
  await prisma.$executeRawUnsafe(ROLLOVER_TABLE_SQL);
}

interface RawTrade {
  txid: string; ordertxid: string; pair: string; time: number; type: string; ordertype: string;
  price: number; cost: number; fee: number; vol: number; margin: number; misc: string;
}

// Pull the COMPLETE trade history (newest first, 50/page) and upsert. Idempotent: txid
// is the primary key, so re-running is safe. `full=false` stops at the first page whose
// trades are all already stored — the cheap incremental mode for the 5-minute cron.
export async function syncKrakenTrades(full: boolean): Promise<{ fetched: number; total: number }> {
  await ensureMarginTables();
  let fetched = 0;
  for (let ofs = 0; ofs < 10000; ofs += 50) {
    const res = await krakenPrivate("TradesHistory", { ofs: String(ofs) });
    const trades = (res.trades ?? {}) as Record<string, Record<string, unknown>>;
    const entries = Object.entries(trades);
    if (!entries.length) break;

    let newInPage = 0;
    for (const [txid, t] of entries) {
      const inserted = await prisma.$executeRawUnsafe(
        `INSERT INTO kraken_my_trades (txid, ordertxid, pair, time, type, ordertype, price, cost, fee, vol, margin, misc)
         VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10,$11,$12)
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
        String(t.misc ?? ""),
      );
      newInPage += Number(inserted) || 0;
    }
    fetched += entries.length;

    const count = Number(res.count ?? 0);
    if (ofs + 50 >= count) break;
    if (!full && newInPage === 0) break;   // incremental: everything past here is already stored
  }

  // Rollover fees live in the Ledgers, not TradesHistory. They are the 4-hourly financing
  // charge on margin positions — without them expectancy is overstated.
  for (let ofs = 0; ofs < 10000; ofs += 50) {
    const res = await krakenPrivate("Ledgers", { type: "rollover", ofs: String(ofs) });
    const ledger = (res.ledger ?? {}) as Record<string, Record<string, unknown>>;
    const entries = Object.entries(ledger);
    if (!entries.length) break;
    let newInPage = 0;
    for (const [id, e] of entries) {
      const inserted = await prisma.$executeRawUnsafe(
        `INSERT INTO kraken_my_rollovers (id, refid, time, fee)
         VALUES ($1,$2,to_timestamp($3),$4)
         ON CONFLICT (id) DO NOTHING`,
        id,
        String(e.refid ?? ""),
        Number(e.time ?? 0),
        Math.abs(parseFloat(String(e.fee ?? "0")) || 0),
      );
      newInPage += Number(inserted) || 0;
    }
    const count = Number(res.count ?? 0);
    if (ofs + 50 >= count) break;
    if (!full && newInPage === 0) break;
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

// Rebuild round trips from raw fills. Shared by the scoreboard and the analysis
// script so the two can never disagree about what a "trade" was.
function reconstructTrips(rows: DbTradeRow[]): { trips: RoundTrip[]; openPositions: number } {
  const trips: RoundTrip[] = [];
  // Per-pair open position state. signedVol > 0 = long, < 0 = short.
  const book = new Map<string, { signedVol: number; avgPrice: number; feePool: number; openedAt: Date }>();

  for (const r of rows) {
    const dir = r.type === "buy" ? 1 : -1;
    let remaining = r.vol;
    let feeRemaining = r.fee;
    const st = book.get(r.pair) ?? { signedVol: 0, avgPrice: 0, feePool: 0, openedAt: r.time };

    // If this trade reduces an opposite-direction position, realize P&L first.
    if (st.signedVol !== 0 && Math.sign(st.signedVol) !== dir) {
      const closeVol = Math.min(Math.abs(st.signedVol), remaining);
      const side: "long" | "short" = st.signedVol > 0 ? "long" : "short";
      const gross = side === "long"
        ? (r.price - st.avgPrice) * closeVol
        : (st.avgPrice - r.price) * closeVol;
      // Allocate entry fees pro-rata and this trade's fee pro-rata to the closed portion.
      const entryFeeShare = st.feePool * (closeVol / Math.abs(st.signedVol));
      const exitFeeShare = r.vol > 0 ? feeRemaining * (closeVol / r.vol) : 0;
      const fees = entryFeeShare + exitFeeShare;
      trips.push({
        pair: r.pair,
        side,
        openedAt: st.openedAt.toISOString(),
        closedAt: r.time.toISOString(),
        holdMinutes: (r.time.getTime() - st.openedAt.getTime()) / 60000,
        entryPrice: st.avgPrice,
        exitPrice: r.price,
        volume: closeVol,
        grossPnl: gross,
        fees,
        netPnl: gross - fees,
      });
      st.feePool -= entryFeeShare;
      feeRemaining -= exitFeeShare;
      st.signedVol += dir * closeVol;
      remaining -= closeVol;
      if (Math.abs(st.signedVol) < 1e-12) { st.signedVol = 0; st.avgPrice = 0; st.feePool = 0; }
    }

    // Whatever volume is left opens/extends a position in this trade's direction.
    if (remaining > 1e-12) {
      if (st.signedVol === 0) {
        st.avgPrice = r.price;
        st.signedVol = dir * remaining;
        st.feePool = feeRemaining;
        st.openedAt = r.time;
      } else {
        const prevAbs = Math.abs(st.signedVol);
        st.avgPrice = (st.avgPrice * prevAbs + r.price * remaining) / (prevAbs + remaining);
        st.signedVol += dir * remaining;
        st.feePool += feeRemaining;
      }
    }
    book.set(r.pair, st);
  }
  const openPositions = [...book.values()].filter((s) => s.signedVol !== 0).length;
  return { trips, openPositions };
}

async function loadMarginFills(): Promise<DbTradeRow[]> {
  await ensureMarginTables();
  return prisma.$queryRawUnsafe<DbTradeRow[]>(
    `SELECT txid, pair, time, type, price, cost, fee, vol, margin
     FROM kraken_my_trades WHERE margin > 0 ORDER BY time ASC`,
  );
}

export async function computeMarginScoreboard(): Promise<MarginScoreboard> {
  const rows = await loadMarginFills();
  const [{ rollover }] = await prisma.$queryRawUnsafe<{ rollover: number | null }[]>(
    `SELECT COALESCE(sum(fee), 0)::float AS rollover FROM kraken_my_rollovers`,
  );
  const { trips, openPositions } = reconstructTrips(rows);

  const wins = trips.filter((t) => t.netPnl > 0);
  const losses = trips.filter((t) => t.netPnl <= 0);
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
    hitRate: trips.length > 0 ? wins.length / trips.length : null,
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
      progress: `${trips.length}/${GATE_TRADES} round trips at ${trips.length > 0 ? ((wins.length / trips.length) * 100).toFixed(0) : "—"}% (needs ≥${GATE_HITRATE * 100}%)`,
    },
  };
}

// All round trips, for the analysis script and the cockpit's trade list.
export async function listRoundTrips(): Promise<RoundTrip[]> {
  const rows = await loadMarginFills();
  return reconstructTrips(rows).trips;
}
