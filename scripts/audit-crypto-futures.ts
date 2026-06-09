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

  // ============ CRYPTO (stocks/crypto agent, Alpaca) ============
  console.log("\n=== CRYPTO TRADES (last 7d) ===");
  const cryptoTrades = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: since7d },
      OR: [
        { symbol: { in: ["BTC", "ETH", "BTC/USD", "ETH/USD", "BTCUSD", "ETHUSD"] } },
        { action: { contains: "crypto" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  console.log(`Found ${cryptoTrades.length} crypto trades`);
  for (const t of cryptoTrades) {
    const etTime = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const pnl = t.pnl ?? 0;
    console.log(`  ${etTime} | ${t.symbol.padEnd(10)} | ${t.action.padEnd(22)} | qty:${String(t.qty ?? 0).padStart(6)} | score:${String(t.aiScore ?? "n/a").padStart(4)} | pnl:${(pnl >= 0 ? "+" : "") + pnl.toFixed(2).padStart(8)} | ${(t.reason ?? "").slice(0, 80)}`);
  }

  // ============ ALL RECENT TRADES BY TYPE ============
  console.log("\n=== ALL TRADES LAST 7d — SUMMARY BY SYMBOL ===");
  const all7d = await prisma.autoTradeLog.findMany({
    where: { createdAt: { gte: since7d }, pnl: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  
  const bySymbol: Record<string, { count: number; pnl: number; wins: number; isLive: boolean }> = {};
  for (const t of all7d) {
    const isLive = t.action.startsWith("live_");
    const key = `${isLive ? "LIVE" : "DEMO"}:${t.symbol}`;
    if (!bySymbol[key]) bySymbol[key] = { count: 0, pnl: 0, wins: 0, isLive };
    bySymbol[key].count++;
    bySymbol[key].pnl += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) bySymbol[key].wins++;
  }
  const sorted = Object.entries(bySymbol).sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl));
  for (const [sym, s] of sorted) {
    console.log(`  ${sym.padEnd(20)} | ${s.count.toString().padStart(3)} trades | WR:${((s.wins/s.count)*100).toFixed(0).padStart(3)}% | pnl:${(s.pnl >= 0 ? "+" : "") + s.pnl.toFixed(2).padStart(10)}`);
  }

  // ============ DEMO FUTURES LAST 7d ============
  console.log("\n=== DEMO FUTURES LAST 7d ===");
  const demoFutures = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: since7d },
      symbol: { startsWith: "FUT:" },
      action: { not: { startsWith: "live_" } },
      pnl: { not: null },
    },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  let demoPnl = 0;
  for (const t of demoFutures) {
    demoPnl += t.pnl ?? 0;
    const etTime = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const pnl = t.pnl ?? 0;
    console.log(`  ${etTime} | ${t.symbol.padEnd(10)} | ${t.action.padEnd(22)} | qty:${String(t.qty ?? 0).padStart(2)} | score:${String(t.aiScore ?? "n/a").padStart(4)} | pnl:${(pnl >= 0 ? "+" : "") + pnl.toFixed(2).padStart(9)}`);
  }
  console.log(`  DEMO FUTURES 7d TOTAL (${demoFutures.length} trades): ${demoPnl >= 0 ? "+" : ""}${demoPnl.toFixed(2)}`);

  // ============ LIVE FUTURES LAST 7d ============
  console.log("\n=== LIVE FUTURES LAST 7d ===");
  const liveFutures = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: since7d },
      symbol: { startsWith: "FUT:" },
      action: { startsWith: "live_" },
      pnl: { not: null },
    },
    orderBy: { createdAt: "desc" },
  });
  let livePnl = 0;
  for (const t of liveFutures) {
    livePnl += t.pnl ?? 0;
    const etTime = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const pnl = t.pnl ?? 0;
    console.log(`  ${etTime} | ${t.symbol.padEnd(10)} | ${t.action.padEnd(22)} | qty:${String(t.qty ?? 0).padStart(2)} | score:${String(t.aiScore ?? "n/a").padStart(4)} | pnl:${(pnl >= 0 ? "+" : "") + pnl.toFixed(2).padStart(9)}`);
  }
  console.log(`  LIVE FUTURES 7d TOTAL (${liveFutures.length} trades): ${livePnl >= 0 ? "+" : ""}${livePnl.toFixed(2)}`);

  // ============ CRYPTO CONFIG ============
  console.log("\n=== CRYPTO/STOCKS AGENT CONFIG ===");
  const cryptoCfg = await prisma.agentConfig.findMany({
    where: { key: { startsWith: "stocks_" } },
    orderBy: { key: "asc" },
  });
  for (const c of cryptoCfg) console.log(`  ${c.key.padEnd(45)} = ${c.value}`);
  
  const cryptoCfg2 = await prisma.agentConfig.findMany({
    where: { key: { startsWith: "crypto_" } },
    orderBy: { key: "asc" },
  });
  for (const c of cryptoCfg2) console.log(`  ${c.key.padEnd(45)} = ${c.value}`);

  // ============ DAILY P&L BREAKDOWN ============
  console.log("\n=== DAILY P&L BY DAY (last 7d, all closed trades) ===");
  const dailyMap: Record<string, { demo: number; live: number; demoCnt: number; liveCnt: number }> = {};
  for (const t of all7d) {
    const d = t.createdAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit" });
    if (!dailyMap[d]) dailyMap[d] = { demo: 0, live: 0, demoCnt: 0, liveCnt: 0 };
    if (t.action.startsWith("live_")) {
      dailyMap[d].live += t.pnl ?? 0;
      dailyMap[d].liveCnt++;
    } else {
      dailyMap[d].demo += t.pnl ?? 0;
      dailyMap[d].demoCnt++;
    }
  }
  for (const [day, v] of Object.entries(dailyMap).sort()) {
    console.log(`  ${day} | DEMO: ${(v.demo >= 0 ? "+" : "") + v.demo.toFixed(2).padStart(10)} (${v.demoCnt} trades) | LIVE: ${(v.live >= 0 ? "+" : "") + v.live.toFixed(2).padStart(9)} (${v.liveCnt} trades)`);
  }
}

main().catch(console.error).finally(() => pool.end());
