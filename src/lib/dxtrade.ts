// DXtrade REST client — the prop account's broker (Tradeify 247 runs on DXtrade).
//
// Spec: https://demo.dx.trade/developers/#/DXtrade-REST-API (the "DXSCA" API). Verified
// against Tradeify's instance on 2026-09-11: token login works, /users, /accounts/portfolio,
// /accounts/metrics and /instruments answer; /marketdata is NOT permitted for this login
// ("No proper permission is configured"), so prices come from Kraken, never from here.
//
// Design rules, in order of importance:
//   1. Every request has a timeout. A hung broker call on a trading path is worse than an error.
//   2. The session token is cached per instance and renewed on 401. Login is limited to 1/s
//      per IP, so a cron that logs in on every call would lock itself out.
//   3. Mutating calls are explicit functions with typed bodies — no generic "send anything".
//   4. Nothing here decides WHETHER to trade. That is prop-rules.ts + prop-desk.ts.

import dns from "node:dns";

const TIMEOUT_MS = 8_000;
const UA = "esbueno-prop-desk/1.0";

// Tradeify's DXtrade sits behind Cloudflare with A and AAAA records. From a dual-stack host
// the FIRST connection of a process hangs to the timeout about one time in three (measured
// 2026-09-11: ping/login/logout all affected, never the same one twice); IPv4-first removes
// most of it and the retry below covers the rest. Best-effort: not every runtime allows it.
try { dns.setDefaultResultOrder("ipv4first"); } catch { /* not permitted in this runtime */ }

export const isTimeout = (e: unknown): boolean => {
  const n = (e as { name?: string })?.name;
  return n === "TimeoutError" || n === "AbortError" || /timeout|aborted/i.test(String(e));
};

export class DxError extends Error {
  constructor(public status: number, public code: string | null, message: string, public body?: string) {
    super(message);
    this.name = "DxError";
  }
}

export function dxConfigured(): boolean {
  return Boolean(process.env.TRADEIFY_DX_BASE_URL && process.env.TRADEIFY_DX_USERNAME && process.env.TRADEIFY_DX_PASSWORD && process.env.TRADEIFY_DX_ACCOUNT);
}
export function dxAccount(): string {
  const a = process.env.TRADEIFY_DX_ACCOUNT?.trim();
  if (!a) throw new DxError(0, null, "TRADEIFY_DX_ACCOUNT not set");
  return a;
}
function baseUrl(): string {
  const b = process.env.TRADEIFY_DX_BASE_URL?.trim().replace(/\/+$/, "");
  if (!b) throw new DxError(0, null, "TRADEIFY_DX_BASE_URL not set");
  return b;
}
const enc = (s: string) => encodeURIComponent(s);

// ---- session ------------------------------------------------------------------------------
let session: { token: string; expiresAt: number } | null = null;

async function rawFetch(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(baseUrl() + path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA, ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
}

async function login(): Promise<string> {
  const body = { username: process.env.TRADEIFY_DX_USERNAME, domain: process.env.TRADEIFY_DX_DOMAIN?.trim() || "default", password: process.env.TRADEIFY_DX_PASSWORD };
  let res: Response;
  try { res = await rawFetch("POST", "/login", body); }
  catch (e) {
    if (!isTimeout(e)) throw e;
    // A hung first connection, not a refusal: one fresh attempt (login is limited to 1/s per IP).
    await new Promise((r) => setTimeout(r, 1100));
    res = await rawFetch("POST", "/login", body);
  }
  const text = await res.text();
  if (!res.ok) throw new DxError(res.status, codeOf(text), `login failed: ${descOf(text) ?? res.status}`, text);
  const j = JSON.parse(text) as { sessionToken?: string; timeout?: string };
  if (!j.sessionToken) throw new DxError(res.status, null, "login: no sessionToken in response", text);
  // timeout is "HH:MM:SS" of inactivity; renew well inside it.
  const [h, m, s] = (j.timeout ?? "00:30:00").split(":").map((x) => parseInt(x, 10) || 0);
  const ttlMs = Math.max(60_000, ((h * 3600 + m * 60 + s) * 1000) * 0.6);
  session = { token: j.sessionToken, expiresAt: Date.now() + ttlMs };
  return j.sessionToken;
}

async function token(): Promise<string> {
  if (session && session.expiresAt > Date.now()) return session.token;
  return login();
}

function codeOf(text: string): string | null {
  try { const j = JSON.parse(text); return j?.errorCode != null ? String(j.errorCode) : null; } catch { return null; }
}
function descOf(text: string): string | null {
  try { const j = JSON.parse(text); return typeof j?.description === "string" ? j.description : null; } catch { return null; }
}

/** One authenticated call. Renews the session once on 401; retries once on 429 after a pause. */
async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, extra?: Record<string, string>): Promise<{ data: T; etag: string | null; status: number }> {
  let tok = await token();
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try { res = await rawFetch(method, path, body, { Authorization: `DXAPI ${tok}`, ...(extra ?? {}) }); }
    catch (e) {
      if (!isTimeout(e)) throw e;
      // GET / PUT (If-Match) / DELETE (If-Match) are safe to send again. A POST that places an
      // order is NOT — it may have landed. Surface it as TIMEOUT and let the order helper look
      // the order up by its client id instead of guessing.
      if (method !== "POST" && attempt < 2) continue;
      throw new DxError(0, "TIMEOUT", `${method} ${path}: timed out after ${TIMEOUT_MS}ms`);
    }
    const text = await res.text();
    if (res.status === 401 && attempt === 0) { session = null; tok = await login(); continue; }
    if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 1100)); continue; }
    if (!res.ok) throw new DxError(res.status, codeOf(text), `${method} ${path} → ${res.status} ${descOf(text) ?? text.slice(0, 160)}`, text);
    // Every call that succeeds keeps the session alive — extend our own expiry estimate.
    if (session) session.expiresAt = Math.max(session.expiresAt, Date.now() + 10 * 60_000);
    const data = (text ? JSON.parse(text) : {}) as T;
    return { data, etag: res.headers.get("etag"), status: res.status };
  }
  throw new DxError(0, null, `${method} ${path}: gave up`);
}

