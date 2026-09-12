import assert from "node:assert/strict";
import test from "node:test";
import { applyReduceOnlyReceipts, parseStopReceipt, preserveAcceptedResponse, receiptConfirms, type StopReceipt } from "../src/lib/kraken-private-state";
import type { OpenOrder } from "../src/lib/kraken";

const receipt: StopReceipt = { pair: "XBTUSD:BTNL", side: "sell", ordertype: "stop-loss", volume: 1, price: 97, acceptedAt: "2026-09-12T00:00:00Z" };
const order: OpenOrder = { txid: "accepted-stop", pair: "XXBTZUSD:BTNL", side: "sell", ordertype: "stop-loss", vol: 1, volExec: 0, price: 97, opentm: 1 };

test("a matching accepted receipt confirms only that exact stop", () => {
  const receipts = new Map([[order.txid, receipt]]);
  assert.equal(receiptConfirms(order, receipt), true);
  assert.equal(applyReduceOnlyReceipts([order], receipts)[0].reduceOnly, true);
  assert.equal(applyReduceOnlyReceipts([{ ...order, txid: "another-stop" }], receipts)[0].reduceOnly, undefined);
  assert.equal(order.reduceOnly, undefined, "read-back enrichment does not mutate input");
});

test("explicit broker flags always override receipt inference", () => {
  const receipts = new Map([[order.txid, receipt]]);
  for (const reduceOnly of [false, true]) {
    const result = applyReduceOnlyReceipts([{ ...order, reduceOnly }], receipts);
    assert.equal(result[0].reduceOnly, reduceOnly);
    assert.equal(receiptConfirms({ ...order, reduceOnly }, receipt), false);
  }
});

test("receipt mismatch blocks reconciliation instead of repeatedly replacing orders", () => {
  const receipts = new Map([[order.txid, receipt]]);
  const changes: Partial<OpenOrder>[] = [
    { pair: "XBTUSD" }, { pair: "ETHUSD:BTNL" }, { side: "buy" },
    { ordertype: "trailing-stop" }, { vol: 2 }, { price: 96 },
  ];
  for (const change of changes) {
    assert.equal(receiptConfirms({ ...order, ...change }, receipt), false);
    assert.throws(() => applyReduceOnlyReceipts([{ ...order, ...change }], receipts), /differs from its reduce-only receipt/);
  }
});

test("partial execution does not invalidate the accepted original volume", () => {
  assert.equal(receiptConfirms({ ...order, volExec: 0.4 }, receipt), true);
});

test("corrupt persisted receipts fail closed instead of becoming missing evidence", () => {
  assert.deepEqual(parseStopReceipt(JSON.stringify(receipt)), receipt);
  for (const raw of ["null", "{}", "not json", JSON.stringify({ ...receipt, volume: 0 }), JSON.stringify({ ...receipt, price: null }), JSON.stringify({ ...receipt, acceptedAt: "unknown" })]) {
    assert.throws(() => parseStopReceipt(raw));
  }
});

test("successful broker/database completion does not run recovery", async () => {
  const result = { txid: ["accepted-id"] };
  let recoveries = 0;
  assert.equal(await preserveAcceptedResponse(async (capture) => { capture(result); return result; }, async () => { recoveries++; }), result);
  assert.equal(recoveries, 0);
});

test("database failure after broker acceptance retries bookkeeping, never submission", async () => {
  let submissions = 0, recoveries = 0;
  const accepted = { txid: ["accepted-id"], descr: { order: "sell stop" } };
  const result = await preserveAcceptedResponse(async (capture) => {
    submissions++;
    capture(accepted);
    throw new Error("commit failed");
  }, async (value) => { recoveries++; assert.equal(value, accepted); });
  assert.equal(result, accepted);
  assert.equal(submissions, 1);
  assert.equal(recoveries, 1);
});

test("pre-acceptance failures cannot be mistaken for accepted orders", async () => {
  let recoveries = 0;
  await assert.rejects(preserveAcceptedResponse(async () => {
    throw new Error("lock timeout before submission");
  }, async () => { recoveries++; }), /lock timeout before submission/);
  assert.equal(recoveries, 0);
});

test("irrecoverable accepted response identifies the order without replaying it", async () => {
  let submissions = 0, recoveries = 0;
  await assert.rejects(preserveAcceptedResponse(async (capture) => {
    submissions++;
    capture({ txid: ["accepted-id"] });
    throw new Error("commit failed");
  }, async () => { recoveries++; throw new Error("database unavailable"); }), /Broker accepted request.*accepted-id/);
  assert.equal(submissions, 1);
  assert.equal(recoveries, 1);
});
