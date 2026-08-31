// Kraken REST client — public market data + private trading (HMAC-SHA512 signed).
// Credentials come ONLY from env (KRAKEN_API_KEY / KRAKEN_API_SECRET) set in the Vercel dashboard —
// never from chat/DB. If they're absent the client is safely inert (krakenConfigured() === false).
// Used by the 50-day trend follower (kraken-agent.ts). Spot, long-only, no leverage.
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

export async function krakenPrivate(method: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
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

// SPENDABLE balance, which is not the same as total balance. Kraken's `Balance` reports everything
// you own INCLUDING amounts committed to open orders, so sizing an order off it throws
// "EOrder:Insufficient funds" — observed live on 2026-08-23 with $65.06 of cash showing and the buy
// rejected. `BalanceEx` splits the two, so the engine can size off what it can actually spend.
// Use this for anything that PLACES an order; use getKrakenBalance for valuing what is owned.
export async function getKrakenAvailable(): Promise<Record<string, number>> {
  const res = await krakenPrivate("BalanceEx");
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(res)) {
    const o = v as { balance?: string; hold_trade?: string };
    const bal = parseFloat(o.balance ?? "0") || 0;
    const hold = parseFloat(o.hold_trade ?? "0") || 0;
    out[k] = Math.max(0, bal - hold);
  }
  return out;
}

export interface KrakenTradeBalance { usd: number; }
export async function getKrakenUsd(): Promise<number> {
  const bal = await getKrakenBalance();
  return bal.ZUSD ?? bal.USD ?? 0;
}

// Value EVERY non-USD balance on the account, not just the coins the strategy trades. Deposited
// capital is measured account-wide, so total value has to be too — otherwise buying something the
// strategy doesn't trade (a manual PEPE punt) leaves the account but stays in the denominator and
// shows up as a loss. One Ticker call for all pairs. Assets with no USD pair are returned at 0
// value and flagged so they can be shown as unpriced rather than silently dropped.
export interface KrakenAssetValue { asset: string; amount: number; price: number; value: number; priced: boolean }
export async function valueKrakenAssets(bal: Record<string, number>): Promise<KrakenAssetValue[]> {
  const held = Object.entries(bal).filter(([a, amt]) => amt > 0 && !isUsdAsset(a));
  if (!held.length) return [];
  const pairs = [...new Set(held.map(([a]) => ledgerAssetToPair(a)))];
  let tick: Record<string, unknown> = {};
  try { tick = await krakenPublic("Ticker", { pair: pairs.join(",") }); } catch { /* price what we can */ }
  // Kraken echoes canonical pair names (XXBTZUSD for XBTUSD), so match loosely on the base symbol.
  const priceFor = (pair: string): number => {
    const base = pair.replace(/USD$/, "");
    for (const [k, v] of Object.entries(tick)) {
      const kb = k.replace(/^X/, "").replace(/(Z?USD)$/, "");
      if (k === pair || kb === base.replace(/^X/, "")) {
        const c = (v as { c?: string[] })?.c?.[0];
        const px = c ? parseFloat(c) : NaN;
        if (isFinite(px) && px > 0) return px;
      }
    }
    return 0;
  };
  return held.map(([asset, amount]) => {
    const price = priceFor(ledgerAssetToPair(asset));
    return { asset, amount, price, value: amount * price, priced: price > 0 };
  });
}

