#!/usr/bin/env tsx
// Request a one-off paper-account flatten + clean baseline. Sets the DB flag that the crypto
// cron consumes server-side (where the sealed Alpaca keys resolve). Run:
//   railway run npx tsx scripts/request-paper-flatten.ts
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const stamp = new Date().toISOString();
  await prisma.agentConfig.upsert({
    where: { key: "alpaca_flatten_requested" },
    update: { value: stamp },
    create: { key: "alpaca_flatten_requested", value: stamp },
  });
  console.log(`Flatten requested at ${stamp}. The next crypto cron tick (≤5 min) will close all paper positions and lock a clean baseline.`);
}
main().catch(console.error).finally(() => pool.end());
