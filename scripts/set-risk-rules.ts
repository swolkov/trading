/**
 * Set the canonical risk rules in the DB (AgentConfig). The engines reload these every 5 min.
 * Evidence-based (3yr backtest): >1% risk/trade destroys thin edges via sequence risk;
 * 1% is the professional ceiling. Live $1K at 1% = $10 budget, which no micro fits → live
 * correctly stops trading (it has no edge anyway). Demo $50K at 1% = $500 = realistic, fundable.
 *   npx tsx scripts/set-risk-rules.ts          (shows before→after, writes)
 *   npx tsx scripts/set-risk-rules.ts --dry     (preview only)
 */
import fs from "node:fs";

const RULES: Record<string, string> = {
  // LIVE ($1K real money) — PHASE 0 DAY 1: MES only, ONE trade, ONE contract. Prove the chain, then inspect.
  live_futures_symbols: "MES",            // day-1 restricted to the single most-liquid micro
  live_futures_max_contracts: "1",        // hard cap qty = 1 contract
  live_futures_max_total_contracts: "1",  // belt-and-suspenders: no scaling/pyramid past 1
  live_futures_max_trades_per_day: "1",   // ONE live trade total, then stop for the day
  live_futures_max_positions: "1",        // one position at a time
  live_futures_risk_per_trade_pct: "5",   // 5% of $1K = $50 budget → exactly 1 micro fits (1% = $10 fits none)
  live_futures_daily_loss_limit_pct: "8", // guard (~$80); largely moot at 1 trade/day
  live_futures_max_drawdown_pct: "15",
  live_futures_simulated_equity: "0",     // use the REAL $1K
  // DEMO ($50K paper) — futures_* keys (unchanged: demo keeps trading broad for research)
  futures_risk_per_trade_pct: "2",
  futures_daily_loss_limit_pct: "3",
  futures_max_drawdown_pct: "15",
  futures_max_positions: "3",
  futures_simulated_equity: "0",         // use the REAL $50K (1% = $500) — retire the old "simulate $1K" so demo trades at fundable scale
};

async function main() {
  const dry = process.argv.includes("--dry");
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABASE_URL=(.+)$/m);
  if (!m) throw new Error("DATABASE_URL not found in .env.local");
  process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, "");

  const { Client } = await import("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const keys = Object.keys(RULES);
  const before = await c.query('SELECT key, value FROM "AgentConfig" WHERE key = ANY($1)', [keys]);
  const cur: Record<string, string> = {};
  before.rows.forEach((r: { key: string; value: string }) => (cur[r.key] = r.value));

  console.log(`\nRISK RULES ${dry ? "(DRY RUN)" : "→ writing to DB"}:\n  ${"key".padEnd(38)} ${"current".padStart(8)}   new`);
  for (const k of keys) console.log(`  ${k.padEnd(38)} ${(cur[k] ?? "(unset)").padStart(8)} → ${RULES[k]}`);

  if (!dry) {
    for (const [key, value] of Object.entries(RULES))
      await c.query('INSERT INTO "AgentConfig"(key, value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [key, value]);
    console.log("\n✅ Written. Engines reload within 5 min. (Reversible: edit RULES + re-run.)");
  }
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
