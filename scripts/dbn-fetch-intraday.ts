/**
 * Databento INTRADAY fetcher — maximize the Standard subscription's INCLUDED entitlements.
 * Standard includes 1yr of L1 history + 1mo of L2/L3 at ZERO marginal cost; beyond bills $/GB.
 * So we pull 1yr of 1-minute bars for the full spread-leg + index universe (free under the plan),
 * massively expanding intraday research (today we only have 3yr 1m for ES/NQ/GC).
 *
 * SAFE BY DEFAULT: previews cost via metadata.get_cost and STOPS. Add --go to actually download.
 * Window guard refuses >1yr (L1) unless --allow-usage, so we never trip surprise $/GB charges.
 *   npx tsx scripts/dbn-fetch-intraday.ts            (cost preview only — no download, no charge)
 *   npx tsx scripts/dbn-fetch-intraday.ts --go       (download after you've seen the cost)
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const m = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found in .env.local");
  return m[1].trim();
}
const auth = "Basic " + Buffer.from(apiKey() + ":").toString("base64");

// Spread-leg book (priority #1) + indices. 1yr 1m = included in Standard → free.
const UNIVERSE = ["CL", "RB", "HO", "ZC", "ZS", "ZW", "6E", "6B", "6A", "6C", "GC", "HG", "ES", "NQ"];
const GO = process.argv.includes("--go");
const ALLOW_USAGE = process.argv.includes("--allow-usage");
const years = parseInt(process.argv.find(a => /^\d+$/.test(a)) || "1", 10);
if (years > 1 && !ALLOW_USAGE) { console.error(`\n⛔ ${years}yr of L1 exceeds the included 1yr window → would bill $/GB. Re-run with --allow-usage to override.\n`); process.exit(1); }

const end = new Date(Date.now() - 2 * 86_400_000);
const start = new Date(end.getTime() - years * 365 * 86_400_000);
const day = (d: Date) => d.toISOString().slice(0, 10);
const SCHEMA = "ohlcv-1m";

async function getCost(symbols: string[]): Promise<number> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: symbols.map(s => `${s}.v.0`).join(","), stype_in: "continuous", schema: SCHEMA, start: day(start), end: day(end), mode: "historical-streaming" });
  const res = await fetch("https://hist.databento.com/v0/metadata.get_cost", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`get_cost HTTP ${res.status} — ${(await res.text()).slice(0, 160)}`);
  return parseFloat(await res.text());
}
async function fetchBars(sym: string): Promise<string> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: SCHEMA, start: day(start), end: day(end), encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 120)}`);
  return res.text();
}

async function main() {
  console.log("\n" + "═".repeat(80));
  console.log(`  DATABENTO INTRADAY — ${SCHEMA}, ${years}yr (${day(start)} → ${day(end)}), ${UNIVERSE.length} symbols`);
  console.log("═".repeat(80));
  // 1) COST PREVIEW (the usage-rate $/GB cost; INCLUDED-window data should net to ~$0 under Standard)
  let cost = NaN;
  try { cost = await getCost(UNIVERSE); } catch (e) { console.log(`  cost preview failed: ${e instanceof Error ? e.message : e}`); }
  console.log(`  metadata.get_cost (usage-rate): $${isFinite(cost) ? cost.toFixed(2) : "?"}`);
  console.log(`  → within the included 1yr-L1 window this should be COVERED by the $179 plan (usage rate shown for reference).`);
  if (!GO) { console.log(`\n  PREVIEW ONLY — no download, no charge. Re-run with --go to fetch.\n` + "═".repeat(80) + "\n"); return; }
  if (isFinite(cost) && cost > 50 && !ALLOW_USAGE) { console.error(`\n⛔ Preview cost $${cost.toFixed(2)} is high — pass --allow-usage to proceed (guards against surprise $/GB).\n`); process.exit(1); }

  // 2) DOWNLOAD → data/intraday/<SYM>_1m.csv
  const dir = new URL("../data/intraday/", import.meta.url); fs.mkdirSync(dir, { recursive: true });
  let ok = 0; const BATCH = 4;
  for (let i = 0; i < UNIVERSE.length; i += BATCH) {
    await Promise.all(UNIVERSE.slice(i, i + BATCH).map(async (sym) => {
      try { const csv = await fetchBars(sym); const n = Math.max(0, csv.trim().split("\n").length - 1); if (n < 100) { console.log(`  ${sym.padEnd(4)}: only ${n} bars — skipped`); return; } fs.writeFileSync(new URL(`./${sym}_1m.csv`, dir), csv); console.log(`  ${sym.padEnd(4)}: ${String(n).padStart(7)} 1m bars`); ok++; }
      catch (e) { console.log(`  ${sym.padEnd(4)}: ERROR — ${e instanceof Error ? e.message : e}`); }
    }));
  }
  console.log(`\n  Done — ${ok}/${UNIVERSE.length} → data/intraday/. Feeds paper-forward (intraday) + execution-realism + canonical layer.`);
  console.log("═".repeat(80) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
