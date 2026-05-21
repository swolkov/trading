// ============ TRADOVATE REST API CLIENT ============
// Fully automated futures trading — API keys, no gateway needed.
// Paper: demo.tradovateapi.com | Live: live.tradovateapi.com

import { getTradingMode, type TradingMode } from "./trading-mode";

// Auth credentials from env vars
const TRADOVATE_USERNAME = process.env.TRADOVATE_USERNAME || "";
const TRADOVATE_PASSWORD = process.env.TRADOVATE_PASSWORD || "";
const TRADOVATE_APP_ID = process.env.TRADOVATE_APP_ID || "";
const TRADOVATE_APP_VERSION = process.env.TRADOVATE_APP_VERSION || "1.0";
const TRADOVATE_CID = process.env.TRADOVATE_CID || "";
const TRADOVATE_SEC = process.env.TRADOVATE_SEC || "";

const DEMO_URL = "https://demo.tradovateapi.com/v1";
const LIVE_URL = "https://live.tradovateapi.com/v1";

// Per-mode token cache — prevents live token being used for demo requests (and vice versa)
const _tokenCache: Record<string, { token: string; expires: number; accountId: number }> = {};

// Legacy accountId — used by order placement functions (agent execution path).
// These always use getTradingMode() (no view override) so this stays consistent.
let _accountId = 0;

async function getBaseUrl(modeOverride?: TradingMode): Promise<string> {
  const mode = modeOverride ?? await getTradingMode("futures");
  return mode === "live" ? LIVE_URL : DEMO_URL;
}

async function resolveMode(modeOverride?: TradingMode): Promise<TradingMode> {
  return modeOverride ?? await getTradingMode("futures");
}

// ============ AUTHENTICATION ============

async function authenticate(modeOverride?: TradingMode): Promise<string> {
  const mode = await resolveMode(modeOverride);
  const cached = _tokenCache[mode];

  // Return cached token if still valid for this mode
  if (cached && Date.now() < cached.expires) return cached.token;

  // Check for shared token from Railway engine (saves a Tradovate auth call)
  // The engine saves its token to DB after authenticating — Vercel crons/API reuse it
  try {
    const { prisma } = await import("./db");
    const shareKey = mode === "live" ? "tradovate_live_shared_token" : "tradovate_demo_shared_token";
    const shared = await prisma.agentConfig.findUnique({ where: { key: shareKey } });
    if (shared?.value) {
      const { token, expires, accountId: savedAcctId } = JSON.parse(shared.value);
      const expMs = new Date(expires).getTime();
      if (token && expMs > Date.now() + 300_000) { // At least 5 min remaining
        _tokenCache[mode] = { token, expires: expMs, accountId: savedAcctId || 0 };
        if (savedAcctId) _accountId = savedAcctId;
        return token;
      }
    }
    // Also check bootstrap token
    const bootstrapKey = mode === "live" ? "tradovate_live_bootstrap_token" : "tradovate_bootstrap_token";
    const bootstrap = await prisma.agentConfig.findUnique({ where: { key: bootstrapKey } });
    if (bootstrap?.value) {
      const { token, expires } = JSON.parse(bootstrap.value);
      const expMs = new Date(expires).getTime();
      if (token && expMs > Date.now()) {
        _tokenCache[mode] = { token, expires: expMs, accountId: 0 };
        await prisma.agentConfig.delete({ where: { key: bootstrapKey } }).catch(() => {});
        return token;
      }
    }
  } catch { /* DB lookup optional — fall through to direct auth */ }

  const baseUrl = mode === "live" ? LIVE_URL : DEMO_URL;

  const res = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TRADOVATE_USERNAME,
      password: TRADOVATE_PASSWORD,
      appId: TRADOVATE_APP_ID,
      appVersion: TRADOVATE_APP_VERSION,
      deviceId: "esbueno-vercel-agent",
      cid: parseInt(TRADOVATE_CID) || 0,
      sec: TRADOVATE_SEC,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tradovate auth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  _tokenCache[mode] = {
    token: data.accessToken,
    // Token valid for ~24 hours, refresh at 23 hours
    expires: Date.now() + 23 * 60 * 60 * 1000,
    accountId: 0,
  };

  return data.accessToken;
}

