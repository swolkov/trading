import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRollChains } from "../src/lib/futures-desk-status";
import { normaliseRow } from "../src/lib/futures-desk";

test("normaliseRow: bigint order ids become numbers and Dates become ISO strings", () => {
  const r = normaliseRow({ id: 1, entry_order_id: BigInt(632115024898), stop_order_id: null, exit_order_id: BigInt(7), opened_at: new Date("2026-09-14T22:05:00Z"), closed_at: null, note: "x" });
  assert.equal(r.entry_order_id, 632115024898);
  assert.equal(typeof r.exit_order_id, "number");
  assert.equal(r.opened_at, "2026-09-14T22:05:00.000Z");
  assert.equal(r.closed_at, null);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("mergeRollChains: a rolled position counts once with the summed P&L; an open successor keeps it open", () => {
  const rows = [
    { id: 1, status: "closed", exit_reason: "roll", pnl_usd: -40, rolled_from: null },
    { id: 2, status: "closed", exit_reason: "roll", pnl_usd: 100, rolled_from: 1 },
    { id: 3, status: "closed", exit_reason: "stop", pnl_usd: -30, rolled_from: 2 },
    { id: 4, status: "closed", exit_reason: "roll", pnl_usd: 10, rolled_from: null },
    { id: 5, status: "open", exit_reason: null, pnl_usd: null, rolled_from: 4 },
    { id: 6, status: "closed", exit_reason: "rule", pnl_usd: 55, rolled_from: null },
  ];
  const out = mergeRollChains(rows);
  assert.deepEqual(out.map((r) => r.id), [3, 5, 6]);
  assert.equal(out.find((r) => r.id === 3)!.pnl_usd, 30);          // −40 + 100 − 30
  assert.equal(out.find((r) => r.id === 5)!.status, "open");
  assert.equal(out.find((r) => r.id === 6)!.pnl_usd, 55);
});

test("mergeRollChains: a closed successor whose earlier leg is not yet settled is not counted as resolved", () => {
  const rows = [
    { id: 1, status: "closed", exit_reason: "roll", pnl_usd: null, rolled_from: null },
    { id: 2, status: "closed", exit_reason: "stop", pnl_usd: -30, rolled_from: 1 },
  ];
  const out = mergeRollChains(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].pnl_usd, null);
});
