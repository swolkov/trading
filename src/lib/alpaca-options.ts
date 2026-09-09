// ALPACA — the READ-ONLY data client for the options paper book.
//
// SAFETY, deliberately structural rather than conventional:
//   * There is no order-placing function in this file, and none anywhere in the options
//     book. Nothing here can send a trade. The book is a measurement record.
//   * It reads ONLY the PAPER credentials (ALPACA_API_KEY / ALPACA_API_SECRET). The live
//     credentials (ALPACA_LIVE_*) are never referenced, so no code path in this book can
//     reach the real-money account even by misconfiguration.
//   * Market data is served from the same endpoints for both accounts, so using the paper
//     key costs nothing in data quality: the quotes below are the real NBBO.
//
// Verified Sep 8 2026 against paper account PA38DZZJSVNX (ACTIVE, options level 3): the
// snapshot endpoint returns latestQuote plus greeks (delta) on the free plan, which is what
// makes a forward-tested options book possible at $0 — real historical options data from
// Databento costs $207 per name-year and the account has no budget.

const DATA = process.env.ALPACA_DATA_URL?.replace(/\/$/, "") || "https://data.alpaca.markets";

function headers(): Record<string, string> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) throw new Error("ALPACA paper credentials missing (ALPACA_API_KEY / ALPACA_API_SECRET)");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: headers(), signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`alpaca ${res.status} ${(await res.text()).slice(0, 160)}`);
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}

export interface DailyBar { t: string; o: number; h: number; l: number; c: number; v: number }

/** Daily bars for many symbols in one call, split-adjusted. Used by the Donchian signal,
 *  which needs 200+ sessions of history, so the default lookback is generous. */
export async function getDailyBars(symbols: string[], days = 420): Promise<Record<string, DailyBar[]>> {
  const out: Record<string, DailyBar[]> = {};
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < symbols.length; i += 40) {
    const batch = symbols.slice(i, i + 40);
    const q = new URLSearchParams({ symbols: batch.join(","), timeframe: "1Day", start, limit: "10000", adjustment: "split" });
    let pageToken: string | undefined;
    do {
      if (pageToken) q.set("page_token", pageToken); else q.delete("page_token");
      const d = await getJson<{ bars: Record<string, DailyBar[]>; next_page_token?: string | null }>(`${DATA}/v2/stocks/bars?${q}`);
      for (const [sym, bars] of Object.entries(d.bars || {})) (out[sym] ||= []).push(...bars);
      pageToken = d.next_page_token || undefined;
    } while (pageToken);
  }
  for (const bars of Object.values(out)) bars.sort((a, b) => a.t.localeCompare(b.t));
  return out;
}

export interface OptionQuote {
  occ: string; strike: number; expiry: string; type: "call" | "put";
  bid: number; ask: number; bidSize: number; askSize: number;
  delta: number | null; theta: number | null; iv: number | null; dayVolume: number;
}

/** Parse an OCC symbol from the RIGHT — the root is variable length, so left-anchored
 *  parsing breaks on any root that is not the plain ticker (which is why the first version
 *  of the screen threw on a month out of range). */
export function parseOcc(occ: string): { root: string; expiry: string; type: "call" | "put"; strike: number } | null {
  if (occ.length < 16) return null;
  const strike = Number(occ.slice(-8)) / 1000;
  const cp = occ.slice(-9, -8);
  const ymd = occ.slice(-15, -9);
  const root = occ.slice(0, -15);
  if (!Number.isFinite(strike) || (cp !== "C" && cp !== "P")) return null;
  const yy = Number(ymd.slice(0, 2)), mm = Number(ymd.slice(2, 4)), dd = Number(ymd.slice(4, 6));
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  const expiry = `20${String(yy).padStart(2, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  return { root, expiry, type: cp === "C" ? "call" : "put", strike };
}

/** One underlying's option snapshots inside a strike and expiry window, with greeks.
 *  `feed=indicative` is the free-plan feed; it carries the real NBBO quote and Alpaca's
 *  computed greeks, which is all the selection rules need. */
export async function getOptionChain(p: {
  underlying: string; expiryFrom: string; expiryTo: string; strikeMin: number; strikeMax: number; type?: "call" | "put";
}): Promise<OptionQuote[]> {
  const q = new URLSearchParams({
    feed: "indicative", limit: "1000", type: p.type ?? "call",
    expiration_date_gte: p.expiryFrom, expiration_date_lte: p.expiryTo,
    strike_price_gte: p.strikeMin.toFixed(2), strike_price_lte: p.strikeMax.toFixed(2),
  });
  const d = await getJson<{ snapshots: Record<string, {
    latestQuote?: { bp?: number; ap?: number; bs?: number; as?: number };
    greeks?: { delta?: number; theta?: number };
    dailyBar?: { v?: number };
    impliedVolatility?: number;
  }> }>(`${DATA}/v1beta1/options/snapshots/${encodeURIComponent(p.underlying)}?${q}`);
  const out: OptionQuote[] = [];
  for (const [occ, s] of Object.entries(d.snapshots || {})) {
    const parsed = parseOcc(occ);
    if (!parsed) continue;
    const lq = s.latestQuote || {};
    out.push({
      occ, strike: parsed.strike, expiry: parsed.expiry, type: parsed.type,
      bid: lq.bp ?? 0, ask: lq.ap ?? 0, bidSize: lq.bs ?? 0, askSize: lq.as ?? 0,
      delta: s.greeks?.delta ?? null, theta: s.greeks?.theta ?? null,
      iv: s.impliedVolatility ?? null, dayVolume: s.dailyBar?.v ?? 0,
    });
  }
  return out;
}

/** Current quote for specific contracts already held — the mark for open positions. */
export async function getOptionQuotes(occs: string[]): Promise<Record<string, OptionQuote>> {
  const out: Record<string, OptionQuote> = {};
  for (let i = 0; i < occs.length; i += 100) {
    const batch = occs.slice(i, i + 100);
    const q = new URLSearchParams({ feed: "indicative", symbols: batch.join(",") });
    const d = await getJson<{ snapshots: Record<string, {
      latestQuote?: { bp?: number; ap?: number; bs?: number; as?: number };
      greeks?: { delta?: number; theta?: number }; dailyBar?: { v?: number }; impliedVolatility?: number;
    }> }>(`${DATA}/v1beta1/options/snapshots?${q}`);
    for (const [occ, s] of Object.entries(d.snapshots || {})) {
      const parsed = parseOcc(occ);
      if (!parsed) continue;
      const lq = s.latestQuote || {};
      out[occ] = {
        occ, strike: parsed.strike, expiry: parsed.expiry, type: parsed.type,
        bid: lq.bp ?? 0, ask: lq.ap ?? 0, bidSize: lq.bs ?? 0, askSize: lq.as ?? 0,
        delta: s.greeks?.delta ?? null, theta: s.greeks?.theta ?? null,
        iv: s.impliedVolatility ?? null, dayVolume: s.dailyBar?.v ?? 0,
      };
    }
  }
  return out;
}
