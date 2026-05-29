#!/usr/bin/env npx tsx
// One-time script: enable Alpaca crypto spot trading (paper mode) + fix live futures risk config.
// Run: npx tsx scripts/enable-crypto-spot.ts

import pg from "pg";
import fs from "node:fs";

// Load .env.local into process.env
try {
  for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* no .env.local */ }

const DATABASE_URL = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "";
if (!DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

async function upsert(client: pg.Client, key: string, value: string) {
  await client.query(
    `INSERT INTO "AgentConfig" (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
  console.log(`  SET ${key} = ${value}`);
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log("=== Enabling Alpaca crypto spot (paper mode) ===");
  await upsert(client, "crypto_enabled", "paper");
  await upsert(client, "crypto_risk_per_trade_pct", "3");
  await upsert(client, "crypto_daily_loss_limit_pct", "10");
  await upsert(client, "crypto_max_positions", "2");
  await upsert(client, "crypto_max_trades_per_day", "6");
  await upsert(client, "crypto_confidence_threshold", "75");
  await upsert(client, "crypto_simulated_equity", "1000");
  await upsert(client, "crypto_focus_symbols", "BTC/USD,ETH/USD");

  console.log("\n=== Fixing live futures risk config ===");
  await upsert(client, "live_futures_risk_per_trade_pct", "5");
  await upsert(client, "live_futures_daily_loss_limit_pct", "15");
  await upsert(client, "live_futures_max_drawdown_pct", "20");
  await upsert(client, "live_futures_max_contracts", "2");
  await upsert(client, "live_futures_max_total_contracts", "2");
  await upsert(client, "live_futures_max_trades_per_day", "6");
  await upsert(client, "live_futures_max_positions", "2");

  console.log("\n✓ Done. Crypto activates on next cron run (every 15 min).");
  console.log("✓ Live futures risk config updated — engine picks up within 5 min.");

  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
