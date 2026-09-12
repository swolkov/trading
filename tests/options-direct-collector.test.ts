import test from "node:test";
import assert from "node:assert/strict";
import { collectRobinhoodAccount, unwrapRobinhoodRead, inspectRobinhoodCapabilities, directConnectionView, type RobinhoodSnapshotClient } from "../src/lib/options-direct-collector";
const NOW = Date.parse("2026-09-12T18:00:00Z");
const envelope = (data: unknown) => ({structuredContent: {data}});
function fixture() {
  const calls: {name: string; args: Record<string, unknown>}[] = [];
  const responses: Record<string, unknown> = {
    get_accounts: envelope({accounts: [{account_number: "685528705", agentic_allowed: true, state: "active", deactivated: false, permanently_deactivated: false, type: "limited_margin", option_level: "option_level_3"}]}),
    get_portfolio: envelope({currency: "USD", cash: "1500", total_value: "1500", options_value: "0", buying_power: {buying_power: "1500", display_currency: "USD"}}),
    get_option_positions: envelope({positions: []}), get_option_orders: envelope({orders: []}),
  };
  const client: RobinhoodSnapshotClient = {listTools: async () => ({}), call: async (name, args) => {calls.push({name, args});return responses[name];}};
  return {client, calls, responses};
}
const order = (id = "one") => ({id, chain_symbol: "SPY", state: "filled", type: "limit", trigger: "immediate", direction: "debit", quantity: "1", processed_quantity: "1", premium: "50", price: "0.50", placed_agent: "user", created_at: "2026-09-11T15:00:00Z"});
test("verified direct flat account collects only permitted reads with one original timestamp", async () => {
  const f = fixture(); const s = await collectRobinhoodAccount(f.client, () => NOW);
  assert.equal(s.account.buyingPower, 1500); assert.equal(s.account.at, s.live.at); assert.deepEqual(s.live.positions, []);
  assert.deepEqual(f.calls.map(c => c.name).sort(), ["get_accounts", "get_option_orders", "get_option_positions", "get_portfolio"]);
  assert.equal(f.calls.find(c => c.name === "get_option_orders")?.args.created_at_gte, undefined, "Older active orders cannot be filtered out");
});
test("pagination follows opaque cursor without fetching supplied URLs and deduplicates overlaps", async () => {
  const f = fixture(), original = f.client.call;
  f.client.call = async (name, args) => name === "get_option_orders" ? args.cursor === "two"
    ? envelope({orders: [order(), order("two")], next: null})
    : envelope({orders: [order()], next: "https://api.robinhood.com/orders?cursor=two"}) : original(name, args);
  assert.equal((await collectRobinhoodAccount(f.client, () => NOW)).live.orders.length, 2);
});
test("failed later page, malformed page and repeated cursor fail the whole collection", async () => {
  for (const bad of ["error", "malformed", "repeat"]) {
    const f = fixture(), original = f.client.call;
    f.client.call = async (name, args) => {
      if (name !== "get_option_orders") return original(name, args);
      if (args.cursor && bad === "error") return {isError: true};
      if (args.cursor && bad === "malformed") return envelope({orders: null});
      return envelope({orders: [], next: "https://api.robinhood.com/orders?cursor=again"});
    };
    await assert.rejects(collectRobinhoodAccount(f.client, () => NOW));
  }
});
test("conflicting duplicate orders are not silently replaced", async () => {
  const f=fixture();f.responses.get_option_orders=envelope({orders:[order(), {...order(),processed_quantity:"0"}]});
  await assert.rejects(collectRobinhoodAccount(f.client,()=>NOW),/Conflicting/);
});
test("missing account, inactive access and null balances never become a fresh flat account", async () => {
  for(const change of ["account","access","balance"]){
    const f=fixture();
    if(change==="account")f.responses.get_accounts=envelope({accounts:[]});
    if(change==="access")f.responses.get_accounts=envelope({accounts:[{account_number:"685528705",agentic_allowed:false}]});
    if(change==="balance")f.responses.get_portfolio=envelope({currency:"USD",cash:null,buying_power:{display_currency:"USD"}});
    await assert.rejects(collectRobinhoodAccount(f.client,()=>NOW));
  }
});
test("collection deadline preserves the source time instead of making old reads fresh", async () => {
  const f=fixture();let tick=0;await assert.rejects(collectRobinhoodAccount(f.client,()=>NOW+(tick++?120001:0)),/too old/);
});
test("structured tool errors and ambiguous text are rejected", () => {
  assert.throws(()=>unwrapRobinhoodRead({isError:true,structuredContent:{data:{orders:[]}}}));
  assert.throws(()=>unwrapRobinhoodRead({content:[{type:"text",text:"{}"},{type:"text",text:"{}"}]}));
});
test("actual broker schema shape accepts ref_id for submission but omits recovery fields", () => {
  const catalog={tools:[{name:"place_option_order",inputSchema:{properties:{ref_id:{}}},outputSchema:{properties:{data:{properties:{order:{properties:{id:{}}}}}}}},
    {name:"get_option_orders",inputSchema:{properties:{order_id:{},cursor:{}}},outputSchema:{properties:{data:{properties:{orders:{items:{properties:{id:{},legs:{}}}}}}}}}]};
  const c=inspectRobinhoodCapabilities(catalog);
  assert.equal(c.placementAcceptsRefId,true);assert.equal(c.orderLookupById,true);assert.equal(c.lookupReturnsRefId,false);assert.equal(c.placementReturnsRefId,false);assert.equal(c.lookupAcceptsRefId,false);
  const view=directConnectionView(JSON.stringify({at:new Date(NOW).toISOString(),ok:true,capabilities:{...c,schemaHash:"a".repeat(64)}}),NOW);
  assert.equal(view.lastCheckOk,true);assert.equal(view.correlationListed,false);assert.match(view.recovery,/absent/);
});
test("expired, future and failed connection checks never appear verified", () => {
  for(const s of [{at:"2026-09-10T00:00:00Z",ok:true},{at:"2026-09-13T00:00:00Z",ok:true},{at:new Date(NOW).toISOString(),ok:false}])assert.equal(directConnectionView(JSON.stringify(s),NOW).lastCheckOk,false);
  assert.equal(directConnectionView(undefined,NOW).status,"Not checked");
});

