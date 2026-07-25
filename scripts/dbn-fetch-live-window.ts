/**
 * Fetch 1-minute ES/NQ bars covering the LIVE TRADING WINDOW (the gap our research data misses).
 *
 * Our cached data/{ES,NQ}_1m.csv stop on 2026-05-21. The live engine's inception is 2026-07-10, so
 * every live trade sits in a window no backtest here can see. This pulls that window so the
 * trend-long validation can be re-run over the period the engine has actually been trading.
 *
 * SAFE BY DEFAULT (same guard as scripts/dbn-fetch-intraday.ts): previews cost and STOPS.
 *   npx tsx scripts/dbn-fetch-live-window.ts        cost preview only — no download, no charge
 *   npx tsx scripts/dbn-fetch-live-window.ts --go   download after the cost has been seen
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const m = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found in .env.local");
  return m[1].trim();
}
const auth = "Basic " + Buffer.from(apiKey() + ":").toString("base64");

const argOf = (k: string, d: string) => (process.argv.find(a => a.startsWith(`--${k}=`))?.split("=")[1]) ?? d;
const UNIVERSE = argOf("syms", "ES,NQ").split(",");
const SCHEMA = "ohlcv-1m";
const START = argOf("start", "2026-05-01");                   // overlaps the cached data for a sanity check
const END = new Date().toISOString().slice(0, 10);            // exclusive — through yesterday
const GO = process.argv.includes("--go");

async function getCost(symbols: string[]): Promise<number> {
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3", symbols: symbols.map(s => `${s}.v.0`).join(","), stype_in: "continuous",
    schema: SCHEMA, start: START, end: END, mode: "historical-streaming",
  });
  const res = await fetch("https://hist.databento.com/v0/metadata.get_cost", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) throw new Error(`get_cost HTTP ${res.status} — ${(await res.text()).slice(0, 160)}`);
  return parseFloat(await res.text());
}
async function fetchBars(sym: string): Promise<string> {
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: SCHEMA,
    start: START, end: END, encoding: "csv", pretty_px: "true", pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 160)}`);
  return res.text();
}

async function main() {
  console.log("\n" + "═".repeat(78));
  console.log(`  DATABENTO — ${SCHEMA}, ${START} → ${END}, symbols: ${UNIVERSE.join(", ")}`);
  console.log("═".repeat(78));
  let cost = NaN;
  try { cost = await getCost(UNIVERSE); } catch (e) { console.log(`  cost preview failed: ${e instanceof Error ? e.message : e}`); }
  console.log(`  metadata.get_cost (usage rate): $${isFinite(cost) ? cost.toFixed(4) : "?"}`);
  console.log(`  ~3 months of L1 sits inside the plan's included 1-year window.`);
  if (!GO) { console.log(`\n  PREVIEW ONLY — nothing downloaded, nothing charged. Re-run with --go.\n` + "═".repeat(78) + "\n"); return; }
  if (isFinite(cost) && cost > 10) { console.error(`\n⛔ Preview cost $${cost.toFixed(2)} above the $10 guard — stopping.\n`); process.exit(1); }

  const dir = new URL(`../${argOf("dir", "data/live-window")}/`, import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  for (const sym of UNIVERSE) {
    try {
      const csv = await fetchBars(sym);
      const n = Math.max(0, csv.trim().split("\n").length - 1);
      if (n < 100) { console.log(`  ${sym}: only ${n} bars — skipped`); continue; }
      fs.writeFileSync(new URL(`./${sym}_1m.csv`, dir), csv);
      const rows = csv.trim().split("\n");
      console.log(`  ${sym}: ${n} 1m bars | first ${rows[1].split(",")[0]} | last ${rows[rows.length - 1].split(",")[0]}`);
    } catch (e) { console.log(`  ${sym}: ERROR — ${e instanceof Error ? e.message : e}`); }
  }
  console.log("═".repeat(78) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
