/**
 * Databento historical fetcher — pulls + caches CME 1-minute OHLCV bars for the
 * backtester. Reusable, read-only against Databento (draws from your $125 credit;
 * OHLCV is tiny/cheap). Output → data/<SYM>_1m.csv (gitignored).
 *
 * Run:  npx tsx scripts/dbn-fetch.ts [days]      (default 30)
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found in env or .env.local");
  return m[1].trim();
}

const SYMBOLS = ["ES.v.0", "NQ.v.0", "GC.v.0"]; // continuous most-active contract (volume roll — best for backtesting)
const days = parseInt(process.argv[2] || "30", 10);
// Databento locks the most recent ~few days behind the live subscription; older data is
// pay-as-you-go. End the window safely in the past — fine for backtesting (we want history).
const end = new Date(Date.now() - 4 * 86_400_000);
const start = new Date(end.getTime() - days * 86_400_000);
const KEY = apiKey();
const auth = "Basic " + Buffer.from(KEY + ":").toString("base64");

async function fetchBars(symbol: string): Promise<string> {
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3",
    symbols: symbol,
    stype_in: "continuous",
    schema: "ohlcv-1m",
    start: start.toISOString().slice(0, 19),
    end: end.toISOString().slice(0, 19),
    encoding: "csv",
    pretty_px: "true",
    pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

async function main() {
  const dir = new URL("../data/", import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Fetching ${days}d of 1m bars (${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}) for ${SYMBOLS.join(", ")}\n`);

  for (const sym of SYMBOLS) {
    try {
      const csv = await fetchBars(sym);
      const rows = csv.trim().split("\n");
      const n = Math.max(0, rows.length - 1); // minus header
      const base = sym.split(".")[0];
      fs.writeFileSync(new URL(`./${base}_1m.csv`, dir), csv);
      const first = rows[1]?.split(",")[0] || "?";
      const last = rows[rows.length - 1]?.split(",")[0] || "?";
      console.log(`  ${base.padEnd(3)}: ${String(n).padStart(6)} bars  ${first.slice(0, 16)} → ${last.slice(0, 16)}  → data/${base}_1m.csv`);
    } catch (e) {
      console.log(`  ${sym}: ERROR — ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("\nDone. (OHLCV is ~cents of credit; check usage at databento.com/portal)");
}
main().catch((e) => { console.error(e); process.exit(1); });
