/**
 * Fetch daily ADJUSTED stock closes (Yahoo, free/no-auth) for the equity-pairs / stat-arb test —
 * relative value on STOCKS (no contract-size wall → a $1K account can size them). Pairs are
 * economically-related sector peers (not data-mined). Adjusted closes handle splits/dividends.
 *   npx tsx scripts/fetch-equities.ts            → data/equities/<TICKER>.csv (Date,Close)
 */
import fs from "node:fs";

export const PAIRS: [string, string][] = [
  ["KO", "PEP"], ["XOM", "CVX"], ["V", "MA"], ["HD", "LOW"], ["JPM", "BAC"],
  ["GS", "MS"], ["UPS", "FDX"], ["WMT", "TGT"], ["DUK", "SO"], ["GOOGL", "GOOG"],
];

async function yahoo(ticker: string): Promise<string[]> {
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 5 * 365 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${p1}&period2=${p2}&interval=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  if (!res?.timestamp) throw new Error("no data");
  const ts: number[] = res.timestamp;
  const close: (number | null)[] = res.indicators?.adjclose?.[0]?.adjclose ?? res.indicators?.quote?.[0]?.close ?? [];
  const rows: string[] = [];
  for (let i = 0; i < ts.length; i++) if (close[i] != null && close[i]! > 0) rows.push(`${new Date(ts[i] * 1000).toISOString().slice(0, 10)},${close[i]}`);
  return rows;
}

async function main() {
  const tickers = [...new Set(PAIRS.flat())];
  const dir = new URL("../data/equities/", import.meta.url); fs.mkdirSync(dir, { recursive: true });
  let ok = 0;
  for (const t of tickers) {
    try { const rows = await yahoo(t); if (rows.length > 200) { fs.writeFileSync(new URL(`${t}.csv`, dir), "Date,Close\n" + rows.join("\n") + "\n"); console.log(`  ${t.padEnd(6)} ${rows.length} daily bars`); ok++; } else console.log(`  ${t.padEnd(6)} only ${rows.length} bars`); }
    catch (e) { console.log(`  ${t.padEnd(6)} ERROR — ${e instanceof Error ? e.message : e}`); }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`\n  ${ok}/${tickers.length} tickers → data/equities/`);
}
main();
