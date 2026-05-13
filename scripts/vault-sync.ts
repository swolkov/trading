#!/usr/bin/env tsx
// ============ OBSIDIAN VAULT SYNC SCRIPT ============
// Runs locally on your machine. Syncs DB vault ↔ Obsidian files.
// Usage: npx tsx scripts/vault-sync.ts
// Or set up as a cron: */5 * * * * cd ~/trading && npx tsx scripts/vault-sync.ts

import * as fs from "fs";
import * as path from "path";

const VAULT_PATH = path.join(process.env.HOME || "/Users/user", "Desktop/Trading/Trading");
const API_BASE = process.env.TRADING_API_URL || "https://trading-production-d0f0.up.railway.app";
const CRON_SECRET = process.env.CRON_SECRET || "";
const SYNC_STATE_FILE = path.join(VAULT_PATH, ".sync-state.json");

interface SyncState {
  lastSync: string;
}

function loadSyncState(): SyncState {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf-8"));
  } catch {
    return { lastSync: "2020-01-01T00:00:00Z" };
  }
}

function saveSyncState(state: SyncState) {
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

async function pullFromDB() {
  const state = loadSyncState();
  console.log(`[pull] Fetching docs updated since ${state.lastSync}...`);

  const res = await fetch(`${API_BASE}/api/vault/sync?since=${encodeURIComponent(state.lastSync)}`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });

  if (!res.ok) {
    console.error(`[pull] Failed: ${res.status} ${await res.text()}`);
    return;
  }

  const data = await res.json();
  console.log(`[pull] Got ${data.count} updated documents`);

  for (const doc of data.documents) {
    const filePath = path.join(VAULT_PATH, doc.path);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, doc.content, "utf-8");
    console.log(`  ✓ ${doc.path} (by ${doc.updatedBy})`);
  }

  saveSyncState({ lastSync: new Date().toISOString() });
  console.log(`[pull] Done. ${data.count} files synced to Obsidian.`);
}

async function pushToDB() {
  console.log(`[push] Scanning vault for local changes...`);

  const documents: { path: string; content: string }[] = [];

  function walk(dir: string, prefix: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip hidden files
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.name.endsWith(".md")) {
        const content = fs.readFileSync(full, "utf-8");
        documents.push({ path: rel, content });
      }
    }
  }

  walk(VAULT_PATH);
  console.log(`[push] Found ${documents.length} markdown files`);

  if (documents.length === 0) return;

  // Push in batches of 20
  for (let i = 0; i < documents.length; i += 20) {
    const batch = documents.slice(i, i + 20);
    const res = await fetch(`${API_BASE}/api/vault/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify({ documents: batch }),
    });

    if (!res.ok) {
      console.error(`[push] Failed batch ${i}: ${res.status}`);
      continue;
    }

    const data = await res.json();
    console.log(`[push] Batch ${i / 20 + 1}: ${data.upserted} docs upserted`);
  }

  console.log(`[push] Done. All vault files pushed to DB.`);
}

async function main() {
  const mode = process.argv[2] || "both";

  console.log(`=== Vault Sync (${mode}) ===`);
  console.log(`Vault: ${VAULT_PATH}`);
  console.log(`API: ${API_BASE}`);

  if (mode === "push" || mode === "both") {
    await pushToDB();
  }

  if (mode === "pull" || mode === "both") {
    await pullFromDB();
  }

  console.log("=== Sync complete ===");
}

main().catch(console.error);