async function tvFetch(path: string, options?: RequestInit, modeOverride?: TradingMode): Promise<unknown> {
  const mode = await resolveMode(modeOverride);
  const token = await authenticate(mode);
  const baseUrl = await getBaseUrl(mode);
  const url = `${baseUrl}${path}`;

  const makeReq = (t: string) => fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${t}`,
      ...options?.headers,
    },
    signal: AbortSignal.timeout(15000),
  });

  const res = await makeReq(token);

  // Rate limit handling — wait and retry
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    const retryRes = await makeReq(token);
    if (!retryRes.ok) {
      const body = await retryRes.text().catch(() => "");
      throw new Error(`Tradovate API error ${retryRes.status} after rate limit wait: ${body}`);
    }
    return retryRes.json();
  }

  if (res.status === 401) {
    // Token expired, clear cache for this mode and re-auth
    delete _tokenCache[mode];
    const newToken = await authenticate(mode);
    const retryRes = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${newToken}`,
        ...options?.headers,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!retryRes.ok) {
      const body = await retryRes.text().catch(() => "");
      throw new Error(`Tradovate API error ${retryRes.status}: ${body}`);
    }
    return retryRes.json();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tradovate API error ${res.status}: ${body}`);
  }

  return res.json();
}

// ============ CONNECTION CHECK ============

export async function checkTradovateAuth(modeOverride?: TradingMode): Promise<{ authenticated: boolean; accountId: number; accountName: string }> {
  try {
    if (!TRADOVATE_USERNAME || !TRADOVATE_PASSWORD) {
      return { authenticated: false, accountId: 0, accountName: "" };
    }
    const mode = await resolveMode(modeOverride);
    await authenticate(mode);

    // If we got the token from DB shared cache, trust it — don't hit /account/list
    // (avoids rate limiting when Tradovate API is throttled)
    const cached = _tokenCache[mode];
    if (cached?.accountId && cached.accountId > 0) {
      _accountId = cached.accountId;
      return { authenticated: true, accountId: cached.accountId, accountName: String(cached.accountId) };
    }

    // Otherwise verify with Tradovate
    const accounts = await tvFetch("/account/list", undefined, mode) as { id: number; name: string; active: boolean }[];
    const active = accounts.find((a) => a.active) || accounts[0];
    if (active) {
      if (_tokenCache[mode]) _tokenCache[mode].accountId = active.id;
      _accountId = active.id;
      return { authenticated: true, accountId: active.id, accountName: active.name };
    }
    return { authenticated: false, accountId: 0, accountName: "" };
  } catch {
    return { authenticated: false, accountId: 0, accountName: "" };
  }
}

// ============ ACCOUNT ============

// Get accountId for a given mode (from token cache)
async function getAccountIdForMode(modeOverride?: TradingMode): Promise<number> {
  const mode = await resolveMode(modeOverride);
  const cached = _tokenCache[mode];
  if (cached?.accountId) return cached.accountId;
  // Not cached — authenticate and populate
  const auth = await checkTradovateAuth(mode);
  return auth.accountId;
}

export async function getTradovateAccountSummary(modeOverride?: TradingMode): Promise<{
  balance: number;
  netLiq: number;
  realizedPnl: number;
  unrealizedPnl: number;
  marginUsed: number;
}> {
  const accountId = await getAccountIdForMode(modeOverride);
  const mode = await resolveMode(modeOverride);
  const cashBalances = await tvFetch(`/cashBalance/getCashBalanceSnapshot?accountId=${accountId}`, undefined, mode) as {
    totalCashValue: number;
    netLiq: number;
    realizedPnL: number;
    unrealizedPnL: number;
    initialMargin: number;
  };
  return {
    balance: cashBalances.totalCashValue || 0,
    netLiq: cashBalances.netLiq || 0,
    realizedPnl: cashBalances.realizedPnL || 0,
    unrealizedPnl: cashBalances.unrealizedPnL || 0,
    marginUsed: cashBalances.initialMargin || 0,
  };
}

// ============ POSITIONS ============

export interface TradovatePosition {
  id: number;
  accountId: number;
  contractId: number;
  contractName: string;
  netPos: number;       // positive = long, negative = short
  netPrice: number;     // average entry price
  timestamp: string;
}

export async function getTradovatePositions(modeOverride?: TradingMode): Promise<TradovatePosition[]> {
  await getAccountIdForMode(modeOverride);
  const mode = await resolveMode(modeOverride);
  const positions = await tvFetch("/position/list", undefined, mode) as {
    id: number; accountId: number; contractId: number; netPos: number; netPrice: number; timestamp: string;
  }[];

  // Enrich with contract names
  const result: TradovatePosition[] = [];
  for (const pos of positions.filter((p) => p.netPos !== 0)) {
    let contractName = `Contract#${pos.contractId}`;
    try {
      const contract = await tvFetch(`/contract/item?id=${pos.contractId}`, undefined, mode) as { name: string };
      contractName = contract.name;
    } catch { /* ignore */ }
    result.push({ ...pos, contractName });
  }
  return result;
}

