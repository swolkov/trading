/**
 * Pull MXR (micro XRP) + MSL (micro SOL) daily bars from Databento.
 * Contracts launched 2025 — short history; we just want the full available window.
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found");
  return m[1].trim();
}

// Candidate symbols + earliest dates (we'll request a wide window; Databento will return what exists).
const CANDIDATES = [
  { sym: "MXR.v.0", desc: "Micro XRP candidate" },
  { sym: "XRP.v.0", desc: "XRP futures (full size)" },
  { sym: "MSL.v.0", desc: "Micro SOL candidate" },
  { sym: "SOL.v.0", desc: "SOL futures (full size)" },
];

const KEY = apiKey();
const auth = "Basic " + Buffer.from(KEY + ":").toString("base64");
const end = new Date(Date.now() - 1 * 86_400_000); // yesterday
const start = new Date("2024-12-01"); // pre-launch buffer; Databento returns only what exists

async function fetchOhlcv1d(symbol: string): Promise<string> {
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3",
    symbols: symbol,
    stype_in: "continuous",
    schema: "ohlcv-1d",
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
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
  const dir = new URL("../data/daily/", import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Fetching daily bars (${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)})\n`);

  for (const { sym, desc } of CANDIDATES) {
    const base = sym.split(".")[0];
    try {
      const csv = await fetchOhlcv1d(sym);
      const rows = csv.trim().split("\n");
      const n = Math.max(0, rows.length - 1);
      if (n === 0) {
        console.log(`  ${base.padEnd(4)} ${desc.padEnd(28)} no data returned`);
        continue;
      }
      fs.writeFileSync(new URL(`./${base}_1d.csv`, dir), csv);
      const first = rows[1]?.split(",")[0] || "?";
      const last = rows[rows.length - 1]?.split(",")[0] || "?";
      console.log(`  ${base.padEnd(4)} ${desc.padEnd(28)} ${String(n).padStart(4)} bars  ${first.slice(0, 10)} → ${last.slice(0, 10)}`);
    } catch (e) {
      console.log(`  ${base.padEnd(4)} ${desc.padEnd(28)} ERROR — ${e instanceof Error ? e.message.slice(0, 180) : e}`);
    }
  }
  console.log(`\nDone.\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
