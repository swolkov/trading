#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const now = Date.now();

  // Live heartbeat details
  const hb = await prisma.agentConfig.findFirst({ where: { key: "futures_engine_heartbeat_live" } });
  console.log("LIVE HEARTBEAT:", hb?.value?.slice(0, 200));

  // All live-mode session context
  const ctx = await prisma.sessionContext.findMany({ where: { key: { startsWith: "live_" } }, orderBy: { updatedAt: "desc" } });
  console.log("\nLIVE SESSION CONTEXT:");
  for (const c of ctx) {
    const ago = Math.round((now - new Date(c.updatedAt).getTime()) / 1000);
    console.log("  " + c.key.padEnd(35) + " = " + String(c.value).slice(0, 60) + "  (" + ago + "s ago)");
  }

  // entries_paused check
  const paused = await prisma.sessionContext.findFirst({ where: { key: "entries_paused" } });
  const livePaused = await prisma.sessionContext.findFirst({ where: { key: "live_entries_paused" } });
  console.log("\nENTRIES PAUSED (global):", paused?.value ?? "not set");
  console.log("LIVE ENTRIES PAUSED:", livePaused?.value ?? "not set");

  // Recent live trades - last 10 days (MNQ = live symbol)
  const trades = await prisma.autoTradeLog.findMany({
    where: {
      createdAt: { gte: new Date(now - 10 * 24 * 60 * 60 * 1000) },
      symbol: { contains: "MNQ" },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  console.log("\nLAST 10 DAYS MNQ TRADES (" + trades.length + "):");
  for (const t of trades) {
    const et = t.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    console.log("  " + et + " | " + t.symbol + " | " + t.action + " | pnl=" + (t.pnl ?? "open") + " | score=" + (t.aiScore ?? "n/a") + " | " + (t.reason ?? "").slice(0, 50));
  }

  // AI grader config
  const graderKeys = await prisma.agentConfig.findMany({
    where: { key: { contains: "grader" } },
    orderBy: { key: "asc" },
  });
  console.log("\nGRADER CONFIG:");
  for (const k of graderKeys) console.log("  " + k.key.padEnd(45) + " = " + k.value);

  // All live_ config keys
  const liveKeys = await prisma.agentConfig.findMany({
    where: { key: { startsWith: "live_" } },
    orderBy: { key: "asc" },
  });
  console.log("\nALL LIVE_ CONFIG KEYS:");
  for (const k of liveKeys) console.log("  " + k.key.padEnd(45) + " = " + k.value);

  // Orchestrator events in last 2h
  const orchEvents = await prisma.event.findMany({
    where: {
      createdAt: { gte: new Date(now - 2 * 60 * 60 * 1000) },
      type: { contains: "pause" },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log("\nRECENT PAUSE EVENTS (last 2h):");
  if (orchEvents.length === 0) console.log("  None");
  for (const e of orchEvents) {
    const ago = Math.round((now - new Date(e.createdAt).getTime()) / 1000);
    console.log("  " + e.type + " | " + e.source + " | " + JSON.stringify(e.data).slice(0, 80) + "  (" + ago + "s ago)");
  }

  // Check if model is down (AI grader needs a model)
  const aiDown = await prisma.sessionContext.findFirst({ where: { key: "live_ai_down" } });
  const modelFallback = await prisma.agentConfig.findFirst({ where: { key: "advisor_fallback_models" } });
  console.log("\nAI DOWN FLAG:", aiDown?.value ?? "not set");
  console.log("MODEL FALLBACK CONFIG:", modelFallback?.value ?? "not set");

  // Recent decision logs (skipped trades / vetoes) for live
  const decisions = await prisma.agentRun.findMany({
    where: {
      createdAt: { gte: new Date(now - 7 * 24 * 60 * 60 * 1000) },
      runType: { contains: "live" },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  console.log("\nLIVE AGENT RUNS LAST 7 DAYS (" + decisions.length + " rows):");
  for (const d of decisions) {
    const et = d.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    console.log("  " + et + " | " + d.runType + " | " + (d.summary ?? "").slice(0, 80));
  }

  // Recent orchestrator events - live engine specific
  const allEvents = await prisma.event.findMany({
    where: {
      createdAt: { gte: new Date(now - 7 * 24 * 60 * 60 * 1000) },
      OR: [
        { source: { contains: "live" } },
        { type: { contains: "pause" } },
        { type: { contains: "risk" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  console.log("\nRECENT LIVE/PAUSE/RISK EVENTS (7d):");
  if (allEvents.length === 0) console.log("  None");
  for (const e of allEvents) {
    const et = e.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    console.log("  " + et + " | " + e.type + " | " + e.source + " | " + JSON.stringify(e.data).slice(0, 80));
  }
}

main().catch(console.error).finally(() => pool.end());
