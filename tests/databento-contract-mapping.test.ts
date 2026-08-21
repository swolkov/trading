import assert from "node:assert/strict";
import test from "node:test";
import { contractMappingMatchesBroker, selectFreshContractMapping } from "../src/lib/databento-contract-mapping";

const NOW = 1_000_000;
const MAX_AGE = 90_000;

test("exact micro mapping wins even when the full-size sibling is a different month", () => {
  const selected = selectFreshContractMapping(["MNQ", "NQ"], [
    { symbol: "NQ", rawContract: "NQZ6", timestampMs: NOW - 1_000 },
    { symbol: "MNQ", rawContract: "MNQU6", timestampMs: NOW - 2_000 },
  ], NOW, MAX_AGE);
  assert.equal(selected?.rawContract, "MNQU6");
});

test("full-size sibling is used only when the exact micro row is unavailable", () => {
  const selected = selectFreshContractMapping(["MGC", "GC"], [
    { symbol: "GC", rawContract: "GCZ6", timestampMs: NOW - 1_000 },
  ], NOW, MAX_AGE);
  assert.equal(selected?.rawContract, "GCZ6");
});

test("stale, future-dated, and wrong-prefix mappings fail closed", () => {
  assert.equal(selectFreshContractMapping(["MES", "ES"], [
    { symbol: "MES", rawContract: "MESU6", timestampMs: NOW - MAX_AGE },
    { symbol: "ES", rawContract: "NQU6", timestampMs: NOW - 1_000 },
  ], NOW, MAX_AGE), null);
  assert.equal(selectFreshContractMapping(["MES"], [
    { symbol: "MES", rawContract: "MESU6", timestampMs: NOW + 1 },
  ], NOW, MAX_AGE), null);
});

test("runtime alignment accepts exact and sibling rows only for the broker delivery month", () => {
  assert.equal(contractMappingMatchesBroker("MNQ", "MNQ", "MNQU6", "MNQU6"), true);
  assert.equal(contractMappingMatchesBroker("MGC", "GC", "GCZ6", "MGCZ6"), true);
  assert.equal(contractMappingMatchesBroker("MES", "ES", "ESZ6", "MESU6"), false);
  assert.equal(contractMappingMatchesBroker("MES", "ES", "NQZ6", "MESZ6"), false);
});
