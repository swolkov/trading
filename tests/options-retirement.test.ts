import assert from "node:assert/strict";
import test from "node:test";
import { runOptionsScan } from "../src/lib/options-run";
import { autotrackEnabled, evaluateOptionsPaper, openOptionPaperTrade } from "../src/lib/options-shadow";
import { GET } from "../src/app/api/options/paper/route";
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

test("retired options scan and legacy entry/marking calls do no database work", async () => {
  // This suite runs with an unreachable database. Every retired entry point must return
  // before reading quotes or updating a simulated position, including old CLI callers.
  const result = await runOptionsScan();
  assert.equal(result.tracking, false);
  assert.equal(result.scanned, 0);
  assert.deepEqual(result.opened, []);
  assert.equal(await autotrackEnabled(), false);
  assert.deepEqual(await evaluateOptionsPaper(), []);
  const opened = await openOptionPaperTrade({} as Parameters<typeof openOptionPaperTrade>[0]);
  assert.equal(opened.opened, false);
  assert.match(opened.reason ?? "", /retired/);
  const response = await GET();
  assert.equal(response.status, 410);
  assert.equal((await response.json()).retired, true);
});
