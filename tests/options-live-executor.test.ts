import assert from "node:assert/strict";
import test from "node:test";
import {
  OPTIONS_LIVE_ACCOUNT, optionsRequestFingerprint, prepareOptionsOrder,
  type OptionsLiveIntent, type OptionsLivePolicy, type OptionsBrokerSnapshot,
  type LiveContract, type OptionOrderParams, type OwnedOptionsPosition,
} from "../src/lib/options-live-policy";
import { executeOptionsIntent, reconcileOptionsIntent, type OptionsExecutorDependencies, type OptionsIntentRecord } from "../src/lib/options-live-executor";

const NOW = Date.parse("2026-09-14T15:00:00Z");
const REF = "12345678-1234-4234-8234-123456789abc";
const REF2 = "12345678-1234-4234-8234-123456789abd";
const contract = (optionId: string, strike = 100, kind: "call" | "put" = "call"): LiveContract => ({
  optionId, underlying: "SPY", kind, strike, expiry: "2026-12-18", multiplier: 100,
  bid: 1.4, ask: 1.5, quoteAtMs: NOW,
});
const intent = (): OptionsLiveIntent => ({ refId: REF, action: "open", kind: "long_call", quantity: 1, limitPrice: 1.5, legs: [{ optionId: "A", side: "buy" }] });
function fixture() {
  const policy: OptionsLivePolicy = { armed: true, maxLossUsd: 500, feeBudgetUsd: 10, guardianHealthyAtMs: NOW };
  const snapshot: OptionsBrokerSnapshot = { accountNumber: OPTIONS_LIVE_ACCOUNT, active: true, agenticAllowed: true,
    optionLevel: "option_level_3", marginType: "limited_margin", asOfMs: NOW, complete: true, buyingPowerUsd: 500,
    regularSession: { opensAtMs: NOW - 3600_000, closesAtMs: NOW + 3600_000 }, positions: [], orders: [], contracts: [contract("A")] };
  const records = new Map<string, OptionsIntentRecord>();
  const owned = new Map<string, OwnedOptionsPosition>();
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  let lock: Promise<void> = Promise.resolve();
  const deps: OptionsExecutorDependencies = {
    now: () => NOW, policy: async () => policy,
    broker: {
      responseSchemasVerified: true,
      snapshot: async () => structuredClone(snapshot),
      decodeReview: (x) => x, decodeOrder: (x) => x,
      callTool: async (name, params) => {
        calls.push({ name, params });
        const { ref_id, ...withoutRef } = params;
        const requestFingerprint = optionsRequestFingerprint(withoutRef as unknown as OptionOrderParams);
        if (name === "review_option_order") return { approved: true, accountNumber: OPTIONS_LIVE_ACCOUNT, requestFingerprint,
          asOfMs: NOW, maxLossUsd: 150, estimatedFeeUsd: 1, buyingPowerRequiredUsd: 151 };
        return { id: "broker-1", refId: ref_id, accountNumber: OPTIONS_LIVE_ACCOUNT, requestFingerprint, state: "open", filledQuantity: 0 };
      },
    },
    store: {
      withAccountLock: async (_account, run) => {
        const prior = lock;
        let unlock!: () => void;
        lock = new Promise<void>((resolve) => { unlock = resolve; });
        await prior;
        try { return await run(); } finally { unlock(); }
      },
      getIntent: async (id) => records.get(id) ?? null,
      putIntent: async (record) => { records.set(record.refId, structuredClone(record)); },
      unsettledIntents: async () => [...records.values()].filter((r) => r.state !== "settled"),
      ownedPosition: async (id) => owned.get(id) ?? null,
    },
  };
  return { deps, policy, snapshot, records, owned, calls };
}

test("disabled response adapter and missing risk/fee authorization cannot submit", async () => {
  for (const change of ["adapter", "risk", "fees", "disarm"] as const) {
    const f = fixture();
    if (change === "adapter") f.deps.broker.responseSchemasVerified = false;
    if (change === "risk") f.policy.maxLossUsd = null;
    if (change === "fees") f.policy.feeBudgetUsd = null;
    if (change === "disarm") f.policy.armed = false;
    assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "refused");
    assert.equal(f.calls.length, 0);
  }
});

