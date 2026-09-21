import assert from "node:assert/strict";
import test from "node:test";
import { assertCompleteOptionsSnapshot } from "../src/lib/options-snapshot-validation";

test("real account collector rejects incomplete, wrong-account and malformed snapshots", () => {
  const complete = {
    account: { accountNumber: "685528705", type: "limited_margin", optionLevel: "3", cash: 500, buyingPower: 500, optionsValue: 0, totalValue: 500 },
    positions: [], orders: [], positionsComplete: true, ordersComplete: true,
  };
  assert.doesNotThrow(() => assertCompleteOptionsSnapshot(complete));
  for (const changed of [
    { positions: undefined }, { orders: undefined }, { positionsComplete: false }, { ordersComplete: false },
    { account: { ...complete.account, accountNumber: "wrong" } },
    { account: { ...complete.account, buyingPower: Number.NaN } },
    { positions: [{ chain_symbol: "SPY", type: "long", quantity: "bad", average_price: "1" }] },
    { orders: [{ id: "1", chain_symbol: "", state: "queued", quantity: 1 }] },
  ]) assert.throws(() => assertCompleteOptionsSnapshot({ ...complete, ...changed }));
});
