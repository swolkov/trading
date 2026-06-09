#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const url = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const keys: Array<[string, string]> = [
    ["live_crypto_enabled",               "false"],  // flip to "true" to activate live trading
    ["live_crypto_confidence_threshold",  "80"],     // higher bar than demo (65)
    ["live_crypto_risk_per_trade_pct",    "1"],      // 1% risk per trade — conservative live
    ["live_crypto_daily_loss_limit_pct",  "3"],      // 3% daily loss limit
    ["live_crypto_max_positions",         "2"],      // max 2 open crypto positions at once
    ["live_crypto_max_trades_per_day",    "3"],      // max 3 entries per day
    ["live_crypto_focus_symbols",         "BTC/USD,ETH/USD"],
  ];

  for (const [key, value] of keys) {
    await prisma.agentConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    console.log(`  SET ${key.padEnd(42)} = ${value}`);
  }
  console.log("\nDone. live_crypto_enabled = false (safe default). Flip to \"true\" to go live.");
}

main().catch(console.error).finally(() => pool.end());
