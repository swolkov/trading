#!/usr/bin/env tsx
// Read the $1K paper-test state from the DB (flag/baseline/recent activity). No Alpaca keys needed.
//   railway run npx tsx scripts/check-paper-test.ts
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const keys = ["alpaca_flatten_requested", "alpaca_test_baseline_equity", "alpaca_test_start", "alpaca_account_size", "crypto_cron_last_run"];
  const cfgs = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
  const m: Record<string, string> = {};
  for (const c of cfgs) m[c.key] = c.value;
  console.log("flatten_flag:", m.alpaca_flatten_requested ?? "<unset>");
  console.log("baseline_equity:", m.alpaca_test_baseline_equity ?? "<unset>");
  console.log("test_start:", m.alpaca_test_start ?? "<unset>");
  console.log("pool_size:", m.alpaca_account_size ?? "<unset>");
  console.log("crypto_cron_last_run:", m.crypto_cron_last_run ?? "<unset>");

  const since = m.alpaca_test_start ? new Date(m.alpaca_test_start) : new Date(0);
  const closes = await prisma.autoTradeLog.count({
    where: { createdAt: { gte: since }, action: { in: ["take_profit", "stop_loss", "eod_flatten", "time_exit"] }, OR: [{ symbol: { startsWith: "STK:" } }, { symbol: { startsWith: "CRY:" } }] },
  });
  const entries = await prisma.autoTradeLog.count({
    where: { createdAt: { gte: since }, action: { in: ["stock_long", "crypto_long", "crypto_short"] } },
  });
  console.log(`since_start: ${entries} entries, ${closes} round-trips`);
}
main().catch(console.error).finally(() => pool.end());
