/**
 * Flip the Databento live MD feed on/off per engine — NO restart (engine reloads config every 5 min).
 *   npx tsx scripts/set-databento-md.ts demo     → demo engine uses Databento (live_quotes)
 *   npx tsx scripts/set-databento-md.ts live     → live engine uses Databento
 *   npx tsx scripts/set-databento-md.ts both     → both
 *   npx tsx scripts/set-databento-md.ts off      → both back to Tradovate→Yahoo
 * Reader is fail-safe: stale/missing live_quotes → falls back to the existing chain regardless.
 */
import fs from "node:fs";

const arg = (process.argv[2] || "").toLowerCase();
const map: Record<string, Record<string, string>> = {
  demo: { futures_databento_md: "true" },
  live: { live_futures_databento_md: "true" },
  both: { futures_databento_md: "true", live_futures_databento_md: "true" },
  off: { futures_databento_md: "false", live_futures_databento_md: "false" },
};
if (!map[arg]) { console.error("usage: set-databento-md.ts demo|live|both|off"); process.exit(1); }

async function main() {
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABASE_URL=(.+)$/m);
  if (!m) throw new Error("DATABASE_URL not found");
  process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, "");
  const { Client } = await import("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (const [k, v] of Object.entries(map[arg])) {
    await c.query('INSERT INTO "AgentConfig"(key, value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [k, v]);
    console.log(`  ${k} = ${v}`);
  }
  await c.end();
  console.log(`\n✅ Databento MD '${arg}' written. Engines apply within 5 min (no restart). Reverse: set-databento-md.ts off`);
}
main().catch((e) => { console.error(e); process.exit(1); });
