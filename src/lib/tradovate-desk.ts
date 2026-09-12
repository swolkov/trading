// TRADOVATE — the futures desk's broker calls. DEMO ONLY: every call pins mode "paper", so no
// path through this file can reach the live account whatever `futures_mode` says in the DB.
//
// Entry = ONE request (`/order/placeoso`): a market order whose bracket is the protective stop.
// The broker attaches the stop the moment the entry fills, so the position is never naked and a
// crash between two requests cannot leave an unprotected contract (the old three-request bracket
// in tradovate.ts had exactly that window).
import { tradovateAccountId, tradovateRequest } from "@/lib/tradovate";
import { ACTIVE_MONTH_CODES, monthCodeOf } from "@/lib/contract-months";
import type { TradingMode } from "@/lib/trading-mode";

const MODE: TradingMode = "paper";

export interface DxOrder { id: number; contractId: number; action: "Buy" | "Sell"; ordStatus: string; clOrdId?: string; orderType?: string; timestamp?: string }
export interface DxFill { id: number; orderId: number; contractId: number; timestamp: string; action: "Buy" | "Sell"; qty: number; price: number }
export interface DxPosition { id: number; contractId: number; netPos: number; netPrice: number; timestamp: string }
export interface OrderVersion { orderId: number; orderType?: string; stopPrice?: number; price?: number; orderQty?: number }

export async function deskAccount(): Promise<{ accountId: number; accountSpec: string }> {
  const accountId = await tradovateAccountId(MODE);
  if (!accountId) throw new Error("Tradovate demo account unavailable");
  const accounts = await tradovateRequest<{ id: number; name: string }[]>("/account/list", undefined, MODE);
  const acct = accounts.find((a) => a.id === accountId);
  return { accountId, accountSpec: acct?.name ?? String(accountId) };
}

export async function deskBalance(): Promise<{ balance: number; netLiq: number; realizedPnl: number; unrealizedPnl: number }> {
  const { accountId } = await deskAccount();
  const s = await tradovateRequest<{ totalCashValue: number; netLiq: number; realizedPnL: number; unrealizedPnL: number }>(
    `/cashBalance/getCashBalanceSnapshot?accountId=${accountId}`, undefined, MODE);
  return { balance: s.totalCashValue || 0, netLiq: s.netLiq || 0, realizedPnl: s.realizedPnL || 0, unrealizedPnl: s.unrealizedPnL || 0 };
}

/** Index contracts cash-settle: trade the front month until two days before expiry. Deliverable
 *  metals migrate to the next month weeks before first notice, so pick the month that is at least
 *  three weeks from it — that is where the volume already is. */
const ROLL_GUARD_DAYS: Record<string, number> = { MGC: 21, SIL: 21, MHG: 21 };
const DEFAULT_GUARD_DAYS = 3;
const ROOT_OF_MICRO: Record<string, string> = { MGC: "GC", SIL: "SI", MHG: "HG" };
const contractCache = new Map<string, { at: number; c: { id: number; name: string; tickSize: number } }>();

/** The month to trade: the nearest listed liquid month whose expiry (or first notice, for metals)
 *  is more than ROLL_GUARD_DAYS away — so a new position is never opened into a month the guardian
 *  would roll out of the same week. No Databento hop (tradovate.ts's findContract still has one;
 *  the subscription is cancelled and that fetch has no timeout). */
export async function deskContract(micro: string): Promise<{ id: number; name: string; tickSize: number } | null> {
  const hit = contractCache.get(micro);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.c;
  const rows = await tradovateRequest<{ id: number; name: string; tickSize: number; providerTickSize?: number }[]>(`/contract/suggest?t=${encodeURIComponent(micro)}&l=6`, undefined, MODE);
  if (!Array.isArray(rows) || !rows.length) return null;
  // Metals are listed in thin months too; keep the months that actually trade (contract-months.ts).
  const active = ACTIVE_MONTH_CODES[ROOT_OF_MICRO[micro] ?? micro];
  const liquid = active ? rows.filter((r) => active.has(monthCodeOf(micro, r.name))) : rows;
  const guardDays = ROLL_GUARD_DAYS[micro] ?? DEFAULT_GUARD_DAYS;
  for (const r of liquid.length ? liquid : rows) {
    const exp = await contractExpiry(r.id);
    if (!exp || Date.parse(exp) - Date.now() > guardDays * 86_400_000) {
      const c = { id: r.id, name: r.name, tickSize: r.providerTickSize || r.tickSize };
      contractCache.set(micro, { at: Date.now(), c });
      return c;
    }
  }
  return null;
}

