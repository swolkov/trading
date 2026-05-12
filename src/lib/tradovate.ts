// ============ TRADOVATE REST API CLIENT ============
// Fully automated futures trading — API keys, no gateway needed.
// Paper: demo.tradovateapi.com | Live: live.tradovateapi.com

import { getTradingMode } from "./trading-mode";

// Auth credentials from env vars
const TRADOVATE_USERNAME = process.env.TRADOVATE_USERNAME || "";
const TRADOVATE_PASSWORD = process.env.TRADOVATE_PASSWORD || "";
const TRADOVATE_APP_ID = process.env.TRADOVATE_APP_ID || "";
const TRADOVATE_APP_VERSION = process.env.TRADOVATE_APP_VERSION || "1.0";
const TRADOVATE_CID = process.env.TRADOVATE_CID || "";
const TRADOVATE_SEC = process.env.TRADOVATE_SEC || "";

const DEMO_URL = "https://demo.tradovateapi.com/v1";
const LIVE_URL = "https://live.tradovateapi.com/v1";

// Token cache
let _accessToken = "";
let _tokenExpires = 0;
let _accountId = 0;

async function getBaseUrl(): Promise<string> {
  const mode = await getTradingMode("futures");
  return mode === "live" ? LIVE_URL : DEMO_URL;
}

// ============ AUTHENTICATION ============

async function authenticate(): Promise<string> {
  // Return cached token if still valid
  if (_accessToken && Date.now() < _tokenExpires) return _accessToken;

  const baseUrl = await getBaseUrl();

  const res = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TRADOVATE_USERNAME,
      password: TRADOVATE_PASSWORD,
      appId: TRADOVATE_APP_ID,
      appVersion: TRADOVATE_APP_VERSION,
      deviceId: "esbueno-trading-agent",
      cid: parseInt(TRADOVATE_CID) || 0,
      sec: TRADOVATE_SEC,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tradovate auth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  _accessToken = data.accessToken;
  // Token valid for ~24 hours, refresh at 23 hours
  _tokenExpires = Date.now() + 23 * 60 * 60 * 1000;

  return _accessToken;
}

async function tvFetch(path: string, options?: RequestInit): Promise<unknown> {
  const token = await authenticate();
  const baseUrl = await getBaseUrl();
  const url = `${baseUrl}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...options?.headers,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 401) {
    // Token expired, re-auth and retry
    _accessToken = "";
    _tokenExpires = 0;
    const newToken = await authenticate();
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

export async function checkTradovateAuth(): Promise<{ authenticated: boolean; accountId: number; accountName: string }> {
  try {
    if (!TRADOVATE_USERNAME || !TRADOVATE_PASSWORD) {
      return { authenticated: false, accountId: 0, accountName: "" };
    }
    await authenticate();
    const accounts = await tvFetch("/account/list") as { id: number; name: string; active: boolean }[];
    const active = accounts.find((a) => a.active) || accounts[0];
    if (active) {
      _accountId = active.id;
      return { authenticated: true, accountId: active.id, accountName: active.name };
    }
    return { authenticated: false, accountId: 0, accountName: "" };
  } catch {
    return { authenticated: false, accountId: 0, accountName: "" };
  }
}

// ============ ACCOUNT ============

export async function getTradovateAccountSummary(): Promise<{
  balance: number;
  netLiq: number;
  realizedPnl: number;
  unrealizedPnl: number;
  marginUsed: number;
}> {
  if (!_accountId) await checkTradovateAuth();
  const cashBalances = await tvFetch(`/cashBalance/getCashBalanceSnapshot?accountId=${_accountId}`) as {
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

export async function getTradovatePositions(): Promise<TradovatePosition[]> {
  if (!_accountId) await checkTradovateAuth();
  const positions = await tvFetch("/position/list") as {
    id: number; accountId: number; contractId: number; netPos: number; netPrice: number; timestamp: string;
  }[];

  // Enrich with contract names
  const result: TradovatePosition[] = [];
  for (const pos of positions.filter((p) => p.netPos !== 0)) {
    let contractName = `Contract#${pos.contractId}`;
    try {
      const contract = await tvFetch(`/contract/item?id=${pos.contractId}`) as { name: string };
      contractName = contract.name;
    } catch { /* ignore */ }
    result.push({ ...pos, contractName });
  }
  return result;
}

