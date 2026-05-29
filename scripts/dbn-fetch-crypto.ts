/**
 * Databento historical fetcher — CRYPTO FUTURES variant.
 * Pulls CME crypto micros (MBT, MET, BFF, ETF) from GLBX.MDP3 for backtesting.
 *
 * Run:  npx tsx scripts/dbn-fetch-crypto.ts [days]      (default 365 for MBT/MET, all-available for BFF/ETF)
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found in env or .env.local");
  return m[1].trim();
}

// Per-symbol start dates — newer contracts have less history available
const SYMBOLS: Array<{ sym: string; earliestStart: string; description: string }> = [
  { sym: "MBT.v.0", earliestStart: "2021-05-03", description: "Micro Bitcoin (0.1 BTC, monthly)" },
  { sym: "MET.v.0", earliestStart: "2021-12-06", description: "Micro Ether (0.1 ETH, monthly)" },
  { sym: "BFF.v.0", earliestStart: "2024-09-30", description: "Bitcoin Friday weekly (0.01 BTC)" },
];

const days = parseInt(process.argv[2] || "365", 10);
// Databento locks the most recent ~few days behind the live subscription
const end = new Date(Date.now() - 4 * 86_400_000);

const KEY = apiKey();
const auth = "Basic " + Buffer.from(KEY + ":").toString("base64");

async function fetchBars(symbol: string, start: Date, endD: Date): Promise<string> {
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3",
    symbols: symbol,
    stype_in: "continuous",
    schema: "ohlcv-1m",
    start: start.toISOString().slice(0, 19),
    end: endD.toISOString().slice(0, 19),
    encoding: "csv",
    pretty_px: "true",
    pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  return res.text();
}

async function main() {
  const dir = new URL("../data/", import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\nFetching CME crypto futures (ohlcv-1m, GLBX.MDP3)`);
  console.log(`Window: requesting up to ${days}d, ending ${end.toISOString().slice(0, 10)}\n`);

  for (const { sym, earliestStart, description } of SYMBOLS) {
    const earliestDate = new Date(earliestStart);
    const requestedStart = new Date(end.getTime() - days * 86_400_000);
    const start = requestedStart < earliestDate ? earliestDate : requestedStart;
    const base = sym.split(".")[0];
    try {
      const csv = await fetchBars(sym, start, end);
      const rows = csv.trim().split("\n");
      const n = Math.max(0, rows.length - 1);
      fs.writeFileSync(new URL(`./${base}_1m.csv`, dir), csv);
      const first = rows[1]?.split(",")[0] || "?";
      const last = rows[rows.length - 1]?.split(",")[0] || "?";
      console.log(`  ${base.padEnd(4)} ${description.padEnd(38)} ${String(n).padStart(7)} bars  ${first.slice(0, 10)} → ${last.slice(0, 10)}`);
    } catch (e) {
      console.log(`  ${base.padEnd(4)} ${description.padEnd(38)} ERROR — ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    }
  }
  console.log(`\nDone. CSVs in data/. (OHLCV is cheap — check usage at databento.com/portal)\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
