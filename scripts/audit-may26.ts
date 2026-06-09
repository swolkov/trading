#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error("DATABASE_URL required");

const pool = new Pool({ connectionString: url });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // All May 26 NQ/ES/GC futures exits with their P&L — including pnl=0 which may be missing
  console.log("\n=== MAY 26 FUTURES CLOSES (including pnl=0) ===");
  const may26 = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: new Date("2026-05-26T04:00:00Z"), lt: new Date("2026-05-27T04:00:00Z") },
      symbol: { startsWith: "FUT:" },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const t of may26) {
    const etTime = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${etTime} | ${t.symbol.padEnd(8)} | ${t.action.padEnd(22)} | qty:${t.qty} | pnl:${(t.pnl ?? 0) >= 0 ? "+" : ""}${(t.pnl ?? 0).toFixed(2).padStart(10)} | ${(t.reason ?? "").slice(0, 80)}`);
  }

  // May 27 which has the big DB P&L (+$19,876)
  console.log("\n=== MAY 27 FUTURES CLOSES (the real big day?) ===");
  const may27 = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: new Date("2026-05-27T04:00:00Z"), lt: new Date("2026-05-28T04:00:00Z") },
      symbol: { startsWith: "FUT:" },
      pnl: { not: null },
    },
    orderBy: { pnl: "desc" },
  });
  let may27pnl = 0;
  for (const t of may27) {
    may27pnl += t.pnl ?? 0;
    const etTime = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${etTime} | ${t.symbol.padEnd(8)} | ${t.action.padEnd(22)} | qty:${t.qty} | score:${String(t.aiScore ?? "n/a").padStart(3)} | pnl:${(t.pnl ?? 0) >= 0 ? "+" : ""}${(t.pnl ?? 0).toFixed(2).padStart(10)}`);
  }
  console.log(`  MAY 27 DB TOTAL: +${may27pnl.toFixed(2)}`);

  // Full config dump — what is the engine ACTUALLY running right now
  console.log("\n=== FULL LIVE RISK CONFIG (what engine actually runs) ===");
  const liveKeys = await prisma.agentConfig.findMany({
    where: { key: { startsWith: "live_futures" } },
    orderBy: { key: "asc" },
  });
  for (const c of liveKeys) console.log(`  ${c.key.padEnd(45)} = ${c.value}`);

  console.log("\n=== FULL DEMO RISK CONFIG (what engine actually runs) ===");
  const demoKeys = await prisma.agentConfig.findMany({
    where: { key: { startsWith: "futures" }, NOT: { key: { startsWith: "futures_engine" } } },
    orderBy: { key: "asc" },
  });
  for (const c of demoKeys) console.log(`  ${c.key.padEnd(45)} = ${c.value}`);
}

main().catch(console.error).finally(() => pool.end());
