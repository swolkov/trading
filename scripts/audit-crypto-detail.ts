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
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  // All autoTradeLog with crypto symbols (any variation)
  console.log("\n=== ALL CRYPTO LOG ENTRIES (7d, any symbol) ===");
  const allCrypto = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: since7d },
      OR: [
        { symbol: { contains: "BTC" } },
        { symbol: { contains: "ETH" } },
        { symbol: { contains: "crypto" } },
        { action: { contains: "crypto" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  console.log(`Found ${allCrypto.length} entries`);
  for (const t of allCrypto) {
    const etTime = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${etTime} | ${t.symbol.padEnd(12)} | ${t.action.padEnd(24)} | score:${String(t.aiScore ?? "n/a").padStart(4)} | pnl:${String(t.pnl ?? "null").padStart(8)} | ${(t.reason ?? "").slice(0, 100)}`);
  }

  // Decision logs for crypto
  console.log("\n=== CRYPTO DECISION LOGS (7d) ===");
  const decisions = await prisma.decisionLog.findMany({
    where: {
      createdAt: { gte: since7d },
      OR: [
        { symbol: { contains: "BTC" } },
        { symbol: { contains: "ETH" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  console.log(`Found ${decisions.length} decisions`);
  for (const d of decisions) {
    const etTime = d.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${etTime} | ${(d.symbol ?? "").padEnd(12)} | action:${(d.action ?? "").padEnd(16)} | confidence:${String(d.confidence ?? "n/a").padStart(4)} | ${(d.reason ?? "").slice(0, 100)}`);
  }

  // All decision logs last 24h to understand what the agent is doing
  console.log("\n=== ALL DECISION LOGS (last 24h) ===");
  const since24h = new Date(Date.now() - 24 * 3600 * 1000);
  const recentDecisions = await prisma.decisionLog.findMany({
    where: { createdAt: { gte: since24h } },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  console.log(`Found ${recentDecisions.length} decisions`);
  for (const d of recentDecisions) {
    const etTime = d.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${etTime} | ${(d.symbol ?? "").padEnd(12)} | ${(d.action ?? "").padEnd(18)} | conf:${String(d.confidence ?? "n/a").padStart(4)} | ${(d.reason ?? "").slice(0, 100)}`);
  }

  // Check if there's a separate crypto positions table or open positions
  console.log("\n=== OPEN POSITIONS (all) ===");
  const positions = await prisma.position.findMany({
    where: { status: "open" },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Open positions: ${positions.length}`);
  for (const p of positions) {
    const etTime = p.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${etTime} | ${p.symbol.padEnd(12)} | side:${p.side} | qty:${p.qty} | entry:${p.entryPrice} | mode:${(p as any).mode ?? "n/a"}`);
  }

  // Check AgentLog or any other log tables
  console.log("\n=== AGENT LOG (crypto, 24h) ===");
  try {
    const agentLogs = await (prisma as any).agentLog.findMany({
      where: {
        createdAt: { gte: since24h },
        OR: [
          { message: { contains: "crypto" } },
          { message: { contains: "BTC" } },
          { message: { contains: "ETH" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    console.log(`Found ${agentLogs.length} agent logs`);
    for (const l of agentLogs) {
      const etTime = l.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
      console.log(`  ${etTime} | ${(l.agent ?? "").padEnd(20)} | ${(l.message ?? "").slice(0, 120)}`);
    }
  } catch {
    console.log("  (no agentLog table)");
  }

  // Crypto all-time stats
  console.log("\n=== CRYPTO ALL-TIME TRADE LOG ===");
  const cryptoAllTime = await prisma.autoTradeLog.findMany({
    where: {
      OR: [
        { symbol: { contains: "BTC" } },
        { symbol: { contains: "ETH" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  console.log(`All-time crypto trades: ${cryptoAllTime.length}`);
  for (const t of cryptoAllTime) {
    const etTime = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    console.log(`  ${etTime} | ${t.symbol.padEnd(12)} | ${t.action.padEnd(24)} | score:${String(t.aiScore ?? "n/a").padStart(4)} | pnl:${String(t.pnl ?? "null").padStart(8)} | ${(t.reason ?? "").slice(0, 80)}`);
  }
}

main().catch(console.error).finally(() => pool.end());
