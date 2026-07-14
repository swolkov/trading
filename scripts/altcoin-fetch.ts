/**
 * altcoin-fetch.ts — pulls Binance public klines (15m + 1h) for the liquid alt basket
 * and caches to CSV under /tmp/altcoin-data. Free public market-data mirror
 * (data-api.binance.vision) — no key, not geo-restricted like the main api.binance.com.
 *
 * Binance USDT-pair klines are used as a PROXY for Kraken USD spot (they track closely
 * enough for a strategy backtest). Format per row:
 *   [openTime, open, high, low, close, volume, closeTime, ...]
 *
 * Run: npx tsx scripts/altcoin-fetch.ts
 */
import fs from "node:fs";
import path from "node:path";

const HOST = "https://data-api.binance.vision";
const SYMBOLS = ["SOLUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"];
const INTERVALS = ["15m", "1h"];
const OUT_DIR = "/tmp/altcoin-data";

// ~3 years back from today. Alts listed later use whatever exists (API clamps to listing).
const START_MS = Date.parse("2022-07-01T00:00:00Z");
const END_MS = Date.now();

const MS_PER: Record<string, number> = { "15m": 15 * 60_000, "1h": 60 * 60_000 };

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchChunk(sym: string, interval: string, startTime: number): Promise<number[][]> {
  const url = `${HOST}/api/v3/klines?symbol=${sym}&interval=${interval}&startTime=${startTime}&endTime=${END_MS}&limit=1000`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 418) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as unknown;
      if (!Array.isArray(j)) throw new Error(`bad payload: ${JSON.stringify(j).slice(0, 120)}`);
      return j as number[][];
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  return [];
}

async function fetchAll(sym: string, interval: string): Promise<number[][]> {
  const step = MS_PER[interval];
  let start = START_MS;
  const all: number[][] = [];
  let calls = 0;
  while (start < END_MS) {
    const chunk = await fetchChunk(sym, interval, start);
    if (!chunk.length) break;
    all.push(...chunk);
    const lastOpen = chunk[chunk.length - 1][0] as number;
    const next = lastOpen + step;
    if (next <= start) break;          // no progress guard
    start = next;
    calls++;
    if (chunk.length < 1000) break;    // reached the end
    await sleep(300);                  // rate-limit courtesy
  }
  // dedupe by openTime (paginate overlap safety) and sort
  const map = new Map<number, number[]>();
  for (const row of all) map.set(row[0] as number, row);
  const rows = [...map.values()].sort((a, b) => (a[0] as number) - (b[0] as number));
  process.stdout.write(`  ${sym} ${interval}: ${rows.length} bars in ${calls} calls\n`);
  return rows;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const sym of SYMBOLS) {
    for (const interval of INTERVALS) {
      const outfile = path.join(OUT_DIR, `${sym}_${interval}.csv`);
      if (fs.existsSync(outfile)) {
        const n = fs.readFileSync(outfile, "utf8").trim().split("\n").length - 1;
        process.stdout.write(`  ${sym} ${interval}: cached (${n} bars) — skip\n`);
        continue;
      }
      const rows = await fetchAll(sym, interval);
      const lines = ["openTime,open,high,low,close,volume"];
      for (const r of rows) lines.push(`${r[0]},${r[1]},${r[2]},${r[3]},${r[4]},${r[5]}`);
      fs.writeFileSync(outfile, lines.join("\n"));
      const firstT = rows.length ? new Date(rows[0][0] as number).toISOString() : "n/a";
      const lastT = rows.length ? new Date(rows[rows.length - 1][0] as number).toISOString() : "n/a";
      process.stdout.write(`  -> wrote ${outfile}  [${firstT} .. ${lastT}]\n`);
    }
  }
  process.stdout.write("done.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
