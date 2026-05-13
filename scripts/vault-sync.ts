#!/usr/bin/env tsx
// ============ OBSIDIAN VAULT SYNC ============
// Pulls vault documents from the production DB and writes them to local Obsidian files.
// Also pushes local Obsidian edits back to DB.
// Usage: npx tsx scripts/vault-sync.ts
// Auto-runs via macOS launchd every 5 minutes.

import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const VAULT_PATH = path.join(process.env.HOME || "/Users/user", "Desktop/Trading/Trading");
const SYNC_STATE_FILE = path.join(VAULT_PATH, ".sync-state.json");

interface SyncState {
  lastSync: string;
  localHashes: Record<string, string>; // path → content hash
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}

function loadSyncState(): SyncState {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf-8"));
  } catch {
    return { lastSync: "2020-01-01T00:00:00Z", localHashes: {} };
  }
}

function saveSyncState(state: SyncState) {
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

function createPrisma() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL or POSTGRES_URL required. Source .env.local first.");
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

async function main() {
  const prisma = createPrisma();
  const state = loadSyncState();
  const mode = process.argv[2] || "both";

  console.log(`=== Vault Sync (${mode}) ===`);
  console.log(`Vault: ${VAULT_PATH}`);

  let pulled = 0;
  let pushed = 0;

  // ── PULL: DB → Obsidian ──
  if (mode === "pull" || mode === "both") {
    const docs = await prisma.vaultDocument.findMany({
      where: { updatedAt: { gte: new Date(state.lastSync) } },
      orderBy: { updatedAt: "desc" },
    });

    for (const doc of docs) {
      const filePath = path.join(VAULT_PATH, doc.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Only overwrite if DB version is newer than what we last pushed
      const localHash = state.localHashes[doc.path];
      const dbHash = simpleHash(doc.content);
      if (localHash !== dbHash) {
        fs.writeFileSync(filePath, doc.content, "utf-8");
        state.localHashes[doc.path] = dbHash;
        console.log(`  ↓ ${doc.path} (by ${doc.updatedBy})`);
        pulled++;
      }
    }
    console.log(`[pull] ${pulled} files updated in Obsidian`);
  }

  // ── PUSH: Obsidian → DB ──
  if (mode === "push" || mode === "both") {
    function walk(dir: string, prefix: string = ""): { path: string; content: string }[] {
      const results: { path: string; content: string }[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          results.push(...walk(full, rel));
        } else if (entry.name.endsWith(".md")) {
          results.push({ path: rel, content: fs.readFileSync(full, "utf-8") });
        }
      }
      return results;
    }

    const localFiles = walk(VAULT_PATH);

    for (const file of localFiles) {
      const currentHash = simpleHash(file.content);
      const lastHash = state.localHashes[file.path];

      // Only push if local file changed since last sync
      if (currentHash !== lastHash) {
        await prisma.vaultDocument.upsert({
          where: { path: file.path },
          create: { path: file.path, content: file.content, updatedBy: "obsidian-local" },
          update: { content: file.content, updatedBy: "obsidian-local" },
        });
        state.localHashes[file.path] = currentHash;
        console.log(`  ↑ ${file.path}`);
        pushed++;
      }
    }
    console.log(`[push] ${pushed} files synced to DB`);
  }

  state.lastSync = new Date().toISOString();
  saveSyncState(state);
  await prisma.$disconnect();
  console.log(`=== Done: ${pulled} pulled, ${pushed} pushed ===`);
}

main().catch(console.error);
