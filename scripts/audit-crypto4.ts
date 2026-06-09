#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const url = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  // All distinct runTypes
  const allRuns = await prisma.agentRun.findMany({
    where: { createdAt: { gte: since7d } },
    orderBy: { createdAt: "desc" },
  });
  const byType: Record<string, number> = {};
  for (const r of allRuns) {
    byType[r.runType] = (byType[r.runType] ?? 0) + 1;
  }
  console.log("\n=== AGENT RUN TYPES (7d) ===");
  for (const [type, cnt] of Object.entries(byType).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${type.padEnd(30)} x${cnt}`);
  }

  // Watchdog critical details
  const watchdogCritical = await prisma.agentRun.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) }, runType: "watchdog", errors: { gt: 0 } },
    orderBy: { createdAt: "desc" }, take: 5,
  });
  console.log(`\n=== WATCHDOG WITH ERRORS (24h) — ${watchdogCritical.length} ===`);
  for (const r of watchdogCritical) {
    const t = r.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${t} | ${r.summary}`);
  }

  // SessionContext — all keys
  console.log("\n=== ALL SESSION CONTEXT ===");
  const ctx = await prisma.sessionContext.findMany({ orderBy: { key: "asc" } });
  for (const c of ctx) {
    const t = c.updatedAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${c.key.padEnd(40)} = ${String(c.value).slice(0,60)} (updated ${t})`);
  }

  // Open positions
  const positions = await prisma.position.findMany({ where: { status: "open" }, orderBy: { createdAt: "desc" } });
  console.log(`\n=== OPEN POSITIONS (${positions.length}) ===`);
  for (const p of positions) {
    const t = p.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${t} | ${p.symbol.padEnd(12)} | ${p.side} | qty:${p.qty} | entry:${p.entryPrice} | ${JSON.stringify(p).slice(0, 80)}`);
  }
}

main().catch(console.error).finally(() => pool.end());
