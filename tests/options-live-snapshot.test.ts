import assert from "node:assert/strict";
import test from "node:test";
import { readLiveSnapshot, saveLiveSnapshot } from "../src/lib/options-quote-store";

// The Robinhood Live Account page shows exactly what the desk session pushed, with an age.
// Round-trip the snapshot and make sure a foreign-agent order survives untouched — the page
// and System Health both key their red flag off `placedAgent`.
test("live snapshot round-trips with its timestamp and keeps placedAgent verbatim", async () => {
  await saveLiveSnapshot({
    positions: [{ symbol: "IREN", type: "long", optionType: "call", strike: 37, expiry: "2026-11-20", quantity: 1, averagePrice: 11.6, pendingQuantity: 0 }],
    orders: [{ id: "o1", symbol: "IREN", state: "filled", strategy: "long_call", side: "debit", quantity: 1, processedQuantity: 1, premium: 1160, price: 11.6, orderType: "limit", placedAgent: "agentic", createdAt: "2026-09-11T14:00:00Z" }],
  });
  const s = await readLiveSnapshot();
  assert.ok(s);
  assert.equal(s.positions.length, 1);
  assert.equal(s.orders[0].placedAgent, "agentic");
  assert.ok(s.minutesAgo >= 0 && s.minutesAgo < 5, "fresh just after writing");
  // Leave the real state behind: the account currently holds nothing and has no orders.
  await saveLiveSnapshot({ positions: [], orders: [] });
  const back = await readLiveSnapshot();
  assert.deepEqual(back?.positions, []);
  assert.deepEqual(back?.orders, []);
});
