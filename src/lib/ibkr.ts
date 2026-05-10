// ============ INTERACTIVE BROKERS CLIENT PORTAL API ============
// REST API for futures trading (MES, MNQ, MYM, M2K)
// Requires IBKR Client Portal Gateway running or OAuth2 token

import { getIBKRConfig } from "./trading-mode";

let IBKR_BASE_URL = process.env.IBKR_BASE_URL || "https://localhost:5000/v1/api";
let IBKR_ACCOUNT_ID = process.env.IBKR_ACCOUNT_ID || "";

// Sync IBKR config from trading mode (paper vs live)
async function syncIBKRConfig() {
  try {
    const config = await getIBKRConfig();
    IBKR_BASE_URL = config.baseUrl;
    IBKR_ACCOUNT_ID = config.accountId;
  } catch {
    // keep defaults (paper)
  }
}

// Known contract IDs for micro futures (these are static and never change)
export const FUTURES_CONTRACTS: Record<string, { name: string; exchange: string; multiplier: number; tickSize: number; margin: number }> = {
  MES: { name: "Micro E-mini S&P 500", exchange: "CME", multiplier: 5, tickSize: 0.25, margin: 1320 },
  MNQ: { name: "Micro E-mini Nasdaq 100", exchange: "CME", multiplier: 2, tickSize: 0.25, margin: 1630 },
  MYM: { name: "Micro E-mini Dow", exchange: "CBOT", multiplier: 0.5, tickSize: 1, margin: 880 },
  M2K: { name: "Micro E-mini Russell 2000", exchange: "CME", multiplier: 5, tickSize: 0.1, margin: 730 },
};

interface IBKRResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