// ============ CONTRACT SEARCH ============

export const TRADOVATE_CONTRACTS: Record<string, { name: string; exchange: string; multiplier: number; tickSize: number }> = {
  MES: { name: "Micro E-mini S&P 500", exchange: "CME", multiplier: 5, tickSize: 0.25 },
  MNQ: { name: "Micro E-mini Nasdaq 100", exchange: "CME", multiplier: 2, tickSize: 0.25 },
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

export async function getQuote(contractId: number): Promise<{ last: number; bid: number; ask: number; volume: number }> {
  const quote = await tvFetch(`/md/getChart?contractId=${contractId}&chartDescription=%7B%22underlyingType%22%3A%22MinuteBar%22%2C%22elementSize%22%3A1%2C%22elementSizeUnit%22%3A%22UnderlyingUnits%22%7D&timeRange=%7B%22asMuchAsElements%22%3A1%7D`) as {
    charts?: { bp?: number; ap?: number; lp?: number; vs?: number }[];
  };

  // Simpler approach: use the contract's last quote
  const q = await tvFetch(`/contract/item?id=${contractId}`) as { lastPrice?: number };
  return {
    last: q.lastPrice || 0,
    bid: 0,
    ask: 0,
    volume: 0,
  };
}

export async function getBars(contractId: number, count: number = 100, barSize: string = "5min"): Promise<{ t: number; o: number; h: number; l: number; c: number; v: number }[]> {
  const elementSize = barSize === "5min" ? 5 : barSize === "15min" ? 15 : barSize === "1d" ? 1440 : 5;

  const chartDesc = JSON.stringify({
    underlyingType: elementSize >= 1440 ? "DailyBar" : "MinuteBar",
    elementSize: elementSize >= 1440 ? 1 : elementSize,
    elementSizeUnit: "UnderlyingUnits",
  });
  const timeRange = JSON.stringify({ asMuchAsElements: count });

  const data = await tvFetch(
    `/md/getChart?contractId=${contractId}&chartDescription=${encodeURIComponent(chartDesc)}&timeRange=${encodeURIComponent(timeRange)}`
  ) as { charts?: { id: number; td: number; bars: { timestamp: string; open: number; high: number; low: number; close: number; upVolume: number; downVolume: number }[] }[] };

  if (!data.charts || data.charts.length === 0) return [];

  return data.charts[0].bars.map((b) => ({
    t: new Date(b.timestamp).getTime() / 1000,
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: (b.upVolume || 0) + (b.downVolume || 0),
  }));
}

// ============ ORDER MANAGEMENT ============

export interface TradovateOrderResult {
  orderId: number;
  status: string;
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

  // Wait for fill
  await new Promise((r) => setTimeout(r, 2000));

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
  } catch { /* stop order optional — agent monitors positions */ }

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
  } catch { /* target order optional — agent monitors positions */ }

  return { orderId: entryData.orderId, status: "submitted" };
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

  // Place stop loss (GTC — protects if limit fills)
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

  // Place take profit (GTC)
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

  return { orderId: entryData.orderId, status: "limit_submitted" };
}

// Cancel an order
export async function cancelOrder(orderId: number): Promise<void> {
  await tvFetch(`/order/cancelorder`, {
    method: "POST",
    body: JSON.stringify({ orderId }),
  });
}

// Get open orders
export async function getOpenOrders(): Promise<{ id: number; action: string; orderType: string; orderQty: number; orderStatus: string; contractId: number }[]> {
  const orders = await tvFetch("/order/list") as { id: number; action: string; orderType: string; orderQty: number; ordStatus: string; contractId: number }[];
  return orders
    .filter((o) => o.ordStatus === "Working" || o.ordStatus === "Accepted")
    .map((o) => ({ ...o, orderStatus: o.ordStatus }));
}
