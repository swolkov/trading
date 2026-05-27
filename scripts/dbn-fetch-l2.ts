/**
 * Databento BBO fetcher — sampled top-of-book (bbo-1s: bid/ask price + SIZE every second) for the
 * microstructure-edge test: does order-book imbalance predict short-horizon drift at a MINUTES scale
 * (the small-size frontier where a $1K micro trader can actually execute)?  Light + within the plan window.
 *   npx tsx scripts/dbn-fetch-l2.ts          cost preview only (no download)
 *   npx tsx scripts/dbn-fetch-l2.ts --go     download → data/l2/<SYM>_bbo1s.csv
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const m = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found");
  return m[1].trim();
}
const auth = "Basic " + Buffer.from(apiKey() + ":").toString("base64");
const SYMBOLS = ["ES", "NQ"];          // most-liquid index futures; micros (MES/MNQ) are retail-executable
const SCHEMA = "bbo-1s";
const GO = process.argv.includes("--go");
const day = (d: Date) => d.toISOString().slice(0, 10);
const end = new Date(Date.now() - 2 * 86_400_000);
const start = new Date(end.getTime() - 7 * 86_400_000);   // ~7 days — a tractable first slice

async function getCost(symbols: string[]): Promise<number> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: symbols.map(s => `${s}.v.0`).join(","), stype_in: "continuous", schema: SCHEMA, start: day(start), end: day(end), mode: "historical-streaming" });
  const r = await fetch("https://hist.databento.com/v0/metadata.get_cost", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  return r.ok ? parseFloat(await r.text()) : NaN;
}
async function fetchData(sym: string): Promise<string> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: SCHEMA, start: day(start), end: day(end), encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 160)}`);
  return r.text();
}

async function main() {
  console.log(`\n  DATABENTO BBO — ${SCHEMA}, ${day(start)} → ${day(end)}, ${SYMBOLS.join(",")}`);
  let cost = NaN;
  try { cost = await getCost(SYMBOLS); } catch (e) { console.log(`  cost preview failed: ${e instanceof Error ? e.message : e}`); }
  console.log(`  metadata.get_cost (usage-rate): $${isFinite(cost) ? cost.toFixed(2) : "?"} — within the plan window this should be ~covered`);
  if (!GO) { console.log(`  PREVIEW ONLY — re-run with --go to download.\n`); return; }
  if (isFinite(cost) && cost > 25) { console.error(`\n⛔ cost $${cost.toFixed(2)} higher than expected — aborting (re-check entitlement).\n`); process.exit(1); }
  const dir = new URL("../data/l2/", import.meta.url); fs.mkdirSync(dir, { recursive: true });
  for (const sym of SYMBOLS) {
    try { const csv = await fetchData(sym); const n = csv.trim().split("\n").length - 1; fs.writeFileSync(new URL(`./${sym}_bbo1s.csv`, dir), csv); console.log(`  ${sym}: ${n.toLocaleString()} rows → data/l2/${sym}_bbo1s.csv`); }
    catch (e) { console.log(`  ${sym}: ERROR — ${e instanceof Error ? e.message : e}`); }
  }
  console.log("");
}
main().catch(e => { console.error(e); process.exit(1); });
