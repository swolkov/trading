/**
 * Fetch the DEFERRED-month continuous (.v.1) daily bars for the calendar-spread test.
 * We already have front-month (.v.0). Calendar spread = front − deferred (same commodity, 2 months).
 * These margin cheaply (SPAN calendar credit ~90%) → they fit small accounts. → data/daily/<SYM>_v1_1d.csv
 *   npx tsx scripts/dbn-fetch-deferred.ts
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const m = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found"); return m[1].trim();
}
const auth = "Basic " + Buffer.from(apiKey() + ":").toString("base64");
const SYMS = ["CL", "NG", "RB", "HO", "ZC", "ZS", "ZW", "HG", "GC"];   // commodities with real term structure
const end = new Date(Date.now() - 4 * 86_400_000), start = new Date(end.getTime() - 15 * 365 * 86_400_000);
const day = (d: Date) => d.toISOString().slice(0, 10);

async function fetchBars(sym: string): Promise<string> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.1`, stype_in: "continuous", schema: "ohlcv-1d", start: day(start), end: day(end), encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 120)}`);
  return r.text();
}
async function main() {
  const dir = new URL("../data/daily/", import.meta.url); let ok = 0;
  for (const sym of SYMS) {
    try { const csv = await fetchBars(sym); const n = csv.trim().split("\n").length - 1; if (n > 200) { fs.writeFileSync(new URL(`${sym}_v1_1d.csv`, dir), csv); console.log(`  ${sym.padEnd(4)} ${n} deferred bars`); ok++; } else console.log(`  ${sym.padEnd(4)} only ${n}`); }
    catch (e) { console.log(`  ${sym.padEnd(4)} ERROR — ${e instanceof Error ? e.message : e}`); }
  }
  console.log(`\n  ${ok}/${SYMS.length} deferred-month series → data/daily/`);
}
main();
