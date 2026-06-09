#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const now = Date.now();

  // Session context — engines write this every cycle
  const ctx = await prisma.sessionContext.findMany({ orderBy: { updatedAt: "desc" } });
  console.log("=== SESSION CONTEXT (engine writes these) ===");
  for (const c of ctx) {
    const ago = Math.round((now - new Date(c.updatedAt).getTime()) / 1000);
    console.log(`  ${c.key.padEnd(35)} = ${String(c.value).slice(0, 40).padEnd(40)} (${ago}s ago)`);
  }

  // All agentConfig keys with "heartbeat" or "last_run" or "connected"
  const hb = await prisma.agentConfig.findMany({
    where: { key: { contains: "heartbeat" } },
    orderBy: { key: "asc" },
  });
  console.log("\n=== ALL HEARTBEAT KEYS ===");
  for (const k of hb) {
    let ts: Date | null = null;
    try { const parsed = JSON.parse(k.value); ts = new Date(parsed.timestamp ?? parsed); } catch { try { ts = new Date(k.value); } catch {} }
    const ago = ts ? Math.round((now - ts.getTime()) / 1000) : -1;
    const status = ago < 120 ? "✓ UP" : ago < 600 ? "⚠ SLOW" : "✗ DOWN";
    console.log(`  ${k.key.padEnd(40)} ${ago}s ago ${status}`);
  }

  // Recent log entries from both engines
  console.log("\n=== RECENT FUTURES ACTIVITY (last 20 min) ===");
  const recent = await prisma.autoTradeLog.findMany({
    where: { createdAt: { gte: new Date(now - 20 * 60 * 1000) }, symbol: { startsWith: "FUT:" } },
    orderBy: { createdAt: "desc" }, take: 10,
  });
  if (recent.length === 0) console.log("  None — market may be closed or engines quiet");
  for (const t of recent) {
    const et = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${et} | ${t.symbol} | ${t.action}`);
  }

  // Check agentRun for recent watchdog (fires every 5 min — proves Vercel is alive)
  const wd = await prisma.agentRun.findFirst({ where: { runType: "watchdog" }, orderBy: { createdAt: "desc" } });
  if (wd) {
    const ago = Math.round((now - new Date(wd.createdAt).getTime()) / 1000);
    console.log(`\n  Watchdog last ran: ${ago}s ago — ${wd.summary}`);
  }
}
main().catch(console.error).finally(() => pool.end());