test("review precedes durable reservation and one exact limit submission", async () => {
  const f = fixture();
  const send = f.deps.broker.callTool;
  f.deps.broker.callTool = async (name, args) => {
    if (name === "place_option_order") assert.equal(f.records.get(REF)?.state, "submitting");
    return send(name, args);
  };
  assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "accepted");
  assert.deepEqual(f.calls.map((c) => c.name), ["review_option_order", "place_option_order"]);
  assert.deepEqual(f.calls[1].params, { account_number: OPTIONS_LIVE_ACCOUNT,
    legs: [{ option_id: "A", side: "buy", position_effect: "open", ratio_quantity: 1 }], quantity: "1",
    direction: "debit", type: "limit", price: "1.50", time_in_force: "gfd", market_hours: "regular_hours", ref_id: REF });
  assert.equal(f.records.get(REF)?.state, "accepted");
});

test("account, quote, session, guardian, slot and loss gates all fail before review", async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => { f.snapshot.accountNumber = "another-account"; },
    (f) => { f.snapshot.agenticAllowed = false; },
    (f) => { f.snapshot.complete = false; },
    (f) => { f.snapshot.asOfMs -= 15_001; },
    (f) => { f.snapshot.contracts[0].quoteAtMs -= 15_001; },
    (f) => { f.snapshot.contracts[0].quoteAtMs += 1; },
    (f) => { f.snapshot.regularSession = null; },
    (f) => { f.policy.guardianHealthyAtMs = NOW - 60_001; },
    (f) => { f.snapshot.positions.push({ id: "manual", legs: [] }); },
    (f) => { f.policy.maxLossUsd = 159.99; },
    (f) => { f.snapshot.buyingPowerUsd = 159.99; },
    (f) => { f.snapshot.contracts[0].multiplier = 10; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "refused");
    assert.equal(f.calls.length, 0);
  }
});

test("all four same-expiry verticals derive the correct direction and bounded risk", () => {
  const shapes = [
    { kind: "call_debit", type: "call", long: 100, short: 105, direction: "debit", loss: 150 },
    { kind: "put_debit", type: "put", long: 105, short: 100, direction: "debit", loss: 150 },
    { kind: "put_credit", type: "put", long: 100, short: 105, direction: "credit", loss: 350 },
    { kind: "call_credit", type: "call", long: 105, short: 100, direction: "credit", loss: 350 },
  ] as const;
  for (const s of shapes) {
    const f = fixture();
    f.snapshot.contracts = [contract("L", s.long, s.type), contract("S", s.short, s.type)];
    const order: OptionsLiveIntent = { ...intent(), kind: s.kind, legs: [{ optionId: "S", side: "sell" }, { optionId: "L", side: "buy" }] };
    const p = prepareOptionsOrder(order, f.policy, f.snapshot, null, NOW);
    assert.equal(p.params.direction, s.direction);
    assert.equal(p.theoreticalMaxLossUsd, s.loss);
    assert.deepEqual(p.params.legs.map((l) => l.option_id), ["S", "L"], "selected legs are never substituted");
    assert.ok(p.params.legs.every((l) => l.ratio_quantity === 1));
  }
  const f = fixture(); f.snapshot.contracts[0].kind = "put";
  assert.equal(prepareOptionsOrder({ ...intent(), kind: "long_put" }, f.policy, f.snapshot, null, NOW).theoreticalMaxLossUsd, 150);
});

test("naked shorts, calendars, mismatched strikes/kinds, ratios and duplicate legs are refused", () => {
  const f = fixture();
  assert.throws(() => prepareOptionsOrder({ ...intent(), legs: [{ optionId: "A", side: "sell" }] }, f.policy, f.snapshot, null, NOW), /naked short/);
  assert.throws(() => prepareOptionsOrder({ ...intent(), quantity: 1.5 }, f.policy, f.snapshot, null, NOW), /positive integer/);
  const spread: OptionsLiveIntent = { ...intent(), kind: "call_debit", legs: [{ optionId: "A", side: "buy" }, { optionId: "B", side: "sell" }] };
  f.snapshot.contracts.push({ ...contract("B", 105), expiry: "2027-01-15" });
  assert.throws(() => prepareOptionsOrder(spread, f.policy, f.snapshot, null, NOW), /same-expiry/);
  f.snapshot.contracts[1].expiry = f.snapshot.contracts[0].expiry;
  assert.throws(() => prepareOptionsOrder({ ...spread, kind: "call_credit" }, f.policy, f.snapshot, null, NOW), /kind does not match/);
  assert.throws(() => prepareOptionsOrder({ ...spread, legs: [spread.legs[0], spread.legs[0]] }, f.policy, f.snapshot, null, NOW), /two-leg vertical/);
});