// ============ CONTRACT SEARCH ============

export const TRADOVATE_CONTRACTS: Record<string, { name: string; exchange: string; multiplier: number; tickSize: number }> = {
  // Full-size contracts — real money makers
  ES: { name: "E-mini S&P 500", exchange: "CME", multiplier: 50, tickSize: 0.25 },
  NQ: { name: "E-mini Nasdaq 100", exchange: "CME", multiplier: 20, tickSize: 0.25 },
  GC: { name: "Gold", exchange: "COMEX", multiplier: 100, tickSize: 0.1 },
  YM: { name: "E-mini Dow", exchange: "CBOT", multiplier: 5, tickSize: 1 },
  RTY: { name: "E-mini Russell 2000", exchange: "CME", multiplier: 50, tickSize: 0.1 },
  // Micros — for scaling in or lower conviction
  MES: { name: "Micro E-mini S&P 500", exchange: "CME", multiplier: 5, tickSize: 0.25 },
  MNQ: { name: "Micro E-mini Nasdaq 100", exchange: "CME", multiplier: 2, tickSize: 0.25 },
  MGC: { name: "Micro Gold", exchange: "COMEX", multiplier: 10, tickSize: 0.1 },
  MYM: { name: "Micro E-mini Dow", exchange: "CBOT", multiplier: 0.5, tickSize: 1 },
  M2K: { name: "Micro E-mini Russell 2000", exchange: "CME", multiplier: 5, tickSize: 0.1 },
};

export async function findContract(symbol: string): Promise<{ id: number; name: string; tickSize: number } | null> {
  try {
    // Tradovate contract names include month code: MESM5, MNQM5, etc.
    // Find the front-month contract
    const contracts = await tvFetch(`/contract/suggest?t=${symbol}&l=5`) as { id: number; name: string; tickSize: number; providerTickSize: number }[];
    if (contracts.length > 0) {
      return { id: contracts[0].id, name: contracts[0].name, tickSize: contracts[0].providerTickSize || contracts[0].tickSize };
    }

    // Fallback: search by name
    const search = await tvFetch(`/contract/find?name=${symbol}`) as { id: number; name: string; tickSize: number; providerTickSize: number };
    if (search?.id) {
      return { id: search.id, name: search.name, tickSize: search.providerTickSize || search.tickSize };
    }
    return null;
  } catch {
    return null;
  }
}

// ============ MARKET DATA ============
// Uses Tradovate md/getChart REST endpoint for OHLCV bars and quotes.
// The md/ endpoints may live on the main API server or a dedicated MD server.

const DEMO_MD_URL = "https://md-demo.tradovateapi.com/v1";
const LIVE_MD_URL = "https://md.tradovateapi.com/v1";

async function getMdBaseUrl(modeOverride?: TradingMode): Promise<string> {
  const mode = modeOverride ?? await getTradingMode("futures");
  return mode === "live" ? LIVE_MD_URL : DEMO_MD_URL;
}

