/**
 * ⚠️ GAMBLE MODE (LIVE $1K) — the user's explicit, informed choice: swing for $10k (10×).
 * This is NOT a strategy. Honest odds: ~10% reach $10k, ~90% lose the $1K. Negative expected value.
 * Bold play (few big bets) maximizes the reach-target-before-ruin probability + minimizes cost drag.
 * Capped at ~90% drawdown so a leveraged gap can't push the account NEGATIVE (no debt beyond the $1K).
 * REVERT to the sane/real config any time:  npx tsx scripts/set-risk-rules.ts
 *   npx tsx scripts/set-gamble-mode.ts          (writes; engine reloads in ~5 min)
 *   npx tsx scripts/set-gamble-mode.ts --dry     (preview)
 */
import fs from "node:fs";

const GAMBLE: Record<string, string> = {
  live_futures_symbols: "MES,MNQ",        // liquid micros (only thing $1K can margin)
  live_futures_risk_per_trade_pct: "50",  // bold: half the account per bet
  live_futures_max_contracts: "10",
  live_futures_max_total_contracts: "10",
  live_futures_max_trades_per_day: "5",   // FEW big bets, not many small ones (less cost drag → better lottery odds)
  live_futures_max_positions: "2",
  live_futures_daily_loss_limit_pct: "90",// ride it — but
  live_futures_max_drawdown_pct: "90",    // KILL at -90% (~$100 left) so a gap can't go NEGATIVE / into debt
  live_futures_simulated_equity: "0",
  live_futures_databento_md: "true",
};

async function main() {
  const dry = process.argv.includes("--dry");
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABASE_URL=(.+)$/m); if (!m) throw new Error("DATABASE_URL not found");
  process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, "");
  const { Client } = await import("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const keys = Object.keys(GAMBLE);
  const before = await c.query('SELECT key, value FROM "AgentConfig" WHERE key = ANY($1)', [keys]);
  const cur: Record<string, string> = {}; before.rows.forEach((r: { key: string; value: string }) => (cur[r.key] = r.value));
  console.log(`\n  ⚠️ GAMBLE MODE (LIVE $1K) ${dry ? "(DRY)" : "→ WRITING"} — ~10% to $10k, ~90% lose it`);
  for (const k of keys) console.log(`    ${k.padEnd(34)} ${(cur[k] ?? "(unset)").padStart(8)} → ${GAMBLE[k]}`);
  if (!dry) { for (const [key, value] of Object.entries(GAMBLE)) await c.query('INSERT INTO "AgentConfig"(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [key, value]); console.log("\n  ✅ LIVE is in GAMBLE MODE. Reloads in ~5 min. REVERT: npx tsx scripts/set-risk-rules.ts"); }
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