test("disarming during review prevents placement", async () => {
  const f = fixture(); const send = f.deps.broker.callTool;
  f.deps.broker.callTool = async (name, args) => { const out = await send(name, args); f.policy.armed = false; return out; };
  assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "refused");
  assert.equal(f.calls.length, 1);
});

test("disarm and an unhealthy guardian still permit the exact owned close", async () => {
  const f = fixture(); f.policy.armed = false; f.policy.guardianHealthyAtMs = null; f.policy.maxLossUsd = null;
  const position = { id: "ours", legs: [{ optionId: "A", side: "long" as const, quantity: 1 }] };
  f.snapshot.positions = [position];
  f.owned.set(position.id, { ...position, accountNumber: OPTIONS_LIVE_ACCOUNT, openingRefId: REF2 });
  const close: OptionsLiveIntent = { ...intent(), action: "close", positionId: position.id, legs: [{ optionId: "A", side: "sell" }] };
  assert.equal((await executeOptionsIntent(close, f.deps)).status, "accepted");
  assert.equal(f.calls[1].params.direction, "credit");
  assert.deepEqual(f.calls[1].params.legs, [{ option_id: "A", side: "sell", position_effect: "close", ratio_quantity: 1 }]);
  f.owned.clear();
  assert.equal((await executeOptionsIntent({ ...close, refId: REF2 }, f.deps)).status, "refused");
});

test("unrecognized review or review exceeding fees never reaches place", async () => {
  for (const bad of [{}, { approved: true }, { estimatedFeeUsd: 100 }]) {
    const f = fixture(); const send = f.deps.broker.callTool;
    f.deps.broker.callTool = async (name, args) => {
      const raw = await send(name, args);
      return "estimatedFeeUsd" in bad ? { ...(raw as object), ...bad } : bad;
    };
    assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "refused");
    assert.equal(f.calls.length, 1);
  }
});

test("lost submission response is never retried, including under a new ref_id", async () => {
  const f = fixture(); const send = f.deps.broker.callTool;
  f.deps.broker.callTool = async (name, args) => { const out = await send(name, args); if (name === "place_option_order") throw new Error("timeout after acceptance"); return out; };
  assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "unknown");
  assert.equal(f.records.get(REF)?.state, "unknown");
  assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "unknown");
  assert.equal((await executeOptionsIntent({ ...intent(), refId: REF2 }, f.deps)).status, "refused");
  assert.equal(f.calls.filter((c) => c.name === "place_option_order").length, 1);
});

test("exact ref_id reconciliation rejects other identities and accepts only one match", async () => {
  const f = fixture();
  await executeOptionsIntent(intent(), f.deps);
  const saved = f.records.get(REF)!;
  f.snapshot.orders = [{ id: "broker-1", accountNumber: OPTIONS_LIVE_ACCOUNT, refId: REF,
    requestFingerprint: "wrong", state: "filled", filledQuantity: 1 }];
  assert.equal((await reconcileOptionsIntent(REF, f.deps)).status, "unknown");
  f.snapshot.orders[0].requestFingerprint = saved.fingerprint;
  assert.equal((await reconcileOptionsIntent(REF, f.deps)).status, "accepted");
  f.snapshot.orders.push({ ...f.snapshot.orders[0], id: "duplicate" });
  assert.equal((await reconcileOptionsIntent(REF, f.deps)).status, "unknown");
  assert.equal(f.calls.filter((c) => c.name === "place_option_order").length, 1);
});

test("unrecognized placement or failed receipt persistence preserves the reservation", async () => {
  for (const mode of ["response", "receipt"] as const) {
    const f = fixture(); const send = f.deps.broker.callTool;
    if (mode === "response") f.deps.broker.decodeOrder = () => ({ success: true });
    else {
      f.deps.store.putIntent = async (r) => { if (r.state === "accepted") throw new Error("database unavailable"); f.records.set(r.refId, r); };
    }
    assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "unknown");
    assert.ok(f.records.has(REF));
    assert.equal(f.calls.filter((c) => c.name === "place_option_order").length, 1);
    f.deps.broker.callTool = send;
    await executeOptionsIntent(intent(), f.deps);
    assert.equal(f.calls.filter((c) => c.name === "place_option_order").length, 1);
  }
});

