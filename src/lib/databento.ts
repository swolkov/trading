// ============ DATABENTO HISTORICAL BARS (chart/UI) ============
// Canonical market data for the dashboard chart. Pulls GLBX.MDP3 ohlcv via the historical REST API
// (~7-min behind real-time) and aggregates to the requested interval. Server-side only (needs
// DATABENTO_API_KEY). Returns [] on any failure so callers fall back to Tradovate→Yahoo. NOT the engine path.

import type { BarData } from "./tradovate";

// Map engine symbols → Databento continuous front-month (micros map to full-size: same index, deepest book)
const DBN_MAP: Record<string, string> = {
  ES: "ES.v.0", NQ: "NQ.v.0", YM: "YM.v.0", RTY: "RTY.v.0", GC: "GC.v.0",
  MES: "ES.v.0", MNQ: "NQ.v.0", MYM: "YM.v.0", M2K: "RTY.v.0", MGC: "GC.v.0",
};

const cache = new Map<string, { at: number; bars: BarData[] }>();
const TTL_MS = 30_000;   // avoid hammering the historical API on every 15s chart refresh

function authHeader(): string | null {
  const k = process.env.DATABENTO_API_KEY;
  return k ? "Basic " + Buffer.from(k + ":").toString("base64") : null;
}

// Cache Databento's available-end (data lags real-time ~7min) so we DON'T 422+retry on every chart load.
let availEndMs = 0, availAt = 0;
async function getRange(dbnSym: string, schema: string, startISO: string, endISO: string, auth: string): Promise<string> {
  const mk = (end: string) => new URLSearchParams({ dataset: "GLBX.MDP3", symbols: dbnSym, stype_in: "continuous", schema, start: startISO, end, encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  const url = "https://hist.databento.com/v0/timeseries.get_range";
  const headers = { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" };
  // If we know the available-end (cached <60s), clamp end to it → single round-trip, no 422.
  let end = endISO;
  if (availEndMs > 0 && Date.now() - availAt < 60_000 && new Date(endISO).getTime() > availEndMs) end = new Date(availEndMs).toISOString();
  let res = await fetch(url, { method: "POST", headers, body: mk(end) });
  if (res.status === 422) {
    const j = await res.json().catch(() => null);
    const avail = j?.detail?.payload?.available_end;
    if (!avail) throw new Error("422 (no available_end)");
    availEndMs = new Date(avail).getTime(); availAt = Date.now();   // cache it
    res = await fetch(url, { method: "POST", headers, body: mk(String(avail)) });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseOhlcv(csv: string): BarData[] {
  const lines = csv.trim().split("\n"); const out: BarData[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const t = Math.floor(new Date(c[0]).getTime() / 1000);
    const o = +c[4], h = +c[5], l = +c[6], cl = +c[7], v = +c[8];
    if (isFinite(t) && isFinite(cl) && cl > 0) out.push({ t, o, h, l, c: cl, v: isFinite(v) ? v : 0 });
  }
  return out;
}

function aggregate(bars: BarData[], minutes: number): BarData[] {
  if (minutes <= 1) return bars;
  const sec = minutes * 60; const buckets = new Map<number, BarData>();
  for (const b of bars) {
    const k = Math.floor(b.t / sec) * sec; const e = buckets.get(k);
    if (!e) buckets.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { e.h = Math.max(e.h, b.h); e.l = Math.min(e.l, b.l); e.c = b.c; e.v += b.v; }
  }
  return [...buckets.values()].sort((x, y) => x.t - y.t);
}

/** Databento chart bars (primary). Supports 1s/1m/5m/15m/1h. Returns [] if unavailable → caller falls back. */
export async function getDatabentoIntradayBars(symbol: string, interval: "1s" | "1m" | "5m" | "15m" | "1h", range: "1d" | "5d"): Promise<BarData[]> {
  const auth = authHeader(); const dbnSym = DBN_MAP[symbol];
  if (!auth || !dbnSym) return [];
  const key = `${dbnSym}|${interval}|${range}`;
  const ttl = interval === "1s" ? 4_000 : TTL_MS;   // seconds charts refresh faster
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.bars;
  try {
    const now = new Date();
    // window per interval — 1s only needs a short recent span; coarser intervals want more history
    const windowMs = interval === "1s" ? 20 * 60_000 : interval === "1m" ? 86_400_000 : (range === "5d" ? 5 : 1) * 86_400_000;
    const start = new Date(now.getTime() - windowMs).toISOString();
    const schema = interval === "1s" ? "ohlcv-1s" : interval === "1h" ? "ohlcv-1h" : "ohlcv-1m";
    let bars = parseOhlcv(await getRange(dbnSym, schema, start, now.toISOString(), auth));
    if (interval === "5m") bars = aggregate(bars, 5);
    else if (interval === "15m") bars = aggregate(bars, 15);
    cache.set(key, { at: Date.now(), bars });
    return bars;
  } catch {
    return [];   // fail-safe → Tradovate→Yahoo fallback in the caller
  }
}