export function rollGuardDays(micro: string): number { return ROLL_GUARD_DAYS[micro] ?? DEFAULT_GUARD_DAYS; }
export function forgetContract(micro: string): void { contractCache.delete(micro); }

/** Expiry of a contract (for rolls). Two hops: contract → contractMaturity. */
export async function contractExpiry(contractId: number): Promise<string | null> {
  try {
    const c = await tradovateRequest<{ contractMaturityId?: number }>(`/contract/item?id=${contractId}`, undefined, MODE);
    if (!c?.contractMaturityId) return null;
    const m = await tradovateRequest<{ expirationDate?: string; firstIntentDate?: string }>(`/contractMaturity/item?id=${c.contractMaturityId}`, undefined, MODE);
    // Physically-delivered metals must be out BEFORE first notice; index contracts cash-settle at expiry.
    return m?.firstIntentDate ?? m?.expirationDate ?? null;
  } catch { return null; }
}

export async function deskPositions(): Promise<DxPosition[]> {
  const rows = await tradovateRequest<DxPosition[]>("/position/list", undefined, MODE);
  return (Array.isArray(rows) ? rows : []).filter((p) => p.netPos !== 0);
}

export async function deskOrders(): Promise<DxOrder[]> {
  const rows = await tradovateRequest<DxOrder[]>("/order/list", undefined, MODE);
  return Array.isArray(rows) ? rows : [];
}

export function isWorking(o: DxOrder): boolean {
  return o.ordStatus === "Working" || o.ordStatus === "Accepted" || o.ordStatus === "Suspended" || o.ordStatus === "PendingNew";
}

export async function orderItem(orderId: number): Promise<DxOrder | null> {
  try { return await tradovateRequest<DxOrder>(`/order/item?id=${orderId}`, undefined, MODE); } catch { return null; }
}

/** The latest version of an order carries its stop/limit price. */
export async function orderVersion(orderId: number): Promise<OrderVersion | null> {
  try {
    const rows = await tradovateRequest<OrderVersion[]>(`/orderVersion/deps?masterid=${orderId}`, undefined, MODE);
    return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
  } catch { return null; }
}

/** Fills belong to ORDERS (not accounts): ask for a specific order's fills. Survives the session roll
 *  that empties /fill/list at 17:00 ET. */