test("failed reservation prevents submission and two concurrent entries share one slot", async () => {
  const broken = fixture(); broken.deps.store.putIntent = async () => { throw new Error("storage unavailable"); };
  assert.equal((await executeOptionsIntent(intent(), broken.deps)).status, "refused");
  assert.equal(broken.calls.filter((c) => c.name === "place_option_order").length, 0);
  const f = fixture();
  const results = await Promise.all([executeOptionsIntent(intent(), f.deps), executeOptionsIntent({ ...intent(), refId: REF2 }, f.deps)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["accepted", "refused"]);
  assert.equal(f.calls.filter((c) => c.name === "place_option_order").length, 1);
});

test("cancellation with fills never releases the position reservation", async () => {
  const f = fixture(); await executeOptionsIntent(intent(), f.deps);
  f.snapshot.orders = [{ ...f.records.get(REF)!.order!, state: "cancelled", filledQuantity: 1 }];
  assert.equal((await reconcileOptionsIntent(REF, f.deps)).status, "accepted");
  f.snapshot.orders[0].filledQuantity = 0;
  assert.equal((await reconcileOptionsIntent(REF, f.deps)).status, "unknown");
  assert.equal(f.records.get(REF)?.maxFilledQuantity, 1);
  assert.equal(f.records.get(REF)?.order?.filledQuantity, 1);
  assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "unknown");
  assert.equal((await executeOptionsIntent({ ...intent(), refId: REF2 }, f.deps)).status, "refused");
  f.snapshot.orders[0].filledQuantity = 1;
  assert.equal((await reconcileOptionsIntent(REF, f.deps)).status, "accepted", "matching evidence can recover without releasing filled exposure");
  assert.equal(f.calls.filter((c) => c.name === "place_option_order").length, 1);
});

test("a known broker order ID cannot be replaced by a matching ref_id on another order", async () => {
  const f = fixture(); await executeOptionsIntent(intent(), f.deps);
  const original = f.records.get(REF)!.order!;
  f.snapshot.orders = [{ ...original, id: "different-order", state: "cancelled", filledQuantity: 0 }];
  assert.equal((await reconcileOptionsIntent(REF, f.deps)).status, "unknown");
  assert.equal(f.records.get(REF)?.order?.id, original.id);
  assert.equal(f.records.get(REF)?.state, "unknown");
  f.snapshot.orders = [{ ...original, state: "cancelled", filledQuantity: 0 }];
  assert.equal((await reconcileOptionsIntent(REF, f.deps)).status, "settled", "only the original order's verified no-fill cancellation releases it");
  assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "settled", "settled UUID is not submitted again");
});

test("a reviewed owned credit spread can close at its full width while disarmed", async () => {
  const f = fixture(); f.policy.armed = false;
  f.snapshot.contracts = [contract("L", 105), contract("S", 100)];
  const position = { id: "spread", legs: [{ optionId: "L", side: "long" as const, quantity: 1 }, { optionId: "S", side: "short" as const, quantity: 1 }] };
  f.snapshot.positions = [position];
  const owned = { ...position, accountNumber: OPTIONS_LIVE_ACCOUNT, openingRefId: REF2 };
  f.owned.set(position.id, owned);
  const close: OptionsLiveIntent = { ...intent(), action: "close", kind: "call_credit", positionId: position.id,
    limitPrice: 5, legs: [{ optionId: "L", side: "sell" }, { optionId: "S", side: "buy" }] };
  assert.equal((await executeOptionsIntent(close, f.deps)).status, "accepted");
  assert.equal(f.calls[1].params.direction, "debit");
  assert.equal(f.calls[1].params.price, "5.00");
  assert.throws(() => prepareOptionsOrder({ ...close, limitPrice: 5.01 }, f.policy, f.snapshot, owned, NOW), /close may equal the width/);
  f.policy.armed = true; f.snapshot.positions = [];
  assert.throws(() => prepareOptionsOrder({ ...close, action: "open", legs: [{ optionId: "L", side: "buy" }, { optionId: "S", side: "sell" }] }, f.policy, f.snapshot, null, NOW), /entry limit must be below/);
});

test("failed readback of an existing submission stays unknown, and broker rejection is terminal", async () => {
  const f = fixture(); await executeOptionsIntent(intent(), f.deps);
  f.deps.broker.snapshot = async () => { throw new Error("broker unavailable"); };
  assert.equal((await executeOptionsIntent(intent(), f.deps)).status, "unknown");
  assert.equal(f.calls.filter((c) => c.name === "place_option_order").length, 1);
  const rejected = fixture(); const send = rejected.deps.broker.callTool;
  rejected.deps.broker.callTool = async (name, args) => {
    const raw = await send(name, args);
    return name === "place_option_order" ? { ...(raw as object), state: "rejected" } : raw;
  };
  assert.equal((await executeOptionsIntent(intent(), rejected.deps)).status, "settled");
  assert.equal(rejected.records.get(REF)?.state, "settled");
});