test("held positions resolve exact contract identity and preserve pending assignment activity", async () => {
  const f=fixture();
  f.responses.get_option_positions=envelope({positions:[{option_id:"held",chain_symbol:"SPY",type:"short",quantity:"1",average_price:"-40",expiration_date:"2026-10-16",pending_buy_quantity:"0",pending_sell_quantity:"0",pending_exercise_quantity:"0",pending_assignment_quantity:"1",pending_expiration_quantity:"0"}]});
  f.responses.get_option_instruments=envelope({instruments:[{id:"held",chain_symbol:"SPY",type:"put",strike_price:"100",expiration_date:"2026-10-16"}]});
  const s=await collectRobinhoodAccount(f.client,()=>NOW);
  assert.equal(s.live.positions[0].pendingQuantity,1);assert.equal(s.live.positions[0].averagePrice,-40);assert.equal(s.live.positions[0].optionType,"put");assert.equal(s.live.positions[0].strike,100);
  assert.equal(f.calls.find(c=>c.name==="get_option_instruments")?.args.account_number,undefined);
  f.responses.get_option_instruments=envelope({instruments:[]});
  await assert.rejects(collectRobinhoodAccount(f.client,()=>NOW),/metadata missing/);
});

test("missing or unsupported schema is unknown, never evidence that fields are absent", () => {
  assert.throws(()=>inspectRobinhoodCapabilities({tools:[{name:"place_option_order",inputSchema:{properties:{ref_id:{}}}},{name:"get_option_orders",inputSchema:{properties:{order_id:{}}}}]}),/Unsupported broker schema/);
});
test("older active orders stay visible alongside recent history", async () => {
  const f=fixture();f.responses.get_option_orders=envelope({orders:[{...order(),state:"confirmed",created_at:"2026-07-01T15:00:00Z",processed_quantity:"0"}]});
  const s=await collectRobinhoodAccount(f.client,()=>NOW);assert.equal(s.live.orders.length,1);assert.equal(s.live.orders[0].state,"confirmed");
});
