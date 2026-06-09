#!/usr/bin/env tsx
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const current = await prisma.agentConfig.findUnique({ where: { key: "futures_symbols" } });
  console.log("Current demo futures_symbols:", current?.value);

  if (!current) { console.log("Key not found"); return; }

  const symbols = current.value.split(",").map(s => s.trim());
  if (symbols.includes("MBT")) {
    console.log("MBT already in list — nothing to do");
    return;
  }

  const updated = [...symbols, "MBT"].join(",");
  await prisma.agentConfig.update({ where: { key: "futures_symbols" }, data: { value: updated } });
  console.log("Updated demo futures_symbols:", updated);
}
main().catch(console.error).finally(() => pool.end());
