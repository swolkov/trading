/**
 * Reprices REAL demo fills onto the current live account using normalized R-multiples.
 * This is read-only. It does not set risk, flags, contracts, or account balances.
 */
import { config } from "dotenv";
import { bootstrapGrowth, compoundRMultiples, requiredExpectancyR } from "../src/lib/account-growth";
import { isFreshPositiveEquity } from "../src/lib/risk-sizing";

config({ path: ".env.local" });
config();

const SINCE = new Date(process.env.GROWTH_SINCE || "2026-08-10T19:45:00Z");
const RISKS = [0.01, 0.02, 0.03, 0.05];
const WEEKLY_TARGET = Number(process.env.WEEKLY_TARGET || 2_000);
const FORWARD_TRADES = Number(process.env.GROWTH_FORWARD_TRADES || 50);

const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

async function main() {
  // Dynamic import after dotenv because the DB client reads its URL during module initialization.
  const { prisma } = await import("../src/lib/db");
  const [rows, liveHeartbeat] = await Promise.all([
    prisma.roundTrip.findMany({
      where: { mode: "paper", entryTime: { gt: SINCE } },
      orderBy: { entryTime: "asc" },
      select: { rMultiple: true, pnl: true, setupType: true, entryTime: true, exitTime: true },
    }),
    prisma.agentConfig.findUnique({ where: { key: "futures_engine_heartbeat_live" } }),
  ]);
  const heartbeat = JSON.parse(liveHeartbeat?.value || "{}") as { equity?: number; timestamp?: string };
  const startingEquity = Number(heartbeat.equity);
  const heartbeatAt = Date.parse(heartbeat.timestamp || "");
  if (!isFreshPositiveEquity(startingEquity, heartbeatAt, Date.now(), 15 * 60_000)) {
    throw new Error("Live heartbeat is stale; refusing to project growth from an obsolete balance");
  }

  const usable = rows.filter((row): row is typeof row & { rMultiple: number } => Number.isFinite(row.rMultiple));
  const returnsR = usable.map((row) => row.rMultiple);
  const missing = rows.length - usable.length;
  const meanR = returnsR.length ? returnsR.reduce((sum, value) => sum + value, 0) / returnsR.length : 0;
  const first = usable[0]?.entryTime.getTime();
  const last = usable.at(-1)?.exitTime.getTime();
  const elapsedWeeks = first && last && last > first ? (last - first) / (7 * 24 * 60 * 60 * 1000) : 0;
  const observedTradesPerWeek = elapsedWeeks > 0 ? returnsR.length / elapsedWeeks : 0;
  const planningTradesPerWeek = Math.max(1, Math.min(10, observedTradesPerWeek || 5));

  console.log(`\nLIVE-NORMALIZED DEMO GROWTH | live equity ${money(startingEquity)} | demo real fills since ${SINCE.toISOString()}`);
  console.log(`usable R-multiples ${returnsR.length}/${rows.length} | missing attribution ${missing} | observed expectancy ${meanR >= 0 ? "+" : ""}${meanR.toFixed(3)}R`);
  console.log(returnsR.length < 30
    ? "EVIDENCE: INSUFFICIENT. Fewer than 30 real demo round trips; outputs below are diagnostics, not a sizing recommendation."
    : "EVIDENCE: minimum sample reached; promotion still requires t-stat > 2, positive halves, and slippage review.");

  console.log("\nrisk    actual-sequence end   max DD   killed   50-trade bootstrap p10 / median / p90   P(kill)");
  for (const risk of RISKS) {
    const actual = compoundRMultiples(startingEquity, risk, returnsR);
    const forward = bootstrapGrowth(startingEquity, risk, returnsR, FORWARD_TRADES);
    console.log(`${String(risk * 100).padStart(3)}%     ${money(actual.endingEquity).padStart(10)}          ${pct(actual.maxDrawdownPct).padStart(6)}   ${actual.killed ? "YES" : " no"}      ${money(forward.p10)} / ${money(forward.median)} / ${money(forward.p90)}      ${pct(forward.killRate)}`);
  }

  console.log(`\n${money(WEEKLY_TARGET)}/week requirement at ${planningTradesPerWeek.toFixed(1)} trades/week:`);
  for (const risk of RISKS) {
    console.log(`  ${(risk * 100).toFixed(0)}% risk requires ${requiredExpectancyR(WEEKLY_TARGET, startingEquity, risk, planningTradesPerWeek).toFixed(2)}R average per trade`);
  }

  const groups = new Map<string, number[]>();
  for (const row of usable) {
    const key = row.setupType || "unattributed";
    groups.set(key, [...(groups.get(key) || []), row.rMultiple]);
  }
  console.log("\nreal demo evidence by setup:");
  for (const [setup, values] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    console.log(`  ${setup.padEnd(28)} n=${String(values.length).padStart(3)} exp=${average >= 0 ? "+" : ""}${average.toFixed(3)}R`);
  }
  console.log("\nSafety: read-only analysis. Demo dollar P&L is not treated as live-account P&L.\n");
  await prisma.$disconnect();
}

main();
