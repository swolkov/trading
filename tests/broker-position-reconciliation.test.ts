import assert from "node:assert/strict";
import test from "node:test";
import { reconcileBrokerPosition } from "../src/lib/broker-position-reconciliation";

test("distinguishes unavailable broker state from a confirmed flat position", () => {
  assert.deepEqual(reconcileBrokerPosition("long", 1, undefined), { status: "unresolved" });
  assert.deepEqual(reconcileBrokerPosition("long", 1, null), { status: "flat", quantity: 0 });
});

test("recognizes an indeterminate entry from the resulting broker position", () => {
  assert.deepEqual(
    reconcileBrokerPosition("long", 0, { netPos: 2, netPrice: 101.25 }),
    { status: "increased", direction: "long", quantity: 2, delta: 2, netPrice: 101.25 },
  );
});

test("calculates partial add and partial close quantities", () => {
  assert.equal(reconcileBrokerPosition("short", 2, { netPos: -3, netPrice: 99 }).status, "increased");
  assert.deepEqual(
    reconcileBrokerPosition("short", 3, { netPos: -1, netPrice: 99 }),
    { status: "reduced", direction: "short", quantity: 1, delta: 2, netPrice: 99 },
  );
});

test("flags a reversed position instead of treating it as a close", () => {
  assert.deepEqual(
    reconcileBrokerPosition("long", 1, { netPos: -1, netPrice: 98 }),
    { status: "flipped", direction: "short", quantity: 1 },
  );
});