// Fetch from the dedicated MD server (falls back to main API server)
async function mdFetch(path: string): Promise<unknown> {
  const token = await authenticate();
  const mdUrl = await getMdBaseUrl();

  // Try dedicated MD server first
  try {
    const res = await fetch(`${mdUrl}${path}`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return res.json();
  } catch { /* MD server unavailable, fall through */ }

  // Fall back to main API server (works on some Tradovate plans)
  return tvFetch(path);
}

export type BarData = { t: number; o: number; h: number; l: number; c: number; v: number };

export async function getBars(contractId: number, count: number = 100, barSize: string = "5min"): Promise<BarData[]> {
  const elementSize = barSize === "5min" ? 5 : barSize === "15min" ? 15 : barSize === "1h" ? 60 : barSize === "1d" ? 1 : 5;
  const underlyingType = barSize === "1d" ? "DailyBar" : "MinuteBar";

  const chartDesc = encodeURIComponent(JSON.stringify({
    underlyingType,
    elementSize,
    elementSizeUnit: "UnderlyingUnits",
  }));
  const timeRange = encodeURIComponent(JSON.stringify({ asMuchAsElements: count }));

  const data = await mdFetch(
    `/md/getChart?contractId=${contractId}&chartDescription=${chartDesc}&timeRange=${timeRange}`
  ) as { charts?: { id: number; td: number; bars: { timestamp: string; open: number; high: number; low: number; close: number; upVolume: number; downVolume: number }[] }[] };

  if (!data?.charts || data.charts.length === 0 || !data.charts[0]?.bars) return [];

  return data.charts[0].bars
    .filter((b) => b.close > 0)
    .map((b) => ({
      t: new Date(b.timestamp).getTime() / 1000,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: (b.upVolume || 0) + (b.downVolume || 0),
    }));
}

export async function getQuote(contractId: number): Promise<{ last: number; bid: number; ask: number; volume: number }> {
  // Get the latest 1-minute bar for a near-real-time price snapshot
  try {
    const bars = await getBars(contractId, 1, "5min");
    if (bars.length > 0) {
      const bar = bars[bars.length - 1];
      return { last: bar.c, bid: 0, ask: 0, volume: bar.v };
    }
  } catch { /* fall through to contract lookup */ }

  // Fallback: contract item (may have stale lastPrice)
  try {
    const q = await tvFetch(`/contract/item?id=${contractId}`) as { lastPrice?: number };
    return { last: q.lastPrice || 0, bid: 0, ask: 0, volume: 0 };
  } catch {
    return { last: 0, bid: 0, ask: 0, volume: 0 };
  }
}

// ============ ORDER MANAGEMENT ============

export interface TradovateOrderResult {
  orderId: number;
  status: string;
  warnings?: string[];
}

// Place a simple market order
export async function placeMarketOrder(params: {
  contractId: number;
  action: "Buy" | "Sell";
  quantity: number;
}): Promise<TradovateOrderResult> {
  if (!_accountId) await checkTradovateAuth();

  const data = await tvFetch("/order/placeorder", {
    method: "POST",
    body: JSON.stringify({
      accountSpec: _accountId,
      accountId: _accountId,
      action: params.action,
      symbol: params.contractId,
      orderQty: params.quantity,
      orderType: "Market",
      isAutomated: true,
    }),
  }) as { orderId: number; orderStatus?: string };

  return { orderId: data.orderId, status: data.orderStatus || "submitted" };
}

// Place bracket order: market entry + stop loss + take profit
// Uses 3 separate orders since Tradovate's OSO endpoint is unreliable
export async function placeBracketOrder(params: {
  contractId: number;
  action: "Buy" | "Sell";
  quantity: number;
  stopLoss: number;
  takeProfit: number;
}): Promise<TradovateOrderResult> {
  if (!_accountId) await checkTradovateAuth();

  const closeAction = params.action === "Buy" ? "Sell" : "Buy";

  // Get account name for accountSpec
  const accounts = await tvFetch("/account/list") as { id: number; name: string }[];
  const account = accounts.find((a) => a.id === _accountId) || accounts[0];
  const accountSpec = account?.name || String(_accountId);

  // Step 1: Place market entry
  const entryData = await tvFetch("/order/placeorder", {
    method: "POST",
    body: JSON.stringify({
      accountSpec,
      accountId: _accountId,
      action: params.action,
      symbol: params.contractId,
      orderQty: params.quantity,
      orderType: "Market",
      timeInForce: "Day",
      isAutomated: true,
    }),
  }) as { orderId: number };

  // Wait for fill then verify
  await new Promise((r) => setTimeout(r, 2000));

  // Verify entry actually filled before placing brackets
  let entryFilled = false;
  try {
    const fills = await tvFetch("/fill/list") as { orderId: number; price: number; qty: number }[];
    const entryFills = fills.filter((f) => f.orderId === entryData.orderId);
    entryFilled = entryFills.length > 0 && entryFills.reduce((s, f) => s + f.qty, 0) >= params.quantity;
  } catch {
    // Fallback: check order status
    try {
      const order = await tvFetch(`/order/item?id=${entryData.orderId}`) as { ordStatus: string };
      entryFilled = order.ordStatus === "Filled";
    } catch {}
  }

  if (!entryFilled) {
    // Cancel unfilled entry and abort — no brackets placed
    try { await tvFetch("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId: entryData.orderId }) }); } catch {}
    console.error(`[bracket] Entry order ${entryData.orderId} not filled after 2s — cancelled. No brackets placed.`);
    return { orderId: entryData.orderId, status: "entry_not_filled" };
  }

  const warnings: string[] = [];

  // Step 2: Place stop loss
  try {
    await tvFetch("/order/placeorder", {
      method: "POST",
      body: JSON.stringify({
        accountSpec,
        accountId: _accountId,
        action: closeAction,
        symbol: params.contractId,
        orderQty: params.quantity,
        orderType: "Stop",
        stopPrice: params.stopLoss,
        timeInForce: "GTC",
        isAutomated: true,
      }),
    });
  } catch (err) {
    const msg = `Stop placement FAILED at $${params.stopLoss}: ${err}. Agent hard stop will backstop.`;
    console.error(`[bracket] ${msg}`);
    warnings.push(msg);
  }

  // Step 3: Place take profit
  try {
    await tvFetch("/order/placeorder", {
      method: "POST",
      body: JSON.stringify({
        accountSpec,
        accountId: _accountId,
        action: closeAction,
        symbol: params.contractId,
        orderQty: params.quantity,
        orderType: "Limit",
        price: params.takeProfit,
        timeInForce: "GTC",
        isAutomated: true,
      }),
    });
  } catch (err) {
    const msg = `Target placement FAILED at $${params.takeProfit}: ${err}. Agent will manage exit.`;
    console.error(`[bracket] ${msg}`);
    warnings.push(msg);
  }

  return { orderId: entryData.orderId, status: "submitted", warnings: warnings.length > 0 ? warnings : undefined };
}

// Place a limit entry with stop + target (bracket)
// Entry only fills if price reaches the limit. Stop/target placed after fill.
export async function placeLimitBracketOrder(params: {
  contractId: number;
  action: "Buy" | "Sell";
  quantity: number;
  limitPrice: number;
  stopLoss: number;
  takeProfit: number;
}): Promise<TradovateOrderResult> {
  if (!_accountId) await checkTradovateAuth();

  const closeAction = params.action === "Buy" ? "Sell" : "Buy";
  const accounts = await tvFetch("/account/list") as { id: number; name: string }[];
  const account = accounts.find((a) => a.id === _accountId) || accounts[0];
  const accountSpec = account?.name || String(_accountId);

  // Place limit entry (GTC — stays open until filled or cancelled by next agent run)
  const entryData = await tvFetch("/order/placeorder", {
    method: "POST",
    body: JSON.stringify({
      accountSpec,
      accountId: _accountId,
      action: params.action,
      symbol: params.contractId,
      orderQty: params.quantity,
      orderType: "Limit",
      price: params.limitPrice,
      timeInForce: "Day", // expires end of day if not filled
      isAutomated: true,
    }),
  }) as { orderId: number };

  // Wait for entry fill before placing bracket orders (prevent orphaned stops/targets)
  // Poll for up to 30 seconds (limit orders may take time)
  let filled = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const orderStatus = await tvFetch(`/order/item?id=${entryData.orderId}`) as { ordStatus?: string };
      if (orderStatus.ordStatus === "Filled") { filled = true; break; }
      if (orderStatus.ordStatus === "Cancelled" || orderStatus.ordStatus === "Rejected") {
        return { orderId: entryData.orderId, status: "entry_not_filled" };
      }
    } catch { /* continue polling */ }
  }

  if (!filled) {
    // Entry didn't fill within 30s — return without placing brackets
    // The agent's position monitor will manage if it fills later
    return { orderId: entryData.orderId, status: "limit_pending", warnings: ["Entry not yet filled — brackets deferred to position monitor"] };
  }

  // Entry filled — now place protective bracket orders
  try {
    await tvFetch("/order/placeorder", {
      method: "POST",
      body: JSON.stringify({
        accountSpec,
        accountId: _accountId,
        action: closeAction,
        symbol: params.contractId,
        orderQty: params.quantity,
        orderType: "Stop",
        stopPrice: params.stopLoss,
        timeInForce: "GTC",
        isAutomated: true,
      }),
    });
  } catch { /* agent monitors positions as backup */ }

  try {
    await tvFetch("/order/placeorder", {
      method: "POST",
      body: JSON.stringify({
        accountSpec,
        accountId: _accountId,
        action: closeAction,
        symbol: params.contractId,
        orderQty: params.quantity,
        orderType: "Limit",
        price: params.takeProfit,
        timeInForce: "GTC",
        isAutomated: true,
      }),
    });
  } catch { /* agent monitors positions as backup */ }

  return { orderId: entryData.orderId, status: "limit_filled" };
}

// Cancel an order (with single retry)
export async function cancelOrder(orderId: number): Promise<void> {
  try {
    await tvFetch(`/order/cancelorder`, {
      method: "POST",
      body: JSON.stringify({ orderId }),
    });
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await tvFetch(`/order/cancelorder`, {
        method: "POST",
        body: JSON.stringify({ orderId }),
      });
    } catch {
      throw firstErr;
    }
  }
}

