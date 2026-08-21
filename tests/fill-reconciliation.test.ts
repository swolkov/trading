import assert from "node:assert/strict";
import test from "node:test";
import { matchFillsToRoundTrips, type FillLike } from "../src/lib/fill-matching";

function fill(id: number, action: "Buy" | "Sell", qty: number, price: number): FillLike {
  return {
    id,
    orderId: id,
    contractId: 7,
    timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    action,
    qty,
    price,
  };
}

test("fragmented exits produce one position-level round trip", () => {
  const trades = matchFillsToRoundTrips([
    fill(1, "Buy", 2, 100),
    fill(2, "Sell", 1, 101),
    fill(3, "Sell", 1, 103),
  ], { 7: "MES" });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].qty, 2);
  assert.equal(trades[0].entryPrice, 100);
  assert.equal(trades[0].exitPrice, 102);
  assert.equal(trades[0].pnl, 20 - 4.04);
});

test("fees make flat-price churn negative instead of falsely breakeven", () => {
  const [trade] = matchFillsToRoundTrips([
    fill(1, "Sell", 1, 100),
    fill(2, "Buy", 1, 100),
  ], { 7: "MNQ" });
  assert.equal(trade.pnl, -2.02);
});
