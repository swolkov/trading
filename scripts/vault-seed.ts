#!/usr/bin/env tsx
// Seeds the VaultDocument table with all current Obsidian vault files.
// Run once: DATABASE_URL="postgresql://..." npx tsx scripts/vault-seed.ts

import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const VAULT_PATH = path.join(process.env.HOME || "/Users/user", "Desktop/Trading/Trading");

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("DATABASE_URL required");

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  const documents: { path: string; content: string }[] = [];

  function walk(dir: string, prefix: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.name.endsWith(".md")) {
        documents.push({ path: rel, content: fs.readFileSync(full, "utf-8") });
      }
    }
  }

  walk(VAULT_PATH);
  console.log(`Found ${documents.length} vault files to seed`);

  for (const doc of documents) {
    await prisma.vaultDocument.upsert({
      where: { path: doc.path },
      create: { path: doc.path, content: doc.content, updatedBy: "seed" },
      update: { content: doc.content, updatedBy: "seed" },
    });
    console.log(`  ✓ ${doc.path}`);
  }

  console.log(`\nSeeded ${documents.length} vault documents to DB`);
  await prisma.$disconnect();
}

main().catch(console.error);