// ---- reads --------------------------------------------------------------------------------
export interface DxMetrics {
  account: string; version: number; equity: number; balance: number; availableBalance: number; availableFunds: number;
  credit: number; marginFree: number; openPL: number; totalPL: number; margin: number; openPositionsCount: number; openOrdersCount: number;
}
export interface DxPosition {
  account: string; version: number; positionCode: string; symbol: string; quantity: number; quantityNotional: number;
  side: "BUY" | "SELL"; openTime: string; openPrice: number; takeProfitPrice?: number; stopLossPrice?: number; lastUpdateTime: string;
}
export interface DxOrder {
  account: string; orderId: number; orderCode: string; version: number; clientOrderId: string; actionCode: string;
  type: "MARKET" | "LIMIT" | "STOP"; instrument: string; status: string; finalStatus: boolean; side: "BUY" | "SELL"; tif: string;
  // Tradeify's instance reports a working stop's trigger in legs[0].price (not stopPrice).
  legs?: { instrument?: string; positionCode?: string; positionEffect?: string; quantity?: number; filledQuantity?: number; remainingQuantity?: number; averagePrice?: number; price?: number; stopPrice?: number; limitPrice?: number }[];
  links?: { linkType: string; linkedOrder: string; linkedClientOrderId?: string }[];
  issueTime: string; transactionTime: string;
  metadata?: Record<string, string>;
  executions?: { status?: string; filledQuantity?: number; lastQuantity?: number; transactionTime?: string; rejectReason?: string }[];
}
export interface DxInstrument {
  type: string; symbol: string; version: number; description: string; priceIncrement: number; pipSize: number;
  currency?: string; lotSize: number; multiplier: number; firstCurrency?: string; quantityIncrement?: number;
}
export interface DxAccountStatus { account: string; accountStatus: string; positionBased: boolean; baseCurrency: string; registrationTime: string }

export async function dxMetrics(): Promise<DxMetrics> {
  const acct = dxAccount();
  const { data } = await call<{ metrics: DxMetrics[] }>("GET", `/accounts/${enc(acct)}/metrics`);
  const m = data.metrics?.[0];
  if (!m) throw new DxError(200, null, "metrics: empty");
  return m;
}
export async function dxAccountStatus(): Promise<DxAccountStatus> {
  const acct = dxAccount();
  const { data } = await call<{ userDetails: { accounts: DxAccountStatus[] }[] }>("GET", "/users");
  const a = data.userDetails?.flatMap((u) => u.accounts ?? []).find((x) => x.account === acct);
  if (!a) throw new DxError(200, null, `account ${acct} not on this login`);
  return a;
}
export async function dxPositions(): Promise<{ positions: DxPosition[]; etag: string | null }> {
  const { data, etag } = await call<{ positions: DxPosition[] }>("GET", `/accounts/${enc(dxAccount())}/positions`);
  const positions = (data.positions ?? []).map((p) => ({
    ...p, positionCode: String(p.positionCode), quantity: Number(p.quantity), openPrice: Number(p.openPrice),
    stopLossPrice: p.stopLossPrice != null ? Number(p.stopLossPrice) : undefined,
  }));
  return { positions, etag };
}
export async function dxOpenOrders(): Promise<{ orders: DxOrder[]; etag: string | null }> {
  const { data, etag } = await call<{ orders: DxOrder[] }>("GET", `/accounts/${enc(dxAccount())}/orders`);
  return { orders: data.orders ?? [], etag };
}
export async function dxInstrument(symbol: string): Promise<DxInstrument | null> {
  const { data } = await call<{ instruments: DxInstrument[] }>("GET", `/instruments/${enc(symbol)}`);
  return data.instruments?.find((i) => i.symbol === symbol) ?? null;
}
/** Order history for the account (closed + open). `from` ISO; DXtrade pages by `limit`. */
export async function dxOrderHistory(fromIso: string, limit = 200): Promise<DxOrder[]> {
  const { data } = await call<{ orders: DxOrder[] }>("GET", `/accounts/${enc(dxAccount())}/orders/history?from=${enc(fromIso)}&limit=${limit}`);
  return data.orders ?? [];
}

