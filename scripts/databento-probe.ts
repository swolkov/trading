/**
 * DATABENTO ACCOUNT PROBE — what can WE actually pull, and what does it cost?
 *
 * Queries the live metadata API with our key: datasets we can access, schemas on GLBX.MDP3,
 * date coverage, per-schema unit prices, and cost previews for the schemas worth adding to the
 * trading brain. Read-only, all free metadata calls (no data is pulled). Run:
 *   npx tsx scripts/databento-probe.ts
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  for (const f of [".env.local", ".env"]) { try { const m = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m); if (m) return m[1].trim(); } catch {} }
  throw new Error("DATABENTO_API_KEY not found");
}
const KEY = apiKey();
const AUTH = "Basic " + Buffer.from(KEY + ":").toString("base64");
const BASE = "https://hist.databento.com/v0";
const DS = "GLBX.MDP3";

async function getJson(method: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}/${method}${qs ? "?" + qs : ""}`, { headers: { Authorization: AUTH } });
  const txt = await r.text();
  if (!r.ok) return { __error: `HTTP ${r.status}: ${txt.slice(0, 160)}` };
  try { return JSON.parse(txt); } catch { return txt.trim(); }
}
async function postCost(params: Record<string, string>): Promise<number | string> {
  const r = await fetch(`${BASE}/metadata.get_cost`, { method: "POST", headers: { Authorization: AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const txt = await r.text();
  return r.ok ? parseFloat(txt) : `ERR ${r.status}: ${txt.slice(0, 80)}`;
}
const day = (d: Date) => d.toISOString().slice(0, 10);
const W = 100;

async function main() {
  console.log("\n" + "═".repeat(W));
  console.log("  DATABENTO ACCOUNT PROBE — real entitlements & pricing for our key");
  console.log("═".repeat(W));

  // 1) Datasets we can access
  const datasets = await getJson("metadata.list_datasets");
  console.log("\n  DATASETS WE CAN ACCESS:");
  if (Array.isArray(datasets)) datasets.forEach((d: string) => console.log(`     ${d}`));
  else console.log("     " + JSON.stringify(datasets));

  // 2) Date coverage on GLBX.MDP3
  const range = await getJson("metadata.get_dataset_range", { dataset: DS });
  console.log(`\n  ${DS} DATE COVERAGE: ${JSON.stringify(range)}`);

  // 3) Schemas available on GLBX.MDP3
  const schemas = await getJson("metadata.list_schemas", { dataset: DS });
  console.log(`\n  ${DS} SCHEMAS AVAILABLE:`);
  if (Array.isArray(schemas)) console.log("     " + schemas.join(", "));
  else console.log("     " + JSON.stringify(schemas));

  // 4) Unit prices per schema (the $/GB structure → what's cheap)
  const prices = await getJson("metadata.list_unit_prices", { dataset: DS });
  console.log(`\n  ${DS} UNIT PRICES ($/GB by mode/schema):`);
  console.log("     " + JSON.stringify(prices).slice(0, 1200));

  // 5) Cost previews for representative recent pulls (1 trading day, the spread+index legs)
  const end = new Date(Date.now() - 2 * 86_400_000);
  const start = new Date(end.getTime() - 86_400_000);
  const legs = "ES.v.0,NQ.v.0,GC.v.0,CL.v.0,ZC.v.0,6E.v.0";
  console.log(`\n  COST PREVIEW — 1 day (${day(start)}→${day(end)}), 6 symbols, historical-streaming:`);
  for (const schema of ["ohlcv-1d", "ohlcv-1h", "ohlcv-1m", "ohlcv-1s", "tbbo", "trades", "bbo-1s", "mbp-1", "mbp-10", "statistics", "definition"]) {
    const c = await postCost({ dataset: DS, symbols: legs, stype_in: "continuous", schema, start: day(start), end: day(end), mode: "historical-streaming" });
    const tag = typeof c === "number" ? (c === 0 ? "FREE/included" : c < 0.01 ? "~$0 (sub-cent)" : c < 1 ? "cheap" : c < 10 ? "moderate" : "EXPENSIVE") : "";
    console.log(`     ${schema.padEnd(12)} ${typeof c === "number" ? "$" + c.toFixed(4) : c}   ${tag}`);
  }

  // 6) Cost preview — full-history daily across the 30-market basket (what we already pull)
  const yrAgo = new Date(Date.now() - 365 * 86_400_000);
  const cDaily = await postCost({ dataset: DS, symbols: "ES.v.0,NQ.v.0,GC.v.0,CL.v.0,ZC.v.0,ZS.v.0,ZW.v.0,6E.v.0,6B.v.0,HG.v.0,RB.v.0,HO.v.0", stype_in: "continuous", schema: "ohlcv-1d", start: day(yrAgo), end: day(end), mode: "historical-streaming" });
  console.log(`\n  COST — 1yr daily OHLCV, 12 spread/index legs: ${typeof cDaily === "number" ? "$" + cDaily.toFixed(4) : cDaily}`);
  // 7) Cost preview — 1yr statistics (settlement/OI) across same legs (the cheap backtest-quality win)
  const cStats = await postCost({ dataset: DS, symbols: "ES.v.0,NQ.v.0,GC.v.0,CL.v.0,ZC.v.0,ZS.v.0,ZW.v.0,6E.v.0,6B.v.0,HG.v.0,RB.v.0,HO.v.0", stype_in: "continuous", schema: "statistics", start: day(yrAgo), end: day(end), mode: "historical-streaming" });
  console.log(`  COST — 1yr statistics (settle/OI), 12 legs:      ${typeof cStats === "number" ? "$" + cStats.toFixed(4) : cStats}`);

  console.log("\n" + "═".repeat(W) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
