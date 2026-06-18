#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const before = await prisma.agentConfig.findFirst({ where: { key: "live_futures_risk_per_trade_pct" } });
  console.log("BEFORE:", before?.value);

  await prisma.agentConfig.upsert({
    where: { key: "live_futures_risk_per_trade_pct" },
    update: { value: "15" },
    create: { key: "live_futures_risk_per_trade_pct", value: "15" },
  });

  const after = await prisma.agentConfig.findFirst({ where: { key: "live_futures_risk_per_trade_pct" } });
  console.log("AFTER:", after?.value);
  console.log("Done. Engine picks up on next config reload (~5 min).");
}

main().catch(console.error).finally(() => pool.end());
