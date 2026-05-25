/**
 * Databento DAILY multi-market fetcher — for the trend-following test (the real futures edge).
 * Pulls ~15yr of daily OHLCV across a diversified basket (equities, rates, FX, energy, metals, ags).
 * Daily bars are tiny → cheap. Output → data/daily/<SYM>_1d.csv (gitignored).
 *   npx tsx scripts/dbn-fetch-daily.ts [years]      (default 15)
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found");
  return m[1].trim();
}

// Diversified CME-group basket (all on GLBX.MDP3). Trend-following's power IS this diversification.
const MARKETS = [
  "ES", "NQ", "RTY", "YM",                 // equity indices
  "ZB", "ZN", "ZF", "ZT",                  // rates
  "6E", "6J", "6B", "6A", "6C", "6S",      // FX
  "CL", "NG", "RB", "HO",                  // energy
  "GC", "SI", "HG", "PL",                  // metals
  "ZC", "ZS", "ZW", "ZL", "ZM",            // grains
  "LE", "HE",                              // meats
];

const years = parseInt(process.argv[2] || "15", 10);
const end = new Date(Date.now() - 4 * 86_400_000);
const start = new Date(end.getTime() - years * 365 * 86_400_000);
const auth = "Basic " + Buffer.from(apiKey() + ":").toString("base64");

async function fetchBars(symbol: string): Promise<string> {
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3", symbols: symbol + ".v.0", stype_in: "continuous",
    schema: "ohlcv-1d", start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    encoding: "csv", pretty_px: "true", pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 120)}`);
  return res.text();
}

async function main() {
  const dir = new URL("../data/daily/", import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Fetching ${years}yr daily (${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}) for ${MARKETS.length} markets\n`);
  let ok = 0;
  const BATCH = 6; // concurrent requests (fast, but gentle on the API)
  for (let i = 0; i < MARKETS.length; i += BATCH) {
    await Promise.all(MARKETS.slice(i, i + BATCH).map(async (sym) => {
      try {
        const csv = await fetchBars(sym);
        const n = Math.max(0, csv.trim().split("\n").length - 1);
        if (n < 100) { console.log(`  ${sym.padEnd(4)}: only ${n} bars — skipped`); return; }
        fs.writeFileSync(new URL(`./${sym}_1d.csv`, dir), csv);
        console.log(`  ${sym.padEnd(4)}: ${String(n).padStart(5)} daily bars`);
        ok++;
      } catch (e) { console.log(`  ${sym.padEnd(4)}: ERROR — ${e instanceof Error ? e.message : e}`); }
    }));
  }
  console.log(`\nDone — ${ok}/${MARKETS.length} markets cached to data/daily/. (Daily OHLCV ≈ cents of credit.)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
