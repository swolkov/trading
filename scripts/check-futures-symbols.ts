#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const keys = await prisma.agentConfig.findMany({
    where: { key: { contains: "symbol" } },
    orderBy: { key: "asc" },
  });
  for (const k of keys) console.log(`  ${k.key.padEnd(45)} = ${k.value}`);
}
main().catch(console.error).finally(() => pool.end());
