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
