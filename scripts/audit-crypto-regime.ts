#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const url = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  // What is the alpaca_account_size? This overrides crypto confidence threshold to 65
  const keys = await prisma.agentConfig.findMany({
    where: { key: { in: ["alpaca_account_size", "crypto_confidence_threshold", "crypto_enabled", "crypto_focus_symbols"] } }
  });
  console.log("=== CRYPTO KEY CONFIG ===");
  for (const k of keys) console.log(`  ${k.key} = ${k.value}`);

  // Current crypto regime from vault
  const vaultDoc = await prisma.vaultDocument.findFirst({ where: { path: { contains: "crypto-regime" } } });
  if (vaultDoc) {
    console.log("\n=== CRYPTO REGIME (vault) ===");
    console.log(vaultDoc.content?.slice(0, 400));
  }
}

main().catch(console.error).finally(() => pool.end());
