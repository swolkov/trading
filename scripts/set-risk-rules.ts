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
  // LIVE ($1K real money) — DISCIPLINED GROWTH: only A+ AI-graded setups, bounded risk + hard ruin limits.
  live_futures_symbols: "MES,MNQ",        // NOT MGC on $1K: gold is $10/pt × ~7-15pt stop = $75-150 risk > the 5%=$50 budget → can't size without breaking limits. The gold edge is traded on the $50K DEMO (GC), where capital fits.
  live_futures_max_contracts: "1",        // 1 micro per trade
  live_futures_max_total_contracts: "1",  // no pyramiding
  live_futures_max_trades_per_day: "3",   // selective — only the best setups, capped at 3/day
  live_futures_max_positions: "1",        // one at a time (correlation gate blocks doubling the index bet)
  live_futures_risk_per_trade_pct: "5",   // 1 micro ≈ 5% of $1K
  live_futures_daily_loss_limit_pct: "12",// hard stop ~$120/day → a bad day can't compound
  live_futures_max_drawdown_pct: "20",    // KILL SWITCH at -20% ($800 floor) — ruin protection
  live_futures_simulated_equity: "0",     // real $1K
  live_futures_databento_md: "true",      // real-time Databento feed
  // DEMO ($50K paper) — AGGRESSIVE RESEARCH MODE: trade often + broad so we generate edge-discovery
  // data fast. This is the learning sandbox (fake money) — frequency + variety matter, not capital discipline.
  futures_risk_per_trade_pct: "5",        // bigger size (2% → 5%); paper, so swings are fine
  futures_max_contracts: "10",            // up from 3
  futures_max_total_contracts: "15",      // up from 4 — allow real pyramiding
  futures_max_trades_per_day: "50",       // up from 20 — more samples per day
  futures_daily_loss_limit_pct: "12",     // up from 3 — don't stop early; let it run to learn
  futures_max_drawdown_pct: "25",         // up from 15
  futures_max_positions: "5",             // up from 3
  futures_simulated_equity: "0",          // use the REAL $50K paper balance
  futures_databento_md: "true",           // real-time Databento feed (same as live)
  futures_ai_grader: "false",             // DEMO ONLY: AI-on/off experiment — take the pure MECHANICAL setups, log what the AI would've said. (Live ALWAYS keeps the AI veto via the IS_LIVE guard in the engine.)
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
