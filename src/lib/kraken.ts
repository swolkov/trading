// Kraken REST client — public market data + private trading (HMAC-SHA512 signed).
// Credentials come ONLY from env (KRAKEN_API_KEY / KRAKEN_API_SECRET) set in the Vercel dashboard —
// never from chat/DB. If they're absent the client is safely inert (krakenConfigured() === false).
// Used by the buy-the-dip-and-HOLD accumulator (kraken-agent.ts). Spot, long-only, no leverage.
import crypto from "crypto";

const API_URL = "https://api.kraken.com";

// App symbol → Kraken pair. Kraken uses XBT for BTC.
const PAIR_MAP: Record<string, string> = {
  "BTC/USD": "XBTUSD",
  "ETH/USD": "ETHUSD",
  "SOL/USD": "SOLUSD",
};
// Kraken Balance keys for base assets (to read holdings).
const BALANCE_ASSET: Record<string, string> = {
  "BTC/USD": "XXBT",
  "ETH/USD": "XETH",
  "SOL/USD": "SOL",
};

export function krakenPair(symbol: string): string {
  return PAIR_MAP[symbol.toUpperCase()] || symbol.replace("/", "");
}
export function krakenBalanceAsset(symbol: string): string {
  return BALANCE_ASSET[symbol.toUpperCase()] || symbol.split("/")[0];
}

// Tolerant of env var casing (KRAKEN_API_KEY, Kraken_API_Key, etc.) so it works regardless of how
// the variables were named in the Vercel dashboard.
function krakenKey(): string {
  return process.env.KRAKEN_API_KEY || process.env.Kraken_API_Key || process.env.kraken_api_key || "";
}
function krakenSecret(): string {
  return process.env.KRAKEN_API_SECRET || process.env.Kraken_API_Secret || process.env.kraken_api_secret || "";
}

export function krakenConfigured(): boolean {
  return !!(krakenKey() && krakenSecret());
}

// ---- public ----
export async function krakenPublic(method: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_URL}/0/public/${method}${qs ? `?${qs}` : ""}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const d = await r.json();
  if (d.error?.length) throw new Error(`Kraken ${method}: ${d.error.join(", ")}`);
  return d.result;
}

// Daily OHLC bars from Kraken's public feed (no key needed) — the SAME venue we trade on, so the
// 50-day trend signal is computed from Kraken's own prices, not a second exchange. Kraken returns up
// to 720 daily candles; we keep the most recent `days`. Row format: [time,o,h,l,c,vwap,vol,count].
export interface KrakenDailyBar { t: string; o: number; h: number; l: number; c: number; }
export async function getKrakenDailyBars(symbol: string, days = 70): Promise<KrakenDailyBar[]> {
  const pair = krakenPair(symbol);
  const res = await krakenPublic("OHLC", { pair, interval: "1440" });
  // Result is keyed by Kraken's canonical pair name (e.g. XXBTZUSD); take the first non-"last" entry.
  const rows = Object.entries(res).find(([k]) => k !== "last")?.[1] as unknown[][] | undefined;
  if (!rows?.length) throw new Error(`Kraken OHLC empty for ${symbol}`);
  const bars = rows.map((r) => ({
    t: new Date(Number(r[0]) * 1000).toISOString(),
    o: parseFloat(r[1] as string),
    h: parseFloat(r[2] as string),
    l: parseFloat(r[3] as string),
    c: parseFloat(r[4] as string),
  }));
  return bars.slice(-days);
}

// Last traded price for a pair.
export async function getKrakenPrice(symbol: string): Promise<number> {
  const pair = krakenPair(symbol);
  const res = await krakenPublic("Ticker", { pair });
  const first = Object.values(res)[0] as { c?: string[] } | undefined;
  const last = first?.c?.[0];
  const px = last ? parseFloat(last) : NaN;
  if (!isFinite(px) || px <= 0) throw new Error(`Kraken price unavailable for ${symbol}`);
  return px;
}

// ---- private (signed) ----
function sign(path: string, params: Record<string, string>, secret: string): string {
  const postData = new URLSearchParams(params).toString();
  const sha256 = crypto.createHash("sha256").update(params.nonce + postData).digest();
  const hmac = crypto.createHmac("sha512", Buffer.from(secret, "base64"));
  hmac.update(path);
  hmac.update(sha256);
  return hmac.digest("base64");
}

async function krakenPrivate(method: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  if (!krakenConfigured()) throw new Error("Kraken not configured (KRAKEN_API_KEY/SECRET missing in env)");
  const path = `/0/private/${method}`;
  const nonce = String(Date.now() * 1000);
  const body = { nonce, ...params };
  const signature = sign(path, body, krakenSecret());
  const r = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "API-Key": krakenKey(),
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json();
  if (d.error?.length) throw new Error(`Kraken ${method}: ${d.error.join(", ")}`);
  return d.result;
}

// All balances (asset → amount as string).
export async function getKrakenBalance(): Promise<Record<string, number>> {
  const res = await krakenPrivate("Balance");
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(res)) out[k] = parseFloat(v as string);
  return out;
}

export interface KrakenTradeBalance { usd: number; }
export async function getKrakenUsd(): Promise<number> {
  const bal = await getKrakenBalance();
  return bal.ZUSD ?? bal.USD ?? 0;
}