// ---- writes -------------------------------------------------------------------------------
export interface DxOrderResponse { orderId: number; updateOrderId: number }

/** The spec shows a bare object or array; Tradeify's instance answers `{ orders: [...] }`. Accept all three. */
function orderResponses(data: unknown): DxOrderResponse[] {
  if (Array.isArray(data)) return data as DxOrderResponse[];
  const d = data as { orders?: DxOrderResponse[]; orderResponses?: DxOrderResponse[]; orderId?: number };
  if (Array.isArray(d?.orderResponses)) return d.orderResponses;
  if (Array.isArray(d?.orders)) return d.orders;
  if (d && typeof d.orderId === "number") return [d as DxOrderResponse];
  return [];
}

/**
 * Units step by price level. DXtrade exposes no quantityIncrement for these instruments
 * (instrument details come back empty for this login); Tradeify rejected 0.001 BTC with
 * "minimum trade size must be equal to or exceed 0.01", so BTC-priced coins step at 0.01.
 * Rounding DOWN never risks more than planned.
 */
export function dxQuantityStep(price: number): number {
  if (price >= 1000) return 0.01;
  if (price >= 100) return 0.1;
  return 1;
}

/** A price as a plain decimal string (no exponent, no float tail) — up to 10 places, trailing zeros trimmed. */
export function fmtPx(px: number): string {
  return px.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

/** Client order codes must be unique per account: prefix + ms + random. */
export function dxOrderCode(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Open a position with a MARKET order and a contingent STOP protection in ONE request
 * (IF-THEN group), so the position is never on the book naked — the stop is armed the moment
 * the market order fills. Returns the parent order id, which on a position-based account is
 * also the positionCode of the position it opened.
 */
export async function dxOpenWithStop(p: {
  symbol: string; side: "BUY" | "SELL"; quantity: string; stopPrice: number; codePrefix: string; metadata?: Record<string, string>;
}): Promise<{ parent: DxOrderResponse; stop: DxOrderResponse | null; parentCode: string; stopCode: string }> {
  const parentCode = dxOrderCode(`${p.codePrefix}o`);
  const stopCode = dxOrderCode(`${p.codePrefix}s`);
  const closeSide = p.side === "BUY" ? "SELL" : "BUY";
  const body = {
    orders: [
      { type: "MARKET", orderCode: parentCode, instrument: p.symbol, quantity: p.quantity, positionEffect: "OPEN", side: p.side, tif: "GTC", ...(p.metadata ? { metadata: p.metadata } : {}) },
      { type: "STOP", orderCode: stopCode, instrument: p.symbol, quantity: "0", positionEffect: "CLOSE", side: closeSide, stopPrice: fmtPx(p.stopPrice), tif: "GTC", ...(p.metadata ? { metadata: p.metadata } : {}) },
    ],
    contingencyType: "IF-THEN",
  };
  let list: DxOrderResponse[];
  try {
    const { data } = await call<unknown>("POST", `/accounts/${enc(dxAccount())}/orders`, body);
    list = orderResponses(data);
    if (!list[0]) throw new DxError(200, null, `open+stop: unrecognised response ${JSON.stringify(data).slice(0, 200)}`);
  } catch (e) {
    if (!(e instanceof DxError && e.code === "TIMEOUT")) throw e;
    const found = await recoverByClientId(parentCode);
    if (!found) throw e;
    list = [found];
  }
  return { parent: list[0], stop: list[1] ?? null, parentCode, stopCode };
}

/** Attach a STOP protection to an already-open position (used to re-protect a naked one). */
export async function dxAttachStop(p: { symbol: string; positionCode: string; positionSide: "BUY" | "SELL"; stopPrice: number; codePrefix: string; metadata?: Record<string, string> }): Promise<{ resp: DxOrderResponse; code: string }> {
  const code = dxOrderCode(`${p.codePrefix}s`);
  const body = {
    orderCode: code, type: "STOP", instrument: p.symbol, quantity: "0", positionEffect: "CLOSE", positionCode: p.positionCode,
    side: p.positionSide === "BUY" ? "SELL" : "BUY", stopPrice: fmtPx(p.stopPrice), tif: "GTC", ...(p.metadata ? { metadata: p.metadata } : {}),
  };
  const data = await postOrder(body, code);
  return { resp: data, code };
}

/** POST one order; on a timeout, find it by client id before concluding anything. */
async function postOrder(body: unknown, clientCode: string): Promise<DxOrderResponse> {
  try {
    const { data } = await call<unknown>("POST", `/accounts/${enc(dxAccount())}/orders`, body);
    const r = orderResponses(data)[0];
    if (!r) throw new DxError(200, null, `order: unrecognised response ${JSON.stringify(data).slice(0, 200)}`);
    return r;
  } catch (e) {
    if (!(e instanceof DxError && e.code === "TIMEOUT")) throw e;
    const found = await recoverByClientId(clientCode);
    if (!found) throw e;
    return found;
  }
}

/** After a timed-out POST: did the order land? Look it up by our client order id. */
async function recoverByClientId(clientCode: string): Promise<DxOrderResponse | null> {
  for (let i = 0; i < 2; i++) {
    try {
      const hist = await dxOrderHistory(new Date(Date.now() - 5 * 60_000).toISOString(), 50);
      const o = hist.find((x) => x.clientOrderId === clientCode);
      if (o) return { orderId: o.orderId, updateOrderId: o.orderId };
    } catch { /* try once more */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * Move a working STOP. PUT needs the whole order and an If-Match ETag (the open-orders list
 * sends one). 412 = the book moved under us → re-read and retry once. Anything else throws;
 * the caller decides whether to fall back to attach-then-cancel.
 */
export async function dxModifyStop(order: DxOrder, newStopPrice: number, etag: string | null): Promise<DxOrderResponse> {
  const acct = dxAccount();
  const leg = order.legs?.[0];
  const body = {
    orderCode: order.orderCode, instrument: order.instrument, quantity: "0", positionEffect: "CLOSE",
    ...(leg?.positionCode ? { positionCode: leg.positionCode } : {}), side: order.side, stopPrice: fmtPx(newStopPrice), tif: order.tif || "GTC",
    ...(order.metadata ? { metadata: order.metadata } : {}),
  };
  let tag = etag;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data } = await call<DxOrderResponse>("PUT", `/accounts/${enc(acct)}/orders`, body, tag ? { "If-Match": tag } : {});
      return data;
    } catch (e) {
      if (e instanceof DxError && e.status === 412 && attempt === 0) { tag = (await dxOpenOrders()).etag; continue; }
      throw e;
    }
  }
  throw new DxError(412, null, "modify stop: precondition failed twice");
}

/** Cancel one working order by its code (If-Match from the open-orders list). */
export async function dxCancelOrder(orderCode: string, etag: string | null): Promise<void> {
  const acct = dxAccount();
  let tag = etag;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await call<unknown>("DELETE", `/accounts/${enc(acct)}/orders/${enc(orderCode)}`, undefined, tag ? { "If-Match": tag } : {});
      return;
    } catch (e) {
      if (e instanceof DxError && e.status === 412 && attempt === 0) { tag = (await dxOpenOrders()).etag; continue; }
      throw e;
    }
  }
}