// ---- book split (strategy money vs money the operator moved into their own positions) ----
// The account holds two books: the coins the trend follower manages, and whatever was bought by
// hand. Deposits are account-wide, so without splitting them a manual punt lands in the strategy's
// P&L and the track record stops measuring the strategy. Every USD that bought a non-strategy asset
// is capital that LEFT the strategy pool, so it is subtracted from the strategy's cost basis and
// becomes the cost basis of the operator's own book. Sells back into USD reverse it.
export interface KrakenBookSplit { ownBookCost: number; ok: boolean }
export async function getKrakenBookSplit(strategyAssets: Set<string>): Promise<KrakenBookSplit> {
  // Group ledger rows by refid: one trade writes a USD leg and an asset leg sharing a refid.
  const groups = new Map<string, { usd: number; assets: string[] }>();
  try {
    for (let ofs = 0; ofs < 2000; ofs += 50) {
      const res = await krakenPrivate("Ledgers", { type: "all", ofs: String(ofs) });
      const ledger = (res.ledger ?? {}) as Record<string, { refid?: string; type: string; asset: string; amount: string }>;
      const entries = Object.entries(ledger);
      for (const [id, e] of entries) {
        if (!["trade", "spend", "receive", "margin"].includes(e.type)) continue;
        const amt = parseFloat(e.amount);
        if (!isFinite(amt) || amt === 0) continue;
        const key = e.refid || id;
        if (!groups.has(key)) groups.set(key, { usd: 0, assets: [] });
        const g = groups.get(key)!;
        if (isUsdAsset(e.asset)) g.usd += amt;
        else g.assets.push(e.asset);
      }
      const count = Number(res.count ?? 0);
      if (entries.length === 0 || ofs + 50 >= count) break;
    }
  } catch { return { ownBookCost: 0, ok: false }; }

  let ownBookCost = 0;
  for (const g of groups.values()) {
    if (!g.assets.length || g.usd === 0) continue;
    // A trade touching ANY asset the strategy does not manage is an own-book trade.
    if (g.assets.some((a) => !strategyAssets.has(a))) ownBookCost += -g.usd;   // USD out (negative) = cost
  }
  return { ownBookCost, ok: true };
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
  approximate: boolean;           // true only if transfer-date pricing was unavailable and spot was used
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
// Non-USD transfers are valued at their price ON THE TRANSFER DATE. Only when that history is
// unavailable does it fall back to spot, and then `approximate` is set rather than quietly folding
// a guess into the number. A USD-funded account returns approximate: false.
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

  // Value non-USD transfers at the price ON THE DAY THEY MOVED, not today. Using today's price
  // misstates deposited capital by however much the asset has since moved — a coin deposited cheap
  // and now expensive would inflate "deposited" and hide real profit. Kraken's daily OHLC goes back
  // ~720 candles, which covers this account; anything older falls back to spot and is flagged.
  const histCache = new Map<string, Map<string, number> | null>();
  const spotCache = new Map<string, number>();
  let approximate = false;
  const flows: KrakenCashFlow[] = [];
  for (const r of raw.sort((a, b) => a.time - b.time)) {
    let usd = 0;
    let approx = false;
    if (isUsdAsset(r.asset)) {
      usd = r.amount;
    } else {
      const pair = ledgerAssetToPair(r.asset);
      if (!histCache.has(pair)) {
        try {
          const res = await krakenPublic("OHLC", { pair, interval: "1440" });
          const rows = Object.entries(res).find(([k]) => k !== "last")?.[1] as unknown[][] | undefined;
          const byDay = new Map<string, number>();
          for (const row of rows ?? []) {
            byDay.set(new Date(Number(row[0]) * 1000).toISOString().slice(0, 10), parseFloat(row[4] as string));
          }
          histCache.set(pair, byDay.size ? byDay : null);
        } catch { histCache.set(pair, null); }
      }
      const onDay = histCache.get(pair)?.get(new Date(r.time * 1000).toISOString().slice(0, 10));
      if (onDay && onDay > 0) {
        usd = r.amount * onDay;                       // exact: priced on the transfer date
      } else {
        approx = true;
        approximate = true;
        if (!spotCache.has(pair)) {
          try {
            const res = await krakenPublic("Ticker", { pair });
            const first = Object.values(res)[0] as { c?: string[] } | undefined;
            spotCache.set(pair, parseFloat(first?.c?.[0] ?? "0") || 0);
          } catch { spotCache.set(pair, 0); }
        }
        usd = r.amount * (spotCache.get(pair) || 0);
      }
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

// ---------------------------------------------------------------------------------------------
// MAKER ORDERS
//
// Every order used to be `ordertype: "market"`, which pays Kraken's TAKER fee on both sides.
// At the entry tier that is 0.80% taker vs 0.40% maker, so resting a post-only limit instead of
// crossing the spread saves ~0.40% per side. Measured against 16 dead edge families, this is the
// only certain improvement available — it does not depend on predicting anything.
//
// Applied to BUYS ONLY, deliberately. An entry has no urgency: if the limit does not fill this
// cycle we re-price on the next one. An EXIT does — it fires because the trend broke, and being
// 30 minutes late to sell a falling coin costs far more than the 0.40% saved. Exits stay market.
// ---------------------------------------------------------------------------------------------

// Tags every order this bot places. Spencer trades his own coins in the same account, so cancels
// MUST be scoped to our own orders — never touch his resting manual orders. (See the two-book rule.)
export const KRAKEN_USERREF = 770077;

type PairMeta = { priceDecimals: number; lotDecimals: number; orderMin: number };
const pairMetaCache = new Map<string, PairMeta>();

// Kraken REJECTS a limit price carrying more decimals than the pair allows. An unrounded price is
// exactly the failure that produced naked positions on the futures side — round before sending.
async function getPairMeta(pair: string): Promise<PairMeta> {
  const hit = pairMetaCache.get(pair);
  if (hit) return hit;
  const res = await krakenPublic("AssetPairs", { pair });
  const first = Object.values(res)[0] as
    | { pair_decimals?: number; lot_decimals?: number; ordermin?: string }
    | undefined;
  const meta: PairMeta = {
    priceDecimals: first?.pair_decimals ?? 2,
    lotDecimals: first?.lot_decimals ?? 8,
    orderMin: parseFloat(first?.ordermin ?? "0") || 0,
  };
  pairMetaCache.set(pair, meta);
  return meta;
}

// Best bid/ask. A post-only buy rests AT the bid so it is never the aggressor.
export async function krakenTouch(symbol: string): Promise<{ bid: number; ask: number }> {
  const pair = krakenPair(symbol);
  const res = await krakenPublic("Ticker", { pair });
  const first = Object.values(res)[0] as { a?: string[]; b?: string[] } | undefined;
  return { bid: parseFloat(first?.b?.[0] ?? "0") || 0, ask: parseFloat(first?.a?.[0] ?? "0") || 0 };
}

// Post-only limit BUY resting at the bid. `post` makes Kraken REJECT rather than fill the order if
// it would cross the spread, so we can never accidentally pay the taker fee.
export async function krakenBuyLimitPostOnly(
  symbol: string,
  usd: number,
  validate: boolean,
): Promise<{ placed: boolean; volume: number; price: number; txid?: string[]; descr?: string }> {
  const pair = krakenPair(symbol);
  const { bid } = await krakenTouch(symbol);
  if (!(bid > 0)) throw new Error(`no bid for ${symbol}`);
  const meta = await getPairMeta(pair);
  const price = Number(bid.toFixed(meta.priceDecimals));
  const rawVol = usd / price;
  const volume = Number(rawVol.toFixed(meta.lotDecimals));
  if (meta.orderMin > 0 && volume < meta.orderMin) {
    throw new Error(`volume ${volume} below Kraken minimum ${meta.orderMin} for ${symbol}`);
  }
  const params: Record<string, string> = {
    pair,
    type: "buy",
    ordertype: "limit",
    price: price.toFixed(meta.priceDecimals),
    volume: volume.toFixed(meta.lotDecimals),
    oflags: "post",
    userref: String(KRAKEN_USERREF),
  };
  if (validate) params.validate = "true";
  const res = await krakenPrivate("AddOrder", params);
  const descr = (res.descr as { order?: string } | undefined)?.order;
  return { placed: !validate, volume, price, txid: res.txid as string[] | undefined, descr };
}

type OpenOrder = { txid: string; userref?: number; opentm: number; pair: string; vol: number; volExec: number };

export async function krakenOpenOrders(): Promise<OpenOrder[]> {
  const res = await krakenPrivate("OpenOrders");
  const open = (res.open ?? {}) as Record<string, {
    userref?: number; opentm?: number; vol?: string; vol_exec?: string; descr?: { pair?: string };
  }>;
  return Object.entries(open).map(([txid, o]) => ({
    txid,
    userref: o.userref,
    opentm: o.opentm ?? 0,
    pair: o.descr?.pair ?? "",
    vol: parseFloat(o.vol ?? "0") || 0,
    volExec: parseFloat(o.vol_exec ?? "0") || 0,
  }));
}

export async function krakenCancelOrder(txid: string): Promise<void> {
  await krakenPrivate("CancelOrder", { txid });
}

// Cancel OUR unfilled resting orders older than maxAgeSec so the next cycle can re-price at the
// current bid. Scoped by userref: orders Spencer placed by hand are never touched.
export async function krakenCancelStaleOrders(maxAgeSec: number): Promise<{ cancelled: number; kept: number }> {
  const orders = await krakenOpenOrders();
  const now = Date.now() / 1000;
  let cancelled = 0;
  let kept = 0;
  for (const o of orders) {
    if (o.userref !== KRAKEN_USERREF) continue;      // not ours — leave it alone
    if (now - o.opentm < maxAgeSec) { kept++; continue; }
    try { await krakenCancelOrder(o.txid); cancelled++; } catch { /* already gone or filling */ }
  }
  return { cancelled, kept };
}

// Kraken reports `cost` (quote spent on the fill) and `fee` SEPARATELY. The USD actually debited is
// cost + fee, so anything doing cash accounting must add them or it will under-count what was spent.
export async function krakenOrderStatus(txid: string): Promise<{ status: string; volExec: number; cost: number; fee: number }> {
  const res = await krakenPrivate("QueryOrders", { txid });
  const o = (res as Record<string, { status?: string; vol_exec?: string; cost?: string; fee?: string }>)[txid];
  return {
    status: o?.status ?? "unknown",
    volExec: parseFloat(o?.vol_exec ?? "0") || 0,
    cost: parseFloat(o?.cost ?? "0") || 0,
    fee: parseFloat(o?.fee ?? "0") || 0,
  };
}

// Actual USD debited for a just-placed order: Kraken reports `cost` and `fee` separately, and a
// market order can execute away from the price we sized against. Returns null if the fill cannot be
// read, so callers fall back to the intended amount rather than booking a wrong number.
export async function krakenSettledCost(txid: string, tries = 3): Promise<number | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const st = await krakenOrderStatus(txid);
      if (st.status === "closed") return st.cost + st.fee;
      if (st.status === "canceled" || st.status === "expired") return st.volExec > 0 ? st.cost + st.fee : 0;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// Maker-only buy attempt. Rests a post-only limit at the bid and waits briefly for a fill.
//
// CRITICAL DESIGN RULE: this function NEVER places a second order. An earlier version fell back to
// a market order in the same invocation, which an adversarial review showed could double-spend in
// three ways — an AddOrder whose response times out after Kraken accepted it, a CancelOrder that is
// rate-limited while the limit still rests, and a cancel that races a fill. All three came from
// inferring remote order state from local variables. Placing at most ONE order per invocation makes
// double-spending impossible by construction rather than by careful reasoning.
//
// If it does not fill we cancel (best effort) and report filled:false. The caller simply retries on
// the next 30-minute cycle; for a 50-day trend signal that delay is immaterial. Cash is never
// stranded: any order still resting is excluded from spendable balance by BalanceEx, and the stale
// sweep clears it next run.
export async function krakenBuyMakerAttempt(
  symbol: string,
  usd: number,
  waitMs: number,
): Promise<{ filled: boolean; filledUsd: number; volume: number; txid?: string; price?: number; note: string }> {
  let txid: string | undefined;
  try {
    const lim = await krakenBuyLimitPostOnly(symbol, usd, false);
    txid = lim.txid?.[0];
    if (!txid) return { filled: false, filledUsd: 0, volume: 0, note: "limit accepted but no txid returned" };
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await krakenOrderStatus(txid);
      if (st.status === "closed") {
        // Kraken reports cost and fee separately; the actual USD debited is cost + fee.
        return { filled: true, filledUsd: st.cost + st.fee, volume: st.volExec, txid, price: lim.price, note: `maker fill @ $${lim.price}` };
      }
      if (st.status === "canceled" || st.status === "expired") break;
    }
  } catch (e) {
    // The order may or may not have landed. Do not guess — fall through to the cancel-and-report
    // path below, which reconciles against Kraken rather than against local state.
    if (!txid) return { filled: false, filledUsd: 0, volume: 0, note: `maker not placed (${e})` };
  }
  // Unfilled or partially filled: cancel and report exactly what Kraken says happened.
  try { await krakenCancelOrder(txid!); } catch { /* may already be closed or cancelled */ }
  try {
    const st = await krakenOrderStatus(txid!);
    if (st.volExec > 0) {
      return { filled: true, filledUsd: st.cost + st.fee, volume: st.volExec, txid, note: `partial maker fill $${(st.cost + st.fee).toFixed(0)}` };
    }
  } catch { /* status unreadable — treat as no fill; the next run reconciles from real balances */ }
  return { filled: false, filledUsd: 0, volume: 0, txid, note: "no maker fill — retry next cycle" };
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