export async function fillsForOrder(orderId: number): Promise<DxFill[]> {
  try {
    const rows = await tradovateRequest<DxFill[]>(`/fill/deps?masterid=${orderId}`, undefined, MODE);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export function avgFill(fills: DxFill[]): { qty: number; price: number } {
  const qty = fills.reduce((s, f) => s + f.qty, 0);
  const price = qty > 0 ? fills.reduce((s, f) => s + f.qty * f.price, 0) / qty : 0;
  return { qty, price };
}

/** Recover an order by our client id. Tradovate's Order entity may not echo `clOrdId`; the Command
 *  entity (one per order request) does, so both are consulted. The round trip asserts this works. */
export async function findOrderByClOrdId(clOrdId: string): Promise<DxOrder | null> {
  const orders = await deskOrders();
  const direct = orders.find((o) => o.clOrdId === clOrdId);
  if (direct) return direct;
  try {
    const cmds = await tradovateRequest<{ id: number; orderId: number; clOrdId?: string }[]>("/command/list", undefined, MODE);
    const c = (Array.isArray(cmds) ? cmds : []).find((x) => x.clOrdId === clOrdId);
    if (c?.orderId) return orders.find((o) => o.id === c.orderId) ?? (await orderItem(c.orderId));
  } catch { /* fall through */ }
  return null;
}

/** Working orders on a contract on the CLOSING side. The desk rests nothing but stops, so every one
 *  of these is a stop — no dependence on `orderType` being present on the Order entity. */
export async function workingCloseOrders(contractId: number, closeAction: "Buy" | "Sell"): Promise<DxOrder[]> {
  return (await deskOrders()).filter((o) => o.contractId === contractId && isWorking(o) && o.action === closeAction);
}

export interface OsoResult { orderId: number; stopOrderId: number | null; failure: string | null }

/** Market entry + protective stop in ONE request. `clOrdId` makes the request recoverable: if the
 *  POST times out, the caller looks the order up by clOrdId instead of sending it again. */
export async function placeEntryWithStop(p: {
  contractId: number; action: "Buy" | "Sell"; qty: number; stopPrice: number; clOrdId: string;
}): Promise<OsoResult> {
  const { accountId, accountSpec } = await deskAccount();
  const closeAction = p.action === "Buy" ? "Sell" : "Buy";
  const body = {
    accountSpec, accountId,
    action: p.action, symbol: p.contractId, orderQty: p.qty, orderType: "Market", timeInForce: "Day",
    isAutomated: true, clOrdId: p.clOrdId,
    bracket1: { action: closeAction, orderType: "Stop", stopPrice: p.stopPrice, timeInForce: "GTC" },
  };
  const r = await tradovateRequest<{ orderId?: number; oso1Id?: number; failureReason?: string; failureText?: string }>(
    "/order/placeoso", { method: "POST", body: JSON.stringify(body) }, MODE);
  if (!r?.orderId) return { orderId: 0, stopOrderId: null, failure: r?.failureText || r?.failureReason || "no orderId returned" };
  return { orderId: r.orderId, stopOrderId: r.oso1Id ?? null, failure: r.failureReason ? (r.failureText || r.failureReason) : null };
}

export async function placeStop(p: { contractId: number; action: "Buy" | "Sell"; qty: number; stopPrice: number; clOrdId: string }): Promise<number> {
  const { accountId, accountSpec } = await deskAccount();
  const r = await tradovateRequest<{ orderId?: number; failureText?: string; failureReason?: string }>("/order/placeorder", {
    method: "POST",
    body: JSON.stringify({ accountSpec, accountId, action: p.action, symbol: p.contractId, orderQty: p.qty, orderType: "Stop", stopPrice: p.stopPrice, timeInForce: "GTC", isAutomated: true, clOrdId: p.clOrdId }),
  }, MODE);
  if (!r?.orderId) throw new Error(r?.failureText || r?.failureReason || "stop not accepted");
  return r.orderId;
}

/** Move a working stop to a new price in ONE request — no cancel-then-place window with zero or
 *  two stops. Used to re-anchor the bracket to the actual fill. */
export async function modifyStop(orderId: number, qty: number, stopPrice: number): Promise<void> {
  const r = await tradovateRequest<{ failureReason?: string; failureText?: string }>("/order/modifyorder", {
    method: "POST", body: JSON.stringify({ orderId, orderQty: qty, orderType: "Stop", stopPrice, timeInForce: "GTC", isAutomated: true }),
  }, MODE);
  if (r?.failureReason) throw new Error(r.failureText || r.failureReason);
}

export async function cancelDeskOrder(orderId: number): Promise<void> {
  await tradovateRequest("/order/cancelorder", { method: "POST", body: JSON.stringify({ orderId, isAutomated: true }) }, MODE);
}

/** Close the whole position in a contract at market. Cancels nothing itself — the caller cancels the
 *  stop first so a late stop fill cannot open a reverse position. */
export async function liquidate(contractId: number): Promise<{ orderId: number | null; failure: string | null }> {
  const { accountId } = await deskAccount();
  const r = await tradovateRequest<{ orderId?: number; failureText?: string; failureReason?: string }>("/order/liquidateposition", {
    method: "POST", body: JSON.stringify({ accountId, contractId, admin: false }),
  }, MODE);
  return { orderId: r?.orderId ?? null, failure: r?.failureReason ? (r.failureText || r.failureReason) : null };
}
