#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error("DATABASE_URL required");
const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  // AgentRun for crypto
  const runs = await prisma.agentRun.findMany({
    where: { createdAt: { gte: since24h } },
    orderBy: { createdAt: "desc" }, take: 30,
  });
  console.log(`\n=== ALL AGENT RUNS (24h) — ${runs.length} total ===`);
  for (const r of runs) {
    const t = r.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${t} | ${r.agentName.padEnd(26)} | ${(r.status ?? "").padEnd(10)} | ${(r.summary ?? "").slice(0, 100)}`);
  }

  // AgentEvents
  const events = await prisma.agentEvent.findMany({
    where: { createdAt: { gte: since24h } },
    orderBy: { createdAt: "desc" }, take: 30,
  });
  console.log(`\n=== AGENT EVENTS (24h) — ${events.length} total ===`);
  for (const e of events) {
    const t = e.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    const payload = JSON.stringify(e.payload ?? {}).slice(0, 120);
    console.log(`  ${t} | ${e.eventType.padEnd(32)} | ${payload}`);
  }

  // Crypto agent runs all-time
  const cryptoRuns = await prisma.agentRun.findMany({
    where: { agentName: { contains: "crypto" }, createdAt: { gte: since7d } },
    orderBy: { createdAt: "desc" }, take: 20,
  });
  console.log(`\n=== CRYPTO AGENT RUNS (7d) — ${cryptoRuns.length} total ===`);
  for (const r of cryptoRuns) {
    const t = r.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${t} | ${r.agentName.padEnd(26)} | ${(r.status ?? "").padEnd(10)} | ${(r.summary ?? "").slice(0, 120)}`);
  }
}

main().catch(console.error).finally(() => pool.end());
