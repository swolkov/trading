/**
 * EXIT-DISCIPLINE OVERLAY — take Spencer's REAL entries (his chart/volume reading,
 * untouched) and replace only the exits with mechanical rules: take-profit limit,
 * stop, time stop. If his entries + machine exits are net positive, THAT is the
 * hybrid edge worth automating. 38 entries = diagnostic, not proof — say so.
 * Fills: hourly bars strictly AFTER the entry's hour; stop-first on conflict; no
 * same-bar TP look-ahead. TP maker 0.085%, stop/time taker 0.18% + 0.05% slip.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { publicPairFor } from "../src/lib/kraken-pairs";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
const MAKER = 0.00085, TAKER = 0.0018, SLIP = 0.0005, ROLL = 0.0002;

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
  console.log(`his real entries (>${500} notional): ${entries.length}`);
  console.log("\nTP%/stop%/timestop → what HIS entries would have netted (gross-of-notional avg and $ on his sizes):");
  console.log("rule                     avg/trade   win%   total$   (his actual: −$111 gross, −$3,088 net)");

  for (const [tp, stop, maxH] of [[0.005, 0.01, 6], [0.01, 0.01, 12], [0.01, 0.02, 12], [0.02, 0.02, 24], [0.015, 0.01, 8], [0.005, 0.005, 4]] as [number, number, number][]) {
    let sum = 0, dollars = 0, n = 0, wins = 0;
    for (const e of entries) {
      const bars = (await hourly(e.pair)).filter((b) => b.t > e.time.getTime());
      if (bars.length < 2) continue;
      const dir = e.type === "buy" ? 1 : -1;
      const tpPx = e.price * (1 + dir * tp), stopPx = e.price * (1 - dir * stop);
      let ret: number | null = null, held = 0;
      for (let k = 0; k < Math.min(bars.length, maxH); k++) {
        const b = bars[k];
        held = k + 1;
        const stopHit = dir > 0 ? b.l <= stopPx : b.h >= stopPx;
        const tpHit = dir > 0 ? b.h >= tpPx : b.l <= tpPx;
        if (stopHit) { ret = dir * (stopPx * (1 - dir * SLIP) - e.price) / e.price - MAKER - TAKER; break; }
        if (tpHit && k > 0) { ret = dir * (tpPx - e.price) / e.price - 2 * MAKER; break; }
      }
      if (ret == null) {
        const b = bars[Math.min(bars.length, maxH) - 1];
        ret = dir * (b.c - e.price) / e.price - MAKER - TAKER;
      }
      ret -= Math.ceil(held / 4) * ROLL;
      sum += ret; dollars += ret * e.price * e.vol; n++; if (ret > 0) wins++;
    }
    console.log(`tp${(tp * 100).toFixed(1)}/stop${(stop * 100).toFixed(1)}/${String(maxH).padStart(2)}h        ${((sum / n) * 100).toFixed(3).padStart(7)}%   ${((wins / n) * 100).toFixed(0).padStart(3)}%   ${("$" + dollars.toFixed(0)).padStart(7)}`);
  }
  console.log("\n⚠️ 38 entries over 9 days — diagnostic, NOT statistical proof. If a rule helps here, it gets tracked live before it gets money.");
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
