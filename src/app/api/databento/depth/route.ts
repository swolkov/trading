import { prisma } from "@/lib/db";
import fs from "node:fs";

/**
 * Databento market depth + tape endpoint.
 *
 * Returns three pieces of market intelligence per symbol:
 *   1. Live snapshot (bid/ask/mid from live_quotes — what the sidecar writes)
 *   2. Recent trade tape (last N trades — Databento historical trades schema)
 *   3. Volume profile (last 24h volume by price bucket — aggregated from trades)
 *
 * Innovative use of our $15/mo Databento subscription:
 *   - Pro traders use volume profile to identify "value area" — where most volume
 *     traded today. Our backtests don't account for this; the chart should.
 *   - Tape lets you see aggressor flow in real time (big buys vs big sells).
 *   - Combined: where is volume building, and which side is winning?
 */

const DATABENTO_BASE = "https://hist.databento.com/v0";
const DATASET_MAP: Record<string, string> = {
  ES: "GLBX.MDP3", NQ: "GLBX.MDP3", GC: "GLBX.MDP3", YM: "GLBX.MDP3", RTY: "GLBX.MDP3",
  MES: "GLBX.MDP3", MNQ: "GLBX.MDP3", MGC: "GLBX.MDP3", MYM: "GLBX.MDP3", M2K: "GLBX.MDP3",
  MBT: "GLBX.MDP3", MET: "GLBX.MDP3", BFF: "GLBX.MDP3", MXR: "GLBX.MDP3", MSL: "GLBX.MDP3",
};

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  try {
    const env = fs.readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch { /* swallow */ }
  return "";
}

interface Trade { ts: number; price: number; size: number; side: "B" | "S" | "?"; }

async function fetchRecentTrades(symbol: string, hoursBack: number): Promise<Trade[]> {
  const KEY = apiKey();
  if (!KEY) return [];
  const dataset = DATASET_MAP[symbol] || "GLBX.MDP3";
  // Databento historical lag — most recent ~few days behind live sub; end window 4 days back.
  const end = new Date(Date.now() - 4 * 86_400_000);
  const start = new Date(end.getTime() - hoursBack * 3600_000);
  const body = new URLSearchParams({
    dataset,
    symbols: `${symbol}.v.0`,
    stype_in: "continuous",
    schema: "trades",
    start: start.toISOString().slice(0, 19),
    end: end.toISOString().slice(0, 19),
    encoding: "csv",
    pretty_px: "true",
    pretty_ts: "true",
    limit: "500",
  });
  const auth = "Basic " + Buffer.from(`${KEY}:`).toString("base64");
  const res = await fetch(`${DATABENTO_BASE}/timeseries.get_range`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Databento ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const csv = await res.text();
  // Parse CSV — trade schema columns: ts_event, rtype, publisher_id, instrument_id, action, side, depth, price, size, ...
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const tsIdx = header.indexOf("ts_event");
  const priceIdx = header.indexOf("price");
  const sizeIdx = header.indexOf("size");
  const sideIdx = header.indexOf("side");
  const trades: Trade[] = [];
  // Take last 200 trades for tape display
  const recent = lines.slice(Math.max(1, lines.length - 200));
  for (const line of recent) {
    const cols = line.split(",");
    const ts = new Date(cols[tsIdx]).getTime();
    const price = parseFloat(cols[priceIdx]);
    const size = parseInt(cols[sizeIdx], 10);
    const side = cols[sideIdx] === "A" ? "B" : cols[sideIdx] === "B" ? "S" : "?"; // Databento: A=Aggressor sold to ask, B=Aggressor bought from bid
    if (!isNaN(price) && !isNaN(size)) trades.push({ ts, price, size, side });
  }
  return trades;
}

interface VolumeBucket { price: number; buyVol: number; sellVol: number; total: number; }

function buildVolumeProfile(trades: Trade[], buckets: number): VolumeBucket[] {
  if (trades.length === 0) return [];
  const prices = trades.map((t) => t.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const bucketSize = range / buckets;
  const out: VolumeBucket[] = [];
  for (let i = 0; i < buckets; i++) {
    out.push({ price: min + (i + 0.5) * bucketSize, buyVol: 0, sellVol: 0, total: 0 });
  }
  for (const t of trades) {
    const idx = Math.min(buckets - 1, Math.floor((t.price - min) / bucketSize));
    if (t.side === "B") out[idx].buyVol += t.size;
    else if (t.side === "S") out[idx].sellVol += t.size;
    out[idx].total += t.size;
  }
  return out;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const hoursBack = parseInt(url.searchParams.get("hours") || "24", 10);

  if (!symbol || !DATASET_MAP[symbol]) {
    return Response.json({ error: `Unknown symbol: ${symbol}. Known: ${Object.keys(DATASET_MAP).join(", ")}` }, { status: 400 });
  }

  try {
    // 1. Live snapshot from sidecar's live_quotes table (the price the engine sees right now)
    const live = await prisma.$queryRaw<{ symbol: string; bid: number | null; ask: number | null; mid: number | null; ts: bigint | null; source: string | null; vol: number | null }[]>`
      SELECT symbol, bid, ask, mid, ts, source, vol FROM live_quotes WHERE symbol = ${symbol} LIMIT 1
    `;
    const liveQuote = live[0] ?? null;

    // 2. Recent trades from Databento historical (last `hoursBack` h)
    const trades = await fetchRecentTrades(symbol, hoursBack);

    // 3. Volume profile from the trades
    const profile = buildVolumeProfile(trades, 30);

    return Response.json({
      symbol,
      live: liveQuote ? {
        bid: liveQuote.bid,
        ask: liveQuote.ask,
        mid: liveQuote.mid,
        ts: liveQuote.ts ? Number(liveQuote.ts) : null,
        source: liveQuote.source,
        cumVol: liveQuote.vol,
      } : null,
      tape: trades.slice(-100).reverse(), // newest first, last 100 trades
      volumeProfile: profile,
      meta: {
        tradeCount: trades.length,
        hoursBack,
        dataLag: "Databento historical lags ~4 days behind live for non-live-sub symbols",
      },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
