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
  // Most recent live trades (last 48h)
  const since = new Date(Date.now() - 48 * 3600 * 1000);
  const liveTrades = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: since },
      action: { startsWith: "live_" },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  console.log(`\n=== LIVE TRADES (last 48h, ${liveTrades.length} total) ===\n`);
  for (const t of liveTrades) {
    const pnl = t.pnl ?? 0;
    const etTime = t.createdAt.toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    console.log(
      `${etTime} | ${t.symbol.padEnd(10)} | ${t.action.padEnd(24)} | qty:${String(t.qty ?? 0).padStart(2)} | score:${String(t.aiScore ?? "n/a").padStart(4)} | pnl:${(pnl >= 0 ? "+" : "") + pnl.toFixed(2).padStart(10)} | ${(t.reason ?? "").slice(0, 100)}`,
    );
  }

  // Find specifically any trade with loss > $50 live
  const bigLosses = liveTrades.filter(t => (t.pnl ?? 0) < -50);
  if (bigLosses.length > 0) {
    console.log(`\n=== LIVE LOSSES > $50 ===`);
    for (const t of bigLosses) {
      console.log(`\nSYMBOL:  ${t.symbol}`);
      console.log(`ACTION:  ${t.action}`);
      console.log(`QTY:     ${t.qty}`);
      console.log(`PNL:     ${(t.pnl ?? 0).toFixed(2)}`);
      console.log(`SCORE:   ${t.aiScore ?? "n/a"}`);
      console.log(`REASON:  ${t.reason ?? "n/a"}`);
      console.log(`TIME ET: ${t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York" })}`);
    }
  }

  // Live risk config
  console.log("\n=== LIVE RISK CONFIG ===");
  const cfg = await prisma.agentConfig.findMany({
    where: { key: { startsWith: "live_futures" } },
    orderBy: { key: "asc" },
  });
  for (const c of cfg) console.log(`  ${c.key.padEnd(45)} = ${c.value}`);

  // Check current live balance from daily-balances vault doc
  console.log("\n=== LIVE DAILY P&L TODAY ===");
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayLive = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: todayStart },
      action: { startsWith: "live_" },
      pnl: { not: null },
    },
    orderBy: { createdAt: "asc" },
  });
  let runningPnl = 0;
  for (const t of todayLive) {
    runningPnl += t.pnl ?? 0;
    const etTime = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${etTime} | ${t.symbol.padEnd(10)} | ${t.action.padEnd(24)} | pnl:${((t.pnl ?? 0) >= 0 ? "+" : "") + (t.pnl ?? 0).toFixed(2).padStart(9)} | running:${(runningPnl >= 0 ? "+" : "") + runningPnl.toFixed(2).padStart(9)}`);
  }
  if (todayLive.length === 0) console.log("  No live closed trades today yet.");

  // Check session context for pause state
  const pauseCtx = await prisma.sessionContext.findUnique({ where: { key: "entries_paused" } });
  const tiltCtx = await prisma.sessionContext.findUnique({ where: { key: "live_consecutive_stops" } });
  const liveDailyPnl = await prisma.sessionContext.findUnique({ where: { key: "live_daily_pnl" } });
  console.log("\n=== SESSION STATE ===");
  console.log("  entries_paused:        ", pauseCtx?.value ?? "null");
  console.log("  live_consecutive_stops:", tiltCtx?.value ?? "null");
  console.log("  live_daily_pnl:        ", liveDailyPnl?.value ?? "null");
}

main().catch(console.error).finally(() => pool.end());
