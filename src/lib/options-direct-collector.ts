// Read-only broker snapshots. No review, placement, cancellation or strategy decisions.
import { OPTIONS_ACCOUNT_NUMBER, assertCompleteOptionsSnapshot } from "./options-snapshot-validation";
import type { AccountSnapshot, LiveOrder, LivePosition } from "./options-quote-store";
export const OPTIONS_DIRECT_STATUS_KEY = "options_direct_connection_status";
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
function obj(x: unknown, name: string): Record<string, unknown> { if (!record(x)) throw Error(`Invalid ${name}`); return x; }
function num(x: unknown, name: string): number {
  if (!(typeof x === "number" || typeof x === "string" && x.trim() !== "") || !Number.isFinite(Number(x))) throw Error(`Invalid ${name}`);
  return Number(x);
}
function str(x: unknown, name: string): string { if (typeof x !== "string" || !x) throw Error(`Invalid ${name}`); return x; }
function optionalNum(x: unknown, name: string) { return x == null ? null : num(x, name); }
function optionalStr(x: unknown) { return typeof x === "string" && x ? x : null; }
export function unwrapRobinhoodRead(raw: unknown): Record<string, unknown> {
  const response = obj(raw, "tool response");
  if (response.isError) throw Error("Broker read returned an error");
  if (record(response.structuredContent)) return response.structuredContent;
  const text = Array.isArray(response.content) ? response.content.filter(x => record(x) && x.type === "text") : [];
  if (text.length !== 1 || typeof text[0].text !== "string") throw Error("Ambiguous broker response");
  return obj(JSON.parse(text[0].text), "broker payload");
}
export interface RobinhoodSnapshotClient {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<unknown>;
}
export interface DirectCapabilities {
  schemaHash: string; // Supplied by the collector from the actual tool catalog.
  orderLookupById: boolean;
  placementAcceptsRefId: boolean;
  placementReturnsRefId: boolean;
  lookupReturnsRefId: boolean;
  lookupAcceptsRefId: boolean;
}
export function inspectRobinhoodCapabilities(raw: unknown): Omit<DirectCapabilities, "schemaHash"> {
  const list = obj(raw, "tool catalog");
  if (!Array.isArray(list.tools)) throw Error("Tool catalog missing");
  const tools = list.tools;
  const tool = (name: string) => obj(tools.find(x => record(x) && x.name === name), `${name} schema`);
  const properties = (schema: unknown): Record<string, unknown> => {
    if (!record(schema) || !record(schema.properties)) throw Error("Unsupported broker schema structure");
    return schema.properties;
  };
  const input = (name: string) => properties(tool(name).inputSchema);
  const output = (name: string) => properties(properties(tool(name).outputSchema).data);
  const placement = properties(output("place_option_order").order);
  const orders = output("get_option_orders").orders;
  const lookup = properties(record(orders) ? orders.items : null);
  return { orderLookupById: "order_id" in input("get_option_orders"), placementAcceptsRefId: "ref_id" in input("place_option_order"),
    placementReturnsRefId: "ref_id" in placement, lookupReturnsRefId: "ref_id" in lookup, lookupAcceptsRefId: "ref_id" in input("get_option_orders") };
}
async function pages(client: RobinhoodSnapshotClient, name: string, key: string, args: Record<string, unknown>) {
  const rows: Record<string, unknown>[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 25; page++) {
    const response = unwrapRobinhoodRead(await client.call(name, {...(name === "get_option_instruments" ? {} : {account_number: OPTIONS_ACCOUNT_NUMBER}), ...args, ...(cursor ? {cursor} : {})}));
    const data = obj(response.data, `${name} data`);
    if (!Array.isArray(data[key]) || !data[key].every(record)) throw Error(`Invalid ${key} page`);
    rows.push(...data[key] as Record<string, unknown>[]);
    if (rows.length > 5000) throw Error("Snapshot exceeds collection limit");
    const next = data.next ?? response.next;
    if (next == null) return rows;
    if (typeof next !== "string" || !next) throw Error("Invalid pagination link");
    // Never fetch a broker-supplied URL: extract only its opaque cursor for the fixed tool.
    const parsed = new URL(next);
    cursor = parsed.searchParams.get("cursor") ?? undefined;
    if (!cursor || cursors.has(cursor)) throw Error("Missing or repeated pagination cursor");
    cursors.add(cursor);
  }
  throw Error("Snapshot pagination did not finish");
}
function unique(rows: Record<string, unknown>[], identity: (row: Record<string, unknown>) => string) {
  const seen = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = identity(row), prior = seen.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw Error("Conflicting duplicate broker record");
    seen.set(id, row);
  }
  return [...seen.values()];
}
export async function collectRobinhoodAccount(client: RobinhoodSnapshotClient, now = () => Date.now()) {
  const started = now();
  const accounts = obj(unwrapRobinhoodRead(await client.call("get_accounts", {})).data, "accounts").accounts;
  if (!Array.isArray(accounts)) throw Error("Accounts missing");
  const matches = accounts.filter(x => record(x) && x.account_number === OPTIONS_ACCOUNT_NUMBER);
  if (matches.length !== 1) throw Error("Expected account missing or duplicated");
  const a = obj(matches[0], "account");
  if (a.agentic_allowed !== true || a.state !== "active" || a.deactivated !== false || a.permanently_deactivated !== false) throw Error("Expected account access is not active");
  const [portfolio, positionRows, orderRows] = await Promise.all([
    client.call("get_portfolio", {account_number: OPTIONS_ACCOUNT_NUMBER}).then(unwrapRobinhoodRead),
    pages(client, "get_option_positions", "positions", {nonzero: true}),
    pages(client, "get_option_orders", "orders", {}),
  ]);
  const p = obj(portfolio.data, "portfolio");
  if (p.currency !== "USD" || obj(p.buying_power, "buying power").display_currency !== "USD") throw Error("Unsupported account currency");
  const positions = unique(positionRows, x => str(x.id ?? x.option_id ?? x.option, "position identity") + ":" + str(x.type, "position side"));
  const orders = unique(orderRows, x => str(x.id, "order ID"));
  const metadata = new Map<string, Record<string, unknown>>();
  for (const state of ["active", "expired"]) {
    const ids = [...new Set(positions.filter(x => (str(x.expiration_date, "expiration") < new Date(started).toISOString().slice(0, 10)) === (state === "expired")).map(x => str(x.option_id, "option identity")))];
    for (let offset = 0; offset < ids.length; offset += 20) {
      for (const instrument of await pages(client, "get_option_instruments", "instruments", {ids: ids.slice(offset, offset + 20).join(","), state})) {
        const id = str(instrument.id, "instrument identity");
        if (metadata.has(id) && JSON.stringify(metadata.get(id)) !== JSON.stringify(instrument)) throw Error("Conflicting instrument metadata");
        metadata.set(id, instrument);
      }
    }
  }
  for (const position of positions) {
    const instrument = metadata.get(str(position.option_id, "option identity"));
    if (!instrument || instrument.chain_symbol !== position.chain_symbol || instrument.expiration_date !== position.expiration_date
      || !["call", "put"].includes(String(instrument.type))) throw Error("Position contract metadata missing or mismatched");
    position.option_type = instrument.type;
    position.strike_price = num(instrument.strike_price, "contract strike");
    position.pending_quantity = ["pending_buy_quantity", "pending_sell_quantity", "pending_exercise_quantity", "pending_assignment_quantity", "pending_expiration_quantity"]
      .reduce((sum, key) => {const n = num(position[key], key); if (n < 0) throw Error("Invalid pending quantity"); return sum + n;}, 0);
  }
  const account = {accountNumber: OPTIONS_ACCOUNT_NUMBER, type: str(a.type, "account type"), optionLevel: typeof a.option_level === "string" ? a.option_level : "unknown",
    cash: num(p.cash, "cash"), buyingPower: num(obj(p.buying_power, "buying power").buying_power, "buying power"), optionsValue: num(p.options_value, "options value"), totalValue: num(p.total_value, "account value")};
  assertCompleteOptionsSnapshot({account, positions, orders, positionsComplete: true, ordersComplete: true});
  if (now() < started || now() - started > 120000) throw Error("Snapshot collection is too old");
  const at = new Date(started).toISOString();
  const livePositions: LivePosition[] = positions.map(x => ({symbol: str(x.chain_symbol, "symbol"), type: x.type as "long" | "short",
    optionType: x.option_type === "call" || x.option_type === "put" ? x.option_type : null, strike: optionalNum(x.strike_price, "strike"), expiry: optionalStr(x.expiration_date),
    quantity: num(x.quantity, "position quantity"), averagePrice: num(x.average_price, "average price"), pendingQuantity: x.pending_quantity == null ? 0 : num(x.pending_quantity, "pending quantity")}));
  const liveOrders: LiveOrder[] = orders.map(x => ({id: str(x.id, "order ID"), symbol: str(x.chain_symbol, "symbol"), state: str(x.state, "order state"),
    strategy: optionalStr(x.opening_strategy) ?? optionalStr(x.closing_strategy), side: optionalStr(x.direction), quantity: num(x.quantity, "order quantity"),
    processedQuantity: num(x.processed_quantity, "filled quantity"), premium: optionalNum(x.premium, "premium"), price: optionalNum(x.price, "limit"),
    orderType: `${str(x.type, "order type")}${x.trigger && x.trigger !== "immediate" ? "+" + str(x.trigger, "trigger") : ""}`,
    placedAgent: optionalStr(x.placed_agent), createdAt: optionalStr(x.created_at)}));
  return {account: {...account, at} satisfies AccountSnapshot, live: {positions: livePositions, orders: liveOrders, at}};
}
export interface DirectConnectionStatus { at: string; ok: boolean; capabilities?: DirectCapabilities; error?: string }
export function directConnectionView(raw: string | undefined, now = Date.now()) {
  let s: DirectConnectionStatus | null = null;
  try { const v = JSON.parse(raw ?? "null"); if (record(v) && typeof v.at === "string" && typeof v.ok === "boolean") s = v as unknown as DirectConnectionStatus; } catch {}
  const at = Date.parse(s?.at ?? ""), recent = Number.isFinite(at) && at <= now && now - at < 36 * 3600000;
  const c = s?.capabilities;
  const capabilitiesKnown = !!c && typeof c.schemaHash === "string" && /^[a-f0-9]{64}$/.test(c.schemaHash)
    && [c.orderLookupById, c.placementAcceptsRefId, c.placementReturnsRefId, c.lookupReturnsRefId, c.lookupAcceptsRefId].every(x => typeof x === "boolean");
  const correlationListed = capabilitiesKnown && c?.placementAcceptsRefId === true && c.placementReturnsRefId === true && c.lookupReturnsRefId === true && c.lookupAcceptsRefId === true;
  return {at: s?.at ?? null, lastCheckOk: s?.ok === true && recent, correlationListed,
    status: !s ? "Not checked" : !recent ? "Check expired" : s.ok ? "Direct reads verified" : "Last check failed",
    recovery: !capabilitiesKnown ? "Order-reference recovery capability has not been checked" : correlationListed ? "Correlation fields listed; recovery still requires verification" : "Current executor recovery requires order-reference fields absent from the broker schema"};
}
