#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const url = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const r = await prisma.agentRun.findFirst({ orderBy: { createdAt: "desc" } });
  console.log("Sample agentRun row:", JSON.stringify(r));

  const since24h = new Date(Date.now() - 24 * 3600 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const runs = await prisma.agentRun.findMany({
    where: { createdAt: { gte: since24h } },
    orderBy: { createdAt: "desc" }, take: 30,
  });
  console.log(`\n=== AGENT RUNS (24h) — ${runs.length} ===`);
  for (const r of runs) {
    const t = r.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const name = String(r.agentName ?? r.name ?? (r as any).agent ?? "unknown");
    const status = String((r as any).status ?? (r as any).result ?? "");
    const summary = String((r as any).summary ?? (r as any).output ?? "");
    console.log(`  ${t} | ${name.padEnd(26)} | ${status.padEnd(10)} | ${summary.slice(0, 100)}`);
  }

  const cryptoRuns = await prisma.agentRun.findMany({
    where: { createdAt: { gte: since7d } },
    orderBy: { createdAt: "desc" }, take: 5,
  });
  console.log("\nAll keys on agentRun:", Object.keys(cryptoRuns[0] ?? {}));
}

main().catch(console.error).finally(() => pool.end());
