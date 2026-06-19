#!/usr/bin/env tsx
// ============ ALPACA PAPER DAY-TRADE SETUP ============
// One-shot config: turn the Alpaca paper bot into an intraday buy-the-dip / sell-high trader
// across crypto (incl. XRP) and liquid stocks, on a shared $1,000 paper pool. Options OFF.
//
// Run AFTER deploying the matching code (stocks day-trade mode + crypto max-hold + XRP):
//   railway run npx tsx scripts/setup-alpaca-daytrade.ts
//
// Idempotent — safe to re-run. It only writes config; it places no orders itself.

import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// key → value. Each is upserted.
const CONFIG: Record<string, string> = {
  // ── Shared $1K paper pool (stocks + crypto draw from the same budget) ──
  alpaca_account_size: "1000",

  // ── Stocks: intraday buy-the-dip, flatten same day ──
  stocks_enabled: "paper",
  stocks_day_trade: "true",
  stocks_eod_flatten_minutes: "10",       // close everything 10 min before the bell
  stocks_simulated_equity: "1000",
  stocks_risk_per_trade_pct: "2",
  stocks_max_trades_per_day: "10",
  stocks_confidence_threshold: "65",
  stocks_daily_loss_limit_pct: "5",
  // Liquid names only — no penny-stock traps. Tight spreads, real intraday range.
  stocks_focus_symbols: "NVDA,AAPL,TSLA,META,AMZN,GOOGL,MSFT,AMD,AVGO,NFLX",

  // ── Crypto: buy-the-dip 24/7, same-day round-trip (XRP added) ──
  crypto_enabled: "paper",
  crypto_focus_symbols: "BTC/USD,ETH/USD,SOL/USD,AVAX/USD,DOGE/USD,LINK/USD,XRP/USD",
  crypto_max_hold_hours: "12",
  crypto_simulated_equity: "1000",
  crypto_risk_per_trade_pct: "3",
  crypto_confidence_threshold: "65",
  crypto_daily_loss_limit_pct: "10",

  // ── Options: OFF for now ──
  trade_options: "false",
  options_mode: "disabled",
  trading_mode_options: "paper", // mode value is moot while trade_options=false → options_mode=disabled
};

async function main() {
  console.log("Configuring Alpaca paper day-trade test ($1K, options off)...\n");
  for (const [key, value] of Object.entries(CONFIG)) {
    const before = await prisma.agentConfig.findUnique({ where: { key } });
    await prisma.agentConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    const changed = before?.value !== value;
    console.log(`${changed ? "✔" : "·"} ${key} = ${value}${before && changed ? `  (was: ${before.value})` : ""}`);
  }

  // Safety: confirm live crypto stays OFF (we are not enabling real-money crypto here).
  const liveCrypto = await prisma.agentConfig.findUnique({ where: { key: "live_crypto_enabled" } });
  console.log(`\nLive crypto (real $): ${liveCrypto?.value ?? "unset"} — left untouched (paper test only).`);
  console.log("\nDone. Paper stocks + crypto will scan on their crons and trade the $1K shared pool.");
}

main().catch(console.error).finally(() => pool.end());