// ---- capital flows (deposits / withdrawals) ----
// P&L is only honest if we know how much was PUT IN. Reading that from Kraken's own ledger beats
// a hardcoded starting-capital number, which silently turns the next deposit into fake "profit"
// (a $5,000 wire would have shown as +$5,000 gained). Unlike the futures side — where flows have to
// be inferred from balance snapshots because the broker's log is empty — Kraken hands us the actual
// deposit records, so this is exact rather than derived.
export interface KrakenCashFlow {
  time: string;
  asset: string;
  amount: number;                 // native units, + deposit / − withdrawal
  usd: number;                    // valued in USD
  type: "deposit" | "withdrawal";
  approximate: boolean;           // true when a non-USD transfer had to be valued at today's price
}

function isUsdAsset(asset: string): boolean {
  const base = asset.replace(/\.[A-Z]+$/, "");   // strip .F / .S (earn / staked) suffixes
  return base === "ZUSD" || base === "USD";
}
// Kraken ledger asset codes carry legacy prefixes (XXBT, XETH). Reduce to something Ticker accepts.
function ledgerAssetToPair(asset: string): string {
  const base = asset.replace(/\.[A-Z]+$/, "").replace(/^X(?=[A-Z]{3,})/, "");
  return `${base}USD`;
}

// Every deposit and withdrawal on the account, oldest first, with the USD net.
// Non-USD transfers are valued at the CURRENT price — an approximation, so it is flagged rather
// than quietly folded in. A USD-funded account (ours) returns approximate: false.
export async function getKrakenCashFlows(): Promise<{ flows: KrakenCashFlow[]; netUsd: number; approximate: boolean }> {
  const raw: { id: string; time: number; type: string; asset: string; amount: number }[] = [];
  // Kraken pages the ledger 50 at a time; walk until we have them all (guard against runaway loops).
  for (let ofs = 0; ofs < 2000; ofs += 50) {
    const res = await krakenPrivate("Ledgers", { type: "all", ofs: String(ofs) });
    const ledger = (res.ledger ?? {}) as Record<string, { time: number; type: string; asset: string; amount: string }>;
    const entries = Object.entries(ledger);
    for (const [id, e] of entries) {
      if (e.type !== "deposit" && e.type !== "withdrawal") continue;
      const amt = parseFloat(e.amount);
      if (!isFinite(amt) || amt === 0) continue;
      raw.push({ id, time: e.time, type: e.type, asset: e.asset, amount: amt });
    }
    const count = Number(res.count ?? 0);
    if (entries.length === 0 || ofs + 50 >= count) break;
  }

  // Price any non-USD transfers once per asset.
  const priceCache = new Map<string, number>();
  let approximate = false;
  const flows: KrakenCashFlow[] = [];
  for (const r of raw.sort((a, b) => a.time - b.time)) {
    let usd = 0;
    let approx = false;
    if (isUsdAsset(r.asset)) {
      usd = r.amount;
    } else {
      approx = true;
      approximate = true;
      const pair = ledgerAssetToPair(r.asset);
      if (!priceCache.has(pair)) {
        try {
          const res = await krakenPublic("Ticker", { pair });
          const first = Object.values(res)[0] as { c?: string[] } | undefined;
          priceCache.set(pair, parseFloat(first?.c?.[0] ?? "0") || 0);
        } catch { priceCache.set(pair, 0); }
      }
      usd = r.amount * (priceCache.get(pair) || 0);
    }
    flows.push({
      time: new Date(r.time * 1000).toISOString(),
      asset: r.asset,
      amount: r.amount,
      usd,
      type: r.type === "deposit" ? "deposit" : "withdrawal",
      approximate: approx,
    });
  }
  return { flows, netUsd: flows.reduce((s, f) => s + f.usd, 0), approximate };
}

// Place a market BUY for a $ amount. validate=true tests the order path WITHOUT placing (safe).
export async function krakenBuyMarket(
  symbol: string,
  usd: number,
  price: number,
  validate: boolean,
): Promise<{ placed: boolean; volume: number; txid?: string[]; descr?: string }> {
  const pair = krakenPair(symbol);
  const volume = (usd / price).toFixed(8);
  const params: Record<string, string> = {
    pair,
    type: "buy",
    ordertype: "market",
    volume,
  };
  if (validate) params.validate = "true";
  const res = await krakenPrivate("AddOrder", params);
  const descr = (res.descr as { order?: string } | undefined)?.order;
  return { placed: !validate, volume: parseFloat(volume), txid: res.txid as string[] | undefined, descr };
}

// Place a market SELL of a base-currency volume (e.g. sell 0.02 ETH). validate=true tests only.
export async function krakenSellMarket(
  symbol: string,
  volume: number,
  validate: boolean,
): Promise<{ placed: boolean; volume: number; txid?: string[]; descr?: string }> {
  const pair = krakenPair(symbol);
  const vol = volume.toFixed(8);
  const params: Record<string, string> = { pair, type: "sell", ordertype: "market", volume: vol };
  if (validate) params.validate = "true";
  const res = await krakenPrivate("AddOrder", params);
  const descr = (res.descr as { order?: string } | undefined)?.order;
  return { placed: !validate, volume: parseFloat(vol), txid: res.txid as string[] | undefined, descr };
}
