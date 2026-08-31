/**
 * TRAILING-STOP OVERLAY — Spencer's exact instinct ("increase stop loss to take profit
 * when they're up"): once a trade is up `act`%, the stop trails `trail`% behind the
 * best price reached, locking profit as it runs. Applied to his REAL 28 entries.
 * Conservative hourly simulation: within each bar the stop is checked against the
 * adverse extreme BEFORE the peak updates from the favorable extreme (understates
 * profit — the right bias). Entry maker 0.085%, exits taker 0.18% + 0.05% slip.
 * 28 trades + a 9-rule grid = diagnostic, not proof; best-of-grid is flattered.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { publicPairFor } from "../src/lib/kraken-pairs";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
const MAKER = 0.00085, TAKER = 0.0018, SLIP = 0.0005, ROLL = 0.0002, INIT_STOP = 0.01;

interface Bar { t: number; h: number; l: number; c: number }
const cache = new Map<string, Bar[]>();
async function hourly(pair: string): Promise<Bar[]> {
  const pub = publicPairFor(pair);
  if (cache.has(pub)) return cache.get(pub)!;
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pub}&interval=60`);
  const d = await r.json();
  const rows = Object.entries(d.result ?? {}).find(([k]) => k !== "last")?.[1] as unknown[][] ?? [];
  const bars = rows.map((x) => ({ t: Number(x[0]) * 1000, h: +String(x[2]), l: +String(x[3]), c: +String(x[4]) }));
  cache.set(pub, bars);
  return bars;
}

async function main() {
  const entries = await prisma.$queryRawUnsafe<{ pair: string; time: Date; type: string; price: number; vol: number }[]>(
    `SELECT pair, time, type, price, vol FROM kraken_my_trades
     WHERE margin > 0 AND misc NOT LIKE '%closing%' AND time > now() - interval '9 days' AND price * vol > 500
     ORDER BY time ASC`,
  );
  console.log(`entries: ${entries.length} (his actual week: −$111 gross / −$3,088 after all costs)`);
  console.log("activate% / trail% / maxHold → avg/trade  win%  total$ on his sizes");

  for (const [act, trail, maxH] of [[0.003, 0.003, 24], [0.005, 0.005, 24], [0.005, 0.003, 24], [0.01, 0.005, 24], [0.01, 0.01, 48], [0.005, 0.005, 12], [0.003, 0.005, 12], [0.01, 0.003, 12], [0.005, 0.01, 48]] as [number, number, number][]) {
    let dollars = 0, sum = 0, n = 0, wins = 0;
    for (const e of entries) {
      const bars = (await hourly(e.pair)).filter((b) => b.t > e.time.getTime());
      if (bars.length < 2) continue;
      const dir = e.type === "buy" ? 1 : -1;
      let peak = e.price;
      let ret: number | null = null, held = 0;
      for (let k = 0; k < Math.min(bars.length, maxH); k++) {
        const b = bars[k];
        held = k + 1;
        const activated = dir * (peak - e.price) / e.price >= act;
        const stopPx = activated ? peak * (1 - dir * trail) : e.price * (1 - dir * INIT_STOP);
        const breached = dir > 0 ? b.l <= stopPx : b.h >= stopPx;
        if (breached) { ret = dir * (stopPx * (1 - dir * SLIP) - e.price) / e.price - MAKER - TAKER; break; }
        peak = dir > 0 ? Math.max(peak, b.h) : Math.min(peak, b.l);
      }
      if (ret == null) {
        const b = bars[Math.min(bars.length, maxH) - 1];
        ret = dir * (b.c - e.price) / e.price - MAKER - TAKER;
      }
      ret -= Math.ceil(held / 4) * ROLL;
      sum += ret; dollars += ret * e.price * e.vol; n++; if (ret > 0) wins++;
    }
    console.log(`act${(act * 100).toFixed(1)} trail${(trail * 100).toFixed(1)} ${String(maxH).padStart(2)}h   ${((sum / n) * 100).toFixed(3).padStart(7)}%  ${((wins / n) * 100).toFixed(0).padStart(3)}%  ${("$" + dollars.toFixed(0)).padStart(8)}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