// Place a stop order (for protecting positions after scale-out etc.)
export async function placeStopOrder(params: {
  contractId: number;
  action: "Buy" | "Sell";
  quantity: number;
  stopPrice: number;
}): Promise<TradovateOrderResult> {
  if (!_accountId) await checkTradovateAuth();
  const accounts = await tvFetch("/account/list") as { id: number; name: string }[];
  const account = accounts.find((a) => a.id === _accountId) || accounts[0];
  const accountSpec = account?.name || String(_accountId);

  const data = await tvFetch("/order/placeorder", {
    method: "POST",
    body: JSON.stringify({
      accountSpec,
      accountId: _accountId,
      action: params.action,
      symbol: params.contractId,
      orderQty: params.quantity,
      orderType: "Stop",
      stopPrice: params.stopPrice,
      timeInForce: "GTC",
      isAutomated: true,
    }),
  }) as { orderId: number; orderStatus?: string };

  return { orderId: data.orderId, status: data.orderStatus || "submitted" };
}

// Get open orders
export async function getOpenOrders(modeOverride?: TradingMode): Promise<{ id: number; action: string; orderType: string; orderQty: number; orderStatus: string; contractId: number }[]> {
  const mode = await resolveMode(modeOverride);
  const orders = await tvFetch("/order/list", undefined, mode) as { id: number; action: string; orderType: string; orderQty: number; ordStatus: string; contractId: number }[];
  return orders
    .filter((o) => o.ordStatus === "Working" || o.ordStatus === "Accepted")
    .map((o) => ({ ...o, orderStatus: o.ordStatus }));
}