async function ibkrFetch(path: string, options?: RequestInit): Promise<IBKRResponse> {
  await syncIBKRConfig();
  const url = `${IBKR_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`IBKR API error ${res.status}: ${body}`);
  }

  return res.json();
}

// ============ AUTHENTICATION ============

export async function checkAuth(): Promise<{ authenticated: boolean; accountId: string }> {
  try {
    const data = await ibkrFetch("/iserver/auth/status", { method: "POST" });
    return { authenticated: data.authenticated || false, accountId: IBKR_ACCOUNT_ID };
  } catch {
    return { authenticated: false, accountId: "" };
  }
}

export async function keepAlive(): Promise<void> {
  await ibkrFetch("/tickle", { method: "POST" });
}

// ============ ACCOUNT ============

export async function getIBKRAccount(): Promise<IBKRResponse> {
  const accounts = await ibkrFetch("/iserver/accounts");
  return accounts;
}

export async function getIBKRPositions(): Promise<IBKRResponse[]> {
  const data = await ibkrFetch(`/portfolio/${IBKR_ACCOUNT_ID}/positions/0`);
  return Array.isArray(data) ? data : [];
}

export async function getIBKRAccountSummary(): Promise<IBKRResponse> {
  const data = await ibkrFetch(`/portfolio/${IBKR_ACCOUNT_ID}/summary`);
  return data;
}

// ============ CONTRACT SEARCH ============

export async function searchFuturesContract(symbol: string): Promise<{ conid: number; symbol: string; exchange: string; expiry: string } | null> {
  try {
    const data = await ibkrFetch(`/iserver/secdef/search`, {
      method: "POST",
      body: JSON.stringify({ symbol, secType: "FUT", exchange: FUTURES_CONTRACTS[symbol]?.exchange || "CME" }),
    });

    if (Array.isArray(data) && data.length > 0) {
      // Get the front-month contract (nearest expiry)
      const contract = data[0];
      if (contract.sections) {
        const futSection = contract.sections.find((s: IBKRResponse) => s.secType === "FUT");
        if (futSection?.months) {
          // Get first available month (front month)
          const frontMonth = futSection.months.split(";")[0];
          // Get conid for this month
          const strikes = await ibkrFetch(`/iserver/secdef/info?conid=${contract.conid}&sectype=FUT&month=${frontMonth}`);
          if (Array.isArray(strikes) && strikes.length > 0) {
            return {
              conid: strikes[0].conid,
              symbol: strikes[0].symbol || symbol,
              exchange: strikes[0].exchange || FUTURES_CONTRACTS[symbol]?.exchange || "CME",
              expiry: strikes[0].maturityDate || frontMonth,
            };
          }
        }
      }
    }
    return null;
  } catch (err) {
    console.error(`[ibkr] Failed to search contract for ${symbol}:`, err);
    return null;
  }
}

// ============ MARKET DATA ============

export async function getFuturesSnapshot(conid: number): Promise<{ last: number; bid: number; ask: number; high: number; low: number; volume: number }> {
  // Request market data snapshot
  const data = await ibkrFetch(`/iserver/marketdata/snapshot?conids=${conid}&fields=31,84,85,86,87,88`, {
    method: "GET",
  });

  const snap = Array.isArray(data) ? data[0] : data;
  return {
    last: parseFloat(snap?.["31"] || snap?.last_price || "0"),
    bid: parseFloat(snap?.["84"] || snap?.bid || "0"),
    ask: parseFloat(snap?.["85"] || snap?.ask || "0"),
    high: parseFloat(snap?.["86"] || snap?.high || "0"),
    low: parseFloat(snap?.["87"] || snap?.low || "0"),
    volume: parseInt(snap?.["88"] || snap?.volume || "0"),
  };
}

export async function getFuturesBars(conid: number, period: string = "1d", bar: string = "5min"): Promise<{ t: number; o: number; h: number; l: number; c: number; v: number }[]> {
  const data = await ibkrFetch(`/iserver/marketdata/history?conid=${conid}&period=${period}&bar=${bar}`);
  return (data.data || []).map((b: IBKRResponse) => ({
    t: b.t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
}

// ============ ORDER MANAGEMENT ============

export interface FuturesOrder {
  conid: number;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: "MKT" | "LMT" | "STP" | "STP_LIMIT";
  price?: number;       // for LMT orders
  auxPrice?: number;    // for STP orders (stop price)
  tif: "DAY" | "GTC" | "IOC";
}

export async function placeFuturesOrder(order: FuturesOrder): Promise<{ orderId: string; status: string }> {
  const body = {
    orders: [{
      acctId: IBKR_ACCOUNT_ID,
      conid: order.conid,
      secType: `${order.conid}:FUT`,
      orderType: order.orderType,
      side: order.side,
      quantity: order.quantity,
      tif: order.tif,
      ...(order.price && { price: order.price }),
      ...(order.auxPrice && { auxPrice: order.auxPrice }),
    }],
  };

  const data = await ibkrFetch(`/iserver/account/${IBKR_ACCOUNT_ID}/orders`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  // IBKR may return a confirmation message that needs to be replied to
  if (Array.isArray(data) && data[0]?.id) {
    // Confirm the order
    const confirmData = await ibkrFetch(`/iserver/reply/${data[0].id}`, {
      method: "POST",
      body: JSON.stringify({ confirmed: true }),
    });

    if (Array.isArray(confirmData) && confirmData[0]?.order_id) {
      return { orderId: confirmData[0].order_id, status: confirmData[0].order_status || "submitted" };
    }
  }

  // Direct order response
  if (Array.isArray(data) && data[0]?.order_id) {
    return { orderId: data[0].order_id, status: data[0].order_status || "submitted" };
  }

  throw new Error(`Unexpected order response: ${JSON.stringify(data)}`);
}

// Place bracket order: entry + stop loss + take profit as one atomic group
export async function placeBracketOrder(params: {
  conid: number;
  side: "BUY" | "SELL";
  quantity: number;
  stopLoss: number;
  takeProfit: number;
}): Promise<{ orderId: string; status: string }> {
  const closeSide = params.side === "BUY" ? "SELL" : "BUY";
  const cOID = `bracket_${Date.now()}`;

  const body = {
    orders: [
      // Parent: market entry
      {
        acctId: IBKR_ACCOUNT_ID,
        conid: params.conid,
        secType: `${params.conid}:FUT`,
        orderType: "MKT",
        side: params.side,
        quantity: params.quantity,
        tif: "GTC",
        cOID,
      },
      // Child 1: stop loss
      {
        acctId: IBKR_ACCOUNT_ID,
        conid: params.conid,
        secType: `${params.conid}:FUT`,
        orderType: "STP",
        side: closeSide,
        quantity: params.quantity,
        auxPrice: params.stopLoss,
        tif: "GTC",
        parentId: cOID,
      },
      // Child 2: take profit
      {
        acctId: IBKR_ACCOUNT_ID,
        conid: params.conid,
        secType: `${params.conid}:FUT`,
        orderType: "LMT",
        side: closeSide,
        quantity: params.quantity,
        price: params.takeProfit,
        tif: "GTC",
        parentId: cOID,
      },
    ],
  };

  const data = await ibkrFetch(`/iserver/account/${IBKR_ACCOUNT_ID}/orders`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  // Handle confirmation prompts
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item.id && !item.order_id) {
        await ibkrFetch(`/iserver/reply/${item.id}`, {
          method: "POST",
          body: JSON.stringify({ confirmed: true }),
        });
      }
    }
    const orderResult = data.find((d) => d.order_id);
    if (orderResult) {
      return { orderId: orderResult.order_id, status: orderResult.order_status || "submitted" };
    }
  }

  throw new Error(`Bracket order response unexpected: ${JSON.stringify(data)}`);
}

export async function cancelFuturesOrder(orderId: string): Promise<void> {
  await ibkrFetch(`/iserver/account/${IBKR_ACCOUNT_ID}/order/${orderId}`, {
    method: "DELETE",
  });
}

export async function getFuturesOrders(): Promise<IBKRResponse[]> {
  const data = await ibkrFetch("/iserver/account/orders");
  return data.orders || [];
}