/** Close a position at market. Quantity 0 + positionCode = the whole position. */
export async function dxClosePosition(p: { symbol: string; positionCode: string; positionSide: "BUY" | "SELL"; codePrefix: string; metadata?: Record<string, string> }): Promise<{ resp: DxOrderResponse; code: string }> {
  const code = dxOrderCode(`${p.codePrefix}c`);
  const body = {
    orderCode: code, type: "MARKET", instrument: p.symbol, quantity: "0", positionEffect: "CLOSE", positionCode: p.positionCode,
    side: p.positionSide === "BUY" ? "SELL" : "BUY", tif: "GTC", ...(p.metadata ? { metadata: p.metadata } : {}),
  };
  const data = await postOrder(body, code);
  return { resp: data, code };
}

/** Flatten everything and cancel every working order — the kill switch. */
export async function dxBulkClose(comment: string, instrument?: string): Promise<void> {
  await call<unknown>("POST", `/accounts/${enc(dxAccount())}/close`, { closePositions: true, cancelOrders: true, comment, ...(instrument ? { instrument } : {}) });
}

export async function dxLogout(): Promise<void> {
  if (!session) return;
  try { await call<unknown>("POST", "/logout"); } catch { /* best effort */ }
  session = null;
}

/** Our coins trade as `COIN/USD` on Tradeify's DXtrade (verified: 307 instruments, all 26 present). */
export function dxSymbolFor(coin: string): string {
  return `${coin.toUpperCase()}/USD`;
}
export function coinOfDxSymbol(symbol: string): string {
  return symbol.split("/")[0].toUpperCase();
}