// Get fill history from Tradovate (actual executed trades)
export interface TradovateFill {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;
  tradeDate: { year: number; month: number; day: number };
  action: string; // "Buy" or "Sell"
  qty: number;
  price: number;
  active: boolean;
}

export async function getTradovateFills(modeOverride?: TradingMode): Promise<TradovateFill[]> {
  try {
    const mode = await resolveMode(modeOverride);
    const fills = await tvFetch("/fill/list", undefined, mode) as TradovateFill[];
    return Array.isArray(fills) ? fills : [];
  } catch {
    return [];
  }
}

// Resolve a Tradovate contractId to a symbol (MES, MNQ, etc.)
// Get historical cash balance logs (daily settlement records)
export async function getCashBalanceLogs(): Promise<{ id: number; accountId: number; timestamp: string; tradeDate: { year: number; month: number; day: number }; currencyId: number; amount: number; realizedPnL: number; weekRealizedPnL: number }[]> {
  try {
    const logs = await tvFetch(`/cashBalanceLog/ldeps?masterid=${_accountId}`) as unknown[];
    return (Array.isArray(logs) ? logs : []) as { id: number; accountId: number; timestamp: string; tradeDate: { year: number; month: number; day: number }; currencyId: number; amount: number; realizedPnL: number; weekRealizedPnL: number }[];
  } catch {
    return [];
  }
}

export async function resolveContractSymbol(contractId: number): Promise<string | null> {
  try {
    const contract = await tvFetch(`/contract/item?id=${contractId}`) as { name: string };
    if (contract?.name) {
      for (const sym of Object.keys(TRADOVATE_CONTRACTS)) {
        if (contract.name.startsWith(sym)) return sym;
      }
    }
    return null;
  } catch {
    return null;
  }
}
