/**
 * SPENCER'S WEEKEND, RECONSTRUCTED — his claim: "I made thousands this weekend off ETH
 * getting in at the low/high." Tests: (1) day-by-day realized P&L from Kraken's own
 * ledger postings, (2) per-trip MAX FAVORABLE EXCURSION — how far each trade was UP
 * before it closed (was he right and gave it back?), (3) ENTRY ALPHA — forward return
 * of every entry at +4h/+12h/+24h, isolating his chart-reading from his exits.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pairBase, publicPairFor } from "../src/lib/kraken-pairs";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);

interface Row { txid: string; pair: string; time: Date; type: string; price: number; cost: number; fee: number; vol: number; margin: number; misc: string }
interface Bar { t: number; h: number; l: number; c: number }

const barsCache = new Map<string, Bar[]>();
async function hourly(pair: string): Promise<Bar[]> {
  const pub = publicPairFor(pair);
  if (barsCache.has(pub)) return barsCache.get(pub)!;
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pub}&interval=60`);
  const d = await r.json();
  const rows = Object.entries(d.result ?? {}).find(([k]) => k !== "last")?.[1] as unknown[][] ?? [];
  const bars = rows.map((x) => ({ t: Number(x[0]) * 1000, h: +String(x[2]), l: +String(x[3]), c: +String(x[4]) }));
  barsCache.set(pub, bars);
  return bars;
}

async function main() {
  // 1) Day-by-day from Kraken's OWN ledger postings (authoritative).
  const daily = await prisma.$queryRawUnsafe<{ day: string; gross: number; fees: number; n: number }[]>(
    `SELECT to_char(time AT TIME ZONE 'America/New_York', 'Dy MM-DD') AS day,
            sum(amount)::float AS gross, sum(fee)::float AS fees, count(*)::int AS n
     FROM kraken_my_ledger WHERE ltype='margin' AND time > now() - interval '9 days'
     GROUP BY 1 ORDER BY min(time)`,
  );
  console.log("DAY-BY-DAY (Kraken's own margin postings, ET days):");
  console.log("day        closes   direction P&L   fees paid     net");
  for (const d of daily) {
    console.log(`${d.day}   ${String(d.n).padStart(4)}   ${("$" + d.gross.toFixed(0)).padStart(10)}   ${("$" + d.fees.toFixed(0)).padStart(8)}   ${("$" + (d.gross - d.fees).toFixed(0)).padStart(8)}`);
  }

  // 2) Round trips (FIFO) with MFE — was he UP before the close?
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT txid, pair, time, type, price, cost, fee, vol, margin, misc FROM kraken_my_trades
     WHERE (margin > 0 OR COALESCE(posstatus,'') <> '' OR misc LIKE '%closing%') AND time > now() - interval '9 days'
     ORDER BY time ASC`,
  );
  interface Lot { vol: number; price: number; openedAt: Date }
  const book = new Map<string, { dir: 1 | -1; lots: Lot[] }>();
  const trips: { pair: string; side: string; openedAt: Date; closedAt: Date; entry: number; exit: number; vol: number; gross: number }[] = [];
  for (const r of rows) {
    const dir: 1 | -1 = r.type === "buy" ? 1 : -1;
    let rem = r.vol;
    let st = book.get(r.pair);
    if (st && st.lots.length && st.dir !== dir) {
      while (rem > 1e-12 && st.lots.length) {
        const lot = st.lots[0];
        const cv = Math.min(lot.vol, rem);
        const gross = (st.dir > 0 ? r.price - lot.price : lot.price - r.price) * cv;
        trips.push({ pair: r.pair, side: st.dir > 0 ? "long" : "short", openedAt: lot.openedAt, closedAt: r.time, entry: lot.price, exit: r.price, vol: cv, gross });
        lot.vol -= cv; rem -= cv;
        if (lot.vol <= 1e-12) st.lots.shift();
      }
      if (!st.lots.length) st = undefined;
    }
    if (rem > 1e-12) { if (!st || st.dir !== dir) st = { dir, lots: [] }; st.lots.push({ vol: rem, price: r.price, openedAt: r.time }); }
    if (st) book.set(r.pair, st); else book.delete(r.pair);
  }

  console.log("\nEVERY ROUND TRIP (last 9 days) with how far it was UP before closing:");
  console.log("closed(ET)        pair          side  size$      peak-up$   closed$");
  let totGross = 0, totPeak = 0;
  for (const t of trips.sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime())) {
    const bars = await hourly(t.pair);
    const inWindow = bars.filter((b) => b.t >= t.openedAt.getTime() - 3600_000 && b.t <= t.closedAt.getTime() + 3600_000);
    const peakPx = t.side === "long" ? Math.max(...inWindow.map((b) => b.h), t.entry) : Math.min(...inWindow.map((b) => b.l), t.entry);
    const mfe = (t.side === "long" ? peakPx - t.entry : t.entry - peakPx) * t.vol;
    totGross += t.gross; totPeak += Math.max(0, mfe);
    const notional = t.entry * t.vol;
    console.log(`${t.closedAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).padEnd(17)} ${t.pair.padEnd(13)} ${t.side.padEnd(5)} ${("$" + notional.toFixed(0)).padStart(8)} ${("+$" + Math.max(0, mfe).toFixed(0)).padStart(9)} ${("$" + t.gross.toFixed(0)).padStart(9)}`);
  }
  console.log(`TOTALS: peak paper profit across trips +$${totPeak.toFixed(0)} → actually closed $${totGross.toFixed(0)} (fees not yet subtracted)`);

  // 3) ENTRY ALPHA — forward return after each entry fill, before any exit decision.
  console.log("\nENTRY ALPHA (his chart-reading isolated — forward move after each ENTRY, gross, direction-signed):");
  const horizons = [4, 12, 24];
  const entries = rows.filter((r) => r.margin > 0 && !r.misc.includes("closing"));
  for (const hzn of horizons) {
    let sum = 0, n = 0, wins = 0;
    for (const e of entries) {
      const bars = await hourly(e.pair);
      const t0 = e.time.getTime();
      const after = bars.find((b) => b.t >= t0 + hzn * 3600_000);
      if (!after) continue;
      const dir = e.type === "buy" ? 1 : -1;
      const ret = dir * (after.c - e.price) / e.price;
      sum += ret; n++; if (ret > 0) wins++;
    }
    if (n) console.log(`  +${String(hzn).padStart(2)}h: avg ${(100 * sum / n).toFixed(3)}%/entry, ${((wins / n) * 100).toFixed(0)}% positive, n=${n}  ${Math.abs(sum / n) < 0.0017 ? "(within the fee bar — noise)" : sum / n > 0 ? "(REAL positive drift — entries have information)" : "(negative — entries fade)"}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
