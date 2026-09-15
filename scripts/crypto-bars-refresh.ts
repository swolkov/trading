// REFRESH data/crypto/<COIN>.csv (C6, Sep 15 2026) — extends each coin's Binance 1h history from
// its last bar to now, and creates the file for coins that have none (ADA, LTC, SUI). Source:
// the public market-data mirror data-api.binance.vision (no key, not geo-restricted). USDT pairs
// are the proxy for Kraken USD spot the replays use.
//
//   npx tsx scripts/crypto-bars-refresh.ts [--dir data/crypto] [--since 2024-01-01] [--coins BTC,ETH]
//
// FAIL-SOFT: if the endpoint is unreachable the CSVs are left exactly as they were and the script
// says so and exits 0 — a research run on yesterday's bars is better than no run. A partial
// failure (one coin) is reported per coin.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DATA_DIR, RESEARCH_COINS, parseBarsCsv } from "./lib/bars";

const HOST = "https://data-api.binance.vision";
const HOUR_MS = 3_600_000;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DIR = arg("dir", DEFAULT_DATA_DIR);
const SINCE_MS = Date.parse(`${arg("since", "2024-01-01")}T00:00:00Z`);
const COINS = arg("coins", RESEARCH_COINS.join(",")).split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchChunk(sym: string, startMs: number, endMs: number): Promise<number[][]> {
  const url = `${HOST}/api/v3/klines?symbol=${sym}&interval=1h&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status === 418) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as unknown;
      if (!Array.isArray(j)) throw new Error(`bad payload: ${JSON.stringify(j).slice(0, 100)}`);
      return j as number[][];
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  return [];
}

async function reachable(): Promise<boolean> {
  try { const r = await fetch(`${HOST}/api/v3/ping`, { signal: AbortSignal.timeout(10_000) }); return r.ok; } catch { return false; }
}

async function main() {
  if (!(await reachable())) {
    console.log(`Binance data endpoint (${HOST}) is unreachable — CSVs in ${DIR} left as they were. Research runs on the existing bars.`);
    return;
  }
  mkdirSync(DIR, { recursive: true });
  const nowMs = Date.now() - (Date.now() % HOUR_MS);   // only complete hours
  for (const coin of COINS) {
    const path = join(DIR, `${coin}.csv`);
    const existing = existsSync(path) ? parseBarsCsv(readFileSync(path, "utf8")) : [];
    const lastT = existing.length ? existing[existing.length - 1].t * 1000 : null;
    let start = lastT != null ? lastT + HOUR_MS : SINCE_MS;
    const rows: string[] = [];
    let calls = 0;
    try {
      while (start < nowMs) {
        const chunk = await fetchChunk(`${coin}USDT`, start, nowMs);
        calls++;
        if (!chunk.length) break;
        for (const k of chunk) {
          const t = Number(k[0]);
          if (t + HOUR_MS > nowMs) continue;   // the forming hour
          rows.push(`${t},${k[1]},${k[2]},${k[3]},${k[4]},${k[5]}`);
        }
        const next = Number(chunk[chunk.length - 1][0]) + HOUR_MS;
        if (next <= start) break;
        start = next;
        if (chunk.length < 1000) break;
        await sleep(150);
      }
    } catch (e) {
      console.log(`${coin}: ${String(e).slice(0, 100)} — kept ${existing.length} existing bars${rows.length ? `, appended ${rows.length} fetched before the failure` : ""}`);
    }
    if (!existing.length && !rows.length) { console.log(`${coin}: nothing fetched (unlisted or empty) — no file written`); continue; }
    const header = "t,o,h,l,c,v";
    const body = existing.length ? readFileSync(path, "utf8").trim() : header;
    writeFileSync(path, `${body}${rows.length ? `\n${rows.join("\n")}` : ""}\n`);
    const total = existing.length + rows.length;
    console.log(`${coin}: +${rows.length} bars (${calls} calls) → ${total} hourly bars, ${existing.length ? "extended" : "created"}; newest ${rows.length ? new Date(Number(rows[rows.length - 1].split(",")[0])).toISOString().slice(0, 13) : lastT != null ? new Date(lastT).toISOString().slice(0, 13) : "—"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(0); });
