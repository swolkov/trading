/**
 * Seed the Instrument / Strategy / StrategyAssignment tables from the code-level constants.
 * Idempotent — safe to re-run after schema changes.
 *
 * Usage:
 *   npx prisma db push          (apply schema, only needed once)
 *   npx tsx scripts/seed-strategy-data.ts   (populate)
 */
import { prisma } from "../src/lib/db";
import { TRADOVATE_CONTRACTS } from "../src/lib/tradovate";
import { STRATEGIES } from "../src/lib/strategies/registry";
import { assetClassFor } from "../src/lib/asset-classes";

const DAY_MARGIN_ESTIMATES: Record<string, number> = {
  ES: 13_000, NQ: 16_500, GC: 10_000, YM: 9_500, RTY: 8_500,
  MES: 1_300, MNQ: 1_650, MGC: 1_000, MYM: 950, M2K: 850,
  MBT: 2_000, MET: 350, BFF: 200, MXR: 850, MSL: 650,
};

async function seedInstruments() {
  const symbols = Object.keys(TRADOVATE_CONTRACTS);
  let upserted = 0;
  for (const sym of symbols) {
    const spec = TRADOVATE_CONTRACTS[sym];
    const ac = assetClassFor(sym);
    if (!ac) {
      console.log(`  skip ${sym} — no asset class in ASSET_CLASSES`);
      continue;
    }
    await prisma.instrument.upsert({
      where: { symbol: sym },
      update: {
        assetClass: ac,
        exchange: spec.exchange,
        multiplier: spec.multiplier,
        tickSize: spec.tickSize,
        dayMarginEst: DAY_MARGIN_ESTIMATES[sym] ?? null,
      },
      create: {
        symbol: sym,
        assetClass: ac,
        exchange: spec.exchange,
        multiplier: spec.multiplier,
        tickSize: spec.tickSize,
        dayMarginEst: DAY_MARGIN_ESTIMATES[sym] ?? null,
      },
    });
    upserted++;
  }
  console.log(`  instruments upserted: ${upserted}/${symbols.length}`);
}

async function seedStrategies() {
  for (const s of STRATEGIES) {
    const payload = {
      name: s.name,
      timeframe: s.timeframe,
      tier: s.tier === "rejected" ? 0 : s.tier,
      description: s.description,
      applicableSymbols: s.applicableSymbols,
      codePath: s.codePath,
      backtestPf: s.backtest?.pf ?? null,
      backtestTrades: s.backtest?.trades ?? null,
      backtestPeriod: s.backtest?.period ?? null,
    };
    await prisma.strategy.upsert({
      where: { id: s.id },
      update: payload,
      create: { id: s.id, ...payload },
    });
  }
  console.log(`  strategies upserted: ${STRATEGIES.length}`);
}

async function seedAssignments() {
  // Default assignments — Tier 2 strategies are "active" on demo, "observation" on live.
  // Tier 1 would be active on both. (No Tier 1 in registry yet.)
  let created = 0;
  for (const s of STRATEGIES) {
    const defaultDemoStatus = "active";
    const defaultLiveStatus = s.tier === 1 ? "active" : "observation";
    for (const [accountKey, status] of [
      ["demo-futures", defaultDemoStatus],
      ["live-futures", defaultLiveStatus],
    ] as const) {
      const existing = await prisma.strategyAssignment.findUnique({
        where: { accountKey_strategyId: { accountKey, strategyId: s.id } },
      });
      if (existing) continue;
      await prisma.strategyAssignment.create({
        data: { accountKey, strategyId: s.id, status },
      });
      created++;
    }
  }
  console.log(`  assignments created: ${created} (existing untouched)`);
}

async function main() {
  console.log("Seeding strategy registry tables...");
  await seedInstruments();
  await seedStrategies();
  await seedAssignments();
  console.log("Done.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
