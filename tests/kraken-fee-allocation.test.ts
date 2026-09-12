import assert from "node:assert/strict";
import test from "node:test";
import { reconstructTrips } from "../src/lib/kraken-margin";

function fill(type: string, vol: number, fee: number, minute: number, price = 100) {
  return { txid: String(minute), pair: "ETHUSD", time: new Date(Date.UTC(2026, 8, 12, 0, minute)), type, vol, fee, price, cost: price * vol, margin: type === "buy" ? 10 : 0 };
}

test("a single close of parent and pyramid add allocates every dollar of fees", () => {
  const { trips, openPositions } = reconstructTrips([
    fill("buy", 1, 2, 0), fill("buy", 1, 3, 1), fill("sell", 2, 10, 2, 110),
  ]);
  assert.equal(openPositions, 0);
  assert.deepEqual(trips.map((t) => t.fees), [7, 8]);
  assert.equal(trips.reduce((sum, t) => sum + t.netPnl, 0), 5);
});

test("partial closes and a reversal conserve signed fees across all lots", () => {
  const rows = [fill("buy", 2, 4, 0), fill("buy", 1, 2, 1), fill("sell", 1, 1, 2), fill("sell", 4, 8, 3), fill("buy", 2, -1, 4)];
  const { trips, openPositions } = reconstructTrips(rows);
  assert.equal(openPositions, 0);
  assert.equal(trips.reduce((sum, t) => sum + t.fees, 0), rows.reduce((sum, r) => sum + r.fee, 0));
  assert.equal(trips.reduce((sum, t) => sum + t.netPnl, 0), -14);
});
