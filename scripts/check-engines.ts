#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const keys = await prisma.agentConfig.findMany({
    where: { key: { in: ["futures_cron_last_run", "live_futures_cron_last_run", "futures_engine_heartbeat", "live_engine_heartbeat", "engine_heartbeat"] } },
  });
  
  const now = Date.now();
  console.log("=== ENGINE HEARTBEATS ===");
  for (const k of keys) {
    const ago = Math.round((now - new Date(k.value).getTime()) / 1000);
    const fresh = ago < 120 ? "✓ UP" : ago < 300 ? "⚠ SLOW" : "✗ DOWN";
    console.log(`  ${k.key.padEnd(35)} = ${k.value} (${ago}s ago) ${fresh}`);
  }

  // Also check last agentRun
  const lastRun = await prisma.agentRun.findFirst({ orderBy: { createdAt: "desc" } });
  if (lastRun) {
    const ago = Math.round((now - new Date(lastRun.createdAt).getTime()) / 1000);
    console.log(`\n  Last agentRun: ${lastRun.runType} — ${ago}s ago`);
  }

  // Check recent autoTradeLog for engine activity
  const recentTrade = await prisma.autoTradeLog.findFirst({
    where: { symbol: { startsWith: "FUT:" } },
    orderBy: { createdAt: "desc" },
  });
  if (recentTrade) {
    const ago = Math.round((now - new Date(recentTrade.createdAt).getTime()) / 1000);
    const etTime = recentTrade.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  Last futures activity: ${etTime} ET (${ago}s ago) — ${recentTrade.symbol} ${recentTrade.action}`);
  }
}
main().catch(console.error).finally(() => pool.end());
