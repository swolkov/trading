/**
 * THE $30K/MONTH TEST — run on Spencer's OWN margin trades, not a synthetic strategy.
 *
 * Reads the synced trade history from the prod DB (populate it first: the margin-watch
 * cron backfills automatically after deploy), reconstructs round trips, measures his
 * real per-trade edge, then projects monthly P&L and ruin probability at each leverage
 * tier using Kraken's actual mechanics (fees on notional, ~0.02%/4h rollover, margin
 * call 80% / liquidation at 40% = losing 60% of posted margin).
 *
 * Run: npx railway run npx tsx scripts/kraken-my-edge.ts
 * (Prisma client must exist: npx prisma generate. Client lands in src/generated/prisma.)
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} as never);

interface Row {
  txid: string; pair: string; time: Date; type: string; price: number; cost: number;
  fee: number; vol: number; margin: number;
}
interface Trip {
  pair: string; side: "long" | "short"; openedAt: Date; closedAt: Date; holdMin: number;
  entry: number; exit: number; vol: number; gross: number; fees: number; net: number;
  notional: number; retOnNotional: number;
}

// FIFO lots — must mirror reconstructTrips in src/lib/kraken-margin.ts (Kraken closes
// margin positions first-in-first-out; average-cost would misstate per-trip hit rate).
function reconstruct(rows: Row[]): Trip[] {
  const trips: Trip[] = [];
  const book = new Map<string, { dir: 1 | -1; lots: { vol: number; price: number; fee: number; openedAt: Date }[] }>();
  for (const r of rows) {
    const dir: 1 | -1 = r.type === "buy" ? 1 : -1;
    let rem = r.vol;
    let feeRem = r.fee;
    let st = book.get(r.pair);
    if (st && st.lots.length && st.dir !== dir) {
      while (rem > 1e-12 && st.lots.length) {
        const lot = st.lots[0];
        const cv = Math.min(lot.vol, rem);
        const side: "long" | "short" = st.dir > 0 ? "long" : "short";
        const gross = side === "long" ? (r.price - lot.price) * cv : (lot.price - r.price) * cv;
        const ef = lot.fee * (cv / lot.vol);
        const xf = r.vol > 0 ? feeRem * (cv / r.vol) : 0;
        const notional = lot.price * cv;
        trips.push({
          pair: r.pair, side, openedAt: lot.openedAt, closedAt: r.time,
          holdMin: (r.time.getTime() - lot.openedAt.getTime()) / 60000,
          entry: lot.price, exit: r.price, vol: cv, gross, fees: ef + xf, net: gross - ef - xf,
          notional, retOnNotional: notional > 0 ? (gross - ef - xf) / notional : 0,
        });
        lot.vol -= cv; lot.fee -= ef; feeRem -= xf; rem -= cv;
        if (lot.vol <= 1e-12) st.lots.shift();
      }
      if (!st.lots.length) st = undefined;
    }
    if (rem > 1e-12) {
      if (!st || st.dir !== dir) st = { dir, lots: [] };
      st.lots.push({ vol: rem, price: r.price, fee: feeRem, openedAt: r.time });
    }
    if (st) book.set(r.pair, st); else book.delete(r.pair);
  }
  return trips;
}

// Deterministic RNG so reruns reproduce (Date.now/Math.random discipline).
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  // Opening fills post margin > 0; closing fills post margin 0 but carry posstatus.
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT txid, pair, time, type, price, cost, fee, vol, margin
     FROM kraken_my_trades
     WHERE margin > 0 OR COALESCE(posstatus, '') <> ''
     ORDER BY time ASC`,
  );
  const [{ rollover }] = await prisma.$queryRawUnsafe<{ rollover: number }[]>(
    `SELECT COALESCE(sum(fee),0)::float AS rollover FROM kraken_my_ledger
     WHERE ltype = 'rollover' AND asset IN ('ZUSD','USD')`,
  );
  // Kraken's own canonical margin P&L postings — the cross-check for our reconstruction.
  const [{ ledgerNet }] = await prisma.$queryRawUnsafe<{ ledgerNet: number }[]>(
    `SELECT COALESCE(sum(amount),0)::float AS "ledgerNet" FROM kraken_my_ledger
     WHERE ltype = 'margin' AND asset IN ('ZUSD','USD')`,
  );
  if (!rows.length) {
    console.log("No margin trades synced yet. Wait for the first margin-watch cron run after deploy, then re-run.");
    return;
  }

  const trips = reconstruct(rows);
  const spanDays = (rows[rows.length - 1].time.getTime() - rows[0].time.getTime()) / 86400000 || 1;
  const wins = trips.filter((t) => t.net > 0);
  const hit = trips.length ? wins.length / trips.length : 0;
  const netTotal = trips.reduce((s, t) => s + t.net, 0);
  const afterRollover = netTotal - rollover;
  const avgRet = trips.length ? trips.reduce((s, t) => s + t.retOnNotional, 0) / trips.length : 0;
  const sdRet = trips.length > 1
    ? Math.sqrt(trips.reduce((s, t) => s + (t.retOnNotional - avgRet) ** 2, 0) / (trips.length - 1))
    : 0;
  const tradesPerMonth = trips.length / (spanDays / 30.44);
  const avgHoldHours = trips.length ? trips.reduce((s, t) => s + t.holdMin, 0) / trips.length / 60 : 0;
  const avgNotional = trips.length ? trips.reduce((s, t) => s + t.notional, 0) / trips.length : 0;

  console.log("=".repeat(72));
  console.log("YOUR MEASURED MARGIN EDGE (from Kraken's own ledger)");
  console.log("=".repeat(72));
  console.log(`fills: ${rows.length}   round trips: ${trips.length}   span: ${spanDays.toFixed(0)} days   pace: ${tradesPerMonth.toFixed(1)} trades/month`);
  console.log(`hit rate: ${(hit * 100).toFixed(1)}%   avg hold: ${avgHoldHours.toFixed(1)}h   avg notional: $${avgNotional.toFixed(0)}`);
  console.log(`net P&L after trade fees: $${netTotal.toFixed(2)}   rollover paid: $${rollover.toFixed(2)}   AFTER ALL COSTS: $${afterRollover.toFixed(2)}`);
  console.log(`cross-check — Kraken's own margin-ledger P&L postings: $${ledgerNet.toFixed(2)} (should be near our reconstructed gross; investigate if far off)`);
  console.log(`per-trade return on notional: mean ${(avgRet * 100).toFixed(3)}%  sd ${(sdRet * 100).toFixed(2)}%`);
  const tStat = sdRet > 0 ? (avgRet / (sdRet / Math.sqrt(Math.max(1, trips.length)))) : 0;
  console.log(`edge t-stat: ${tStat.toFixed(2)}  (${Math.abs(tStat) < 2 ? "NOT statistically distinguishable from zero yet" : "statistically real at this sample"})`);

  console.log();
  console.log("by pair:");
  const byPair = new Map<string, Trip[]>();
  for (const t of trips) byPair.set(t.pair, [...(byPair.get(t.pair) ?? []), t]);
  for (const [pair, ts] of [...byPair.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const w = ts.filter((t) => t.net > 0).length;
    console.log(`  ${pair.padEnd(12)} ${String(ts.length).padStart(3)} trips  ${((w / ts.length) * 100).toFixed(0).padStart(3)}% win  net $${ts.reduce((s, t) => s + t.net, 0).toFixed(2)}`);
  }

  // ---- projection: bootstrap HIS OWN per-trade returns at each leverage ----
  // Sample with replacement from his measured per-trade returns-on-notional, at his own
  // trade pace, for 12 months. At leverage L on margin m: notional = m×L, per-trade P&L =
  // ret×notional, rollover = 0.02%/4h on notional while held, and the trip is a WIPEOUT
  // of the posted margin if its adverse extreme exceeds the 0.6/L cushion — approximated
  // by the trip's final return when final loss already exceeds the cushion (conservative
  // in his favor: intratrade wicks are invisible in fills data, real ruin is MORE likely).
  const START = 7300;           // ≈ current account
  const MARGIN_FRACTION = 0.5;  // half the account posted per trade (aggressive but survivable)
  const PATHS = 5000;
  const rand = mulberry32(770078);
  const rets = trips.map((t) => t.retOnNotional);
  const holds = trips.map((t) => Math.max(0.5, t.holdMin / 60));
  const monthlyTrades = Math.max(1, Math.round(tradesPerMonth));

  console.log();
  console.log("=".repeat(72));
  console.log(`12-MONTH PROJECTION — bootstrapping YOUR measured trades (${PATHS} paths/cell)`);
  console.log(`start $${START}, ${MARGIN_FRACTION * 100}% of account as margin per trade, your pace (${monthlyTrades}/mo)`);
  console.log("=".repeat(72));
  console.log("lev   median end   P(>$30k/mo avg)   P(account wiped)   avg monthly P&L");

  for (const L of [1, 2, 3, 5, 10, 20]) {
    let wiped = 0; const ends: number[] = []; const monthlies: number[] = [];
    for (let p = 0; p < PATHS; p++) {
      let eq = START; let dead = false;
      for (let m = 0; m < 12 && !dead; m++) {
        const before = eq;
        for (let k = 0; k < monthlyTrades; k++) {
          const i = Math.floor(rand() * rets.length);
          const margin = eq * MARGIN_FRACTION;
          const notional = margin * L;
          const roll = notional * 0.0002 * Math.ceil(holds[i] / 4);
          let pnl = rets[i] * notional - roll;
          // Wipeout: the loss cannot exceed the posted margin — but reaching -0.6/L on
          // price move means forced liquidation of that margin.
          if (rets[i] <= -(0.6 / L)) pnl = -margin;
          pnl = Math.max(pnl, -margin);
          eq += pnl;
          if (eq < 500) { dead = true; break; }
        }
        monthlies.push(eq - before);
      }
      if (dead) wiped++;
      ends.push(eq);
    }
    ends.sort((a, b) => a - b);
    const median = ends[Math.floor(ends.length / 2)];
    const avgMonthly = monthlies.reduce((s, x) => s + x, 0) / monthlies.length;
    const p30k = ends.filter((e) => e - START >= 30000 * 12).length / PATHS;
    console.log(
      `${String(L).padStart(3)}x  $${median.toFixed(0).padStart(9)}   ${(p30k * 100).toFixed(2).padStart(6)}%            ${((wiped / PATHS) * 100).toFixed(1).padStart(5)}%          $${avgMonthly.toFixed(0)}`,
    );
  }

  // ---- the three plain numbers ----
  console.log();
  console.log("=".repeat(72));
  console.log("THE THREE PLAIN NUMBERS");
  console.log("=".repeat(72));
  const edgePerTrade = avgRet;
  const monthlyOnNotional = edgePerTrade * monthlyTrades;
  console.log(`1. Your measured edge earns ~${(monthlyOnNotional * 100).toFixed(2)}% of NOTIONAL per month at your pace.`);
  const needNotional = monthlyOnNotional > 0 ? 30000 / monthlyOnNotional : Infinity;
  console.log(`2. $30k/month at that edge needs ~$${isFinite(needNotional) ? needNotional.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "∞ (edge ≤ 0)"} of notional working every month.`);
  if (isFinite(needNotional) && monthlyOnNotional > 0) {
    for (const L of [2, 5, 10, 20]) {
      console.log(`   at ${L}x that is $${(needNotional / L).toLocaleString(undefined, { maximumFractionDigits: 0 })} of account equity.`);
    }
  }
  const needHit = 0.5 + (0.012 + 0.0002 * Math.ceil(avgHoldHours / 4)) / (2 * Math.max(0.005, sdRet > 0 ? sdRet * Math.sqrt(2 / Math.PI) * 2 : 0.03));
  console.log(`3. Rough hit rate needed just to BREAK EVEN at your hold time and taker fees: ~${(Math.min(0.99, needHit) * 100).toFixed(0)}% (you: ${(hit * 100).toFixed(0)}%).`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
