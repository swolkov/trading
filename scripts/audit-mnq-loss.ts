#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const today = new Date("2026-06-05T00:00:00Z");

  // All live trades today with full reason
  const trades = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: today },
      action: { startsWith: "live_" },
      symbol: { startsWith: "FUT:" },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const t of trades) {
    const et = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    console.log(`\n─── ${et} | ${t.symbol} | ${t.action} | qty:${t.qty} | pnl:${t.pnl ?? "open"} | score:${t.aiScore ?? "n/a"} ───`);
    console.log(`REASON: ${t.reason ?? "(none)"}`);
  }

  // Also check entry logs — the entry that caused the loss (before the stop)
  const since = new Date("2026-06-05T00:00:00Z");
  const entries = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: since },
      action: { in: ["live_entry", "live_long", "live_short", "live_futures_entry", "live_buy", "live_sell"] },
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\n=== ENTRY LOGS TODAY (${entries.length}) ===`);
  for (const t of entries) {
    const et = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    console.log(`\n${et} | ${t.symbol} | ${t.action} | qty:${t.qty} | score:${t.aiScore ?? "n/a"}`);
    console.log(`REASON: ${t.reason ?? "(none)"}`);
  }

  // Check agentEvent for today's live entry reasoning
  const events = await prisma.agentEvent.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 30,
  });
  console.log(`\n=== AGENT EVENTS TODAY (${events.length}) ===`);
  for (const e of events) {
    const et = e.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    const payload = JSON.stringify(e.payload ?? {}).slice(0, 200);
    console.log(`  ${et} | ${(e as any).type ?? (e as any).eventType} | ${payload}`);
  }
}

main().catch(console.error).finally(() => pool.end());
