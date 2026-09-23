// An entry whose placement answered with an error (Sep 23 2026: QQQ, the desk jammed on "unknown" all day) is settled ONLY on the
// broker's positive proof that no order exists, after a grace window — and its ref_id is never sent again.
import assert from "node:assert/strict";
import test from "node:test";
import { OPTIONS_LIVE_ACCOUNT, optionsRequestFingerprint, type OptionOrderParams, type OptionsBrokerSnapshot, type LiveContract, type OptionsLiveIntent, type OptionsLivePolicy } from "../src/lib/options-live-policy";
import { executeOptionsIntent, reconcileOptionsIntent, NEVER_PLACED_GRACE_MS, type NeverPlacedProof, type OptionsExecutorDependencies, type OptionsIntentRecord } from "../src/lib/options-live-executor";
import { RobinhoodLiveBroker } from "../src/lib/options-live-broker";
import { brokerErrorText, unwrapRobinhoodRead } from "../src/lib/options-direct-collector";

const T0 = Date.parse("2026-09-14T15:00:00Z");
const REF = "12345678-1234-4234-8234-123456789abc";
const LEG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const contract = (): LiveContract => ({ optionId: "A", underlying: "SPY", kind: "call", strike: 100, expiry: "2026-12-18", multiplier: 100, bid: 1.4, ask: 1.5, quoteAtMs: T0 });
const intent = (action: "open" | "close" = "open"): OptionsLiveIntent => action === "open"
  ? { refId: REF, action, kind: "long_call", quantity: 1, limitPrice: 1.5, legs: [{ optionId: "A", side: "buy" }] }
  : { refId: REF, action, kind: "long_call", quantity: 1, limitPrice: 1.5, legs: [{ optionId: "A", side: "sell" }], positionId: "P1" };
const isErrorPlacement = { isError: true, content: [{ type: "text", text: "Order rejected for account 685528705: price outside the allowed band" }] };

function fixture(opts: { placement?: unknown; proof?: () => Promise<NeverPlacedProof> } = {}) {
  let now = T0;
  const policy: OptionsLivePolicy = { armed: true, maxLossUsd: 500, feeBudgetUsd: 10, guardianHealthyAtMs: T0 };
  const snapshot = (): OptionsBrokerSnapshot => ({ accountNumber: OPTIONS_LIVE_ACCOUNT, active: true, agenticAllowed: true, optionLevel: "option_level_3", marginType: "limited_margin",
    asOfMs: now, complete: true, buyingPowerUsd: 500, regularSession: { opensAtMs: T0 - 3600_000, closesAtMs: T0 + 7200_000 }, positions: [], orders: [], contracts: [contract()] });
  const records = new Map<string, OptionsIntentRecord>();
  const calls: string[] = [];
  let proofCalls = 0;
  const deps: OptionsExecutorDependencies = {
    now: () => now, policy: async () => ({ ...policy, guardianHealthyAtMs: now }),
    broker: {
      responseSchemasVerified: true,
      snapshot: async () => snapshot(),
      decodeReview: (x) => x,
      // The real adapter unwraps before decoding: an isError answer throws here, exactly as it did live.
      decodeOrder: (x) => { unwrapRobinhoodRead(x); return x; },
      callTool: async (name, params) => {
        calls.push(name);
        const rest = { ...params }; delete rest.ref_id;
        const requestFingerprint = optionsRequestFingerprint(rest as unknown as OptionOrderParams);
        if (name === "review_option_order") return { approved: true, accountNumber: OPTIONS_LIVE_ACCOUNT, requestFingerprint, asOfMs: now, maxLossUsd: 150, estimatedFeeUsd: 1, buyingPowerRequiredUsd: 151 };
        return opts.placement ?? isErrorPlacement;
      },
      proveNeverPlaced: async () => { proofCalls++; return (opts.proof ?? (async () => ({ proven: true as const, evidence: "no order" })))(); },
    },
    store: {
      withAccountLock: async (_a, run) => run(),
      getIntent: async (id) => structuredClone(records.get(id) ?? null),
      putIntent: async (r) => { records.set(r.refId, structuredClone(r)); },
      unsettledIntents: async () => [...records.values()].filter((r) => r.state !== "settled"),
      ownedPosition: async () => null,
    },
  };
  return { deps, records, calls, advance: (ms: number) => { now += ms; }, proofCalls: () => proofCalls };
}

test("an isError placement ends unknown (not 'submitting'), with the broker's words kept and masked", async () => {
  const f = fixture();
  const res = await executeOptionsIntent(intent(), f.deps);
  assert.equal(res.status, "unknown");
  assert.match(res.reason!, /price outside the allowed band/);
  assert.doesNotMatch(res.reason!, /685528705/);
  const rec = f.records.get(REF)!;
  assert.equal(rec.state, "unknown");
  assert.match(rec.placementError!, /price outside the allowed band/);
});

test("inside the grace window: stays unknown, flagged as waiting, and the broker is not asked for proof", async () => {
  const f = fixture();
  await executeOptionsIntent(intent(), f.deps);
  f.advance(NEVER_PLACED_GRACE_MS - 60_000);
  const res = await reconcileOptionsIntent(REF, f.deps);
  assert.equal(res.status, "unknown");
  assert.equal(res.awaitingProof, true);
  assert.equal(f.proofCalls(), 0);
  assert.equal(f.records.get(REF)!.state, "unknown");
});

test("after the grace window, with the broker's proof: settled, stamped, and the ref_id is never sent again", async () => {
  const f = fixture();
  await executeOptionsIntent(intent(), f.deps);
  f.advance(NEVER_PLACED_GRACE_MS);
  const res = await reconcileOptionsIntent(REF, f.deps);
  assert.equal(res.status, "settled");
  assert.equal(res.autoSettled, true);
  assert.match(res.reason!, /never reached the broker/);
  assert.match(res.reason!, /Robinhood said: .*allowed band/);
  const rec = f.records.get(REF)!;
  assert.equal(rec.state, "settled");
  assert.equal(rec.autoSettled?.atMs, T0 + NEVER_PLACED_GRACE_MS);
  const placesBefore = f.calls.filter((c) => c === "place_option_order").length;
  const again = await executeOptionsIntent(intent(), f.deps);
  assert.equal(again.status, "settled");
  assert.equal(f.calls.filter((c) => c === "place_option_order").length, placesBefore);
});

test("after the grace window, WITHOUT proof (or when proof throws): stays unknown and pages", async () => {
  for (const proof of [async (): Promise<NeverPlacedProof> => ({ proven: false, why: "an agentic order exists" }), async (): Promise<NeverPlacedProof> => { throw new Error("broker down"); }]) {
    const f = fixture({ proof });
    await executeOptionsIntent(intent(), f.deps);
    f.advance(NEVER_PLACED_GRACE_MS + 1);
    const res = await reconcileOptionsIntent(REF, f.deps);
    assert.equal(res.status, "unknown");
    assert.notEqual(res.awaitingProof, true);
    assert.match(res.reason!, /agentic order exists|broker down/);
    assert.equal(f.records.get(REF)!.state, "unknown");
  }
});

test("never eligible: a close, a reservation with a broker order id, or one with an observed fill", async () => {
  const base: OptionsIntentRecord = { refId: REF, accountNumber: OPTIONS_LIVE_ACCOUNT, action: "open", fingerprint: "x", state: "unknown", createdAtMs: T0,
    canonicalOrder: { account_number: OPTIONS_LIVE_ACCOUNT, legs: [{ option_id: "A", side: "buy", position_effect: "open", ratio_quantity: 1 }], quantity: "1", direction: "debit", type: "limit", price: "1.50", time_in_force: "gfd", market_hours: "regular_hours" } };
  const variants: OptionsIntentRecord[] = [
    { ...base, action: "close", positionId: "P1" },
    { ...base, order: { id: "broker-1", accountNumber: OPTIONS_LIVE_ACCOUNT, refId: REF, requestFingerprint: "x", state: "open", filledQuantity: 0 } },
    { ...base, maxFilledQuantity: 1 },
    { ...base, createdAtMs: undefined },
  ];
  for (const v of variants) {
    const f = fixture();
    f.records.set(REF, v);
    f.advance(NEVER_PLACED_GRACE_MS * 3);
    const res = await reconcileOptionsIntent(REF, f.deps);
    assert.equal(res.status, "unknown", JSON.stringify(v).slice(0, 80));
    assert.equal(f.proofCalls(), 0);
  }
});

// ---- the Robinhood proof itself, against raw broker pages ------------------------------------------
function fakeClient(orders: Record<string, unknown>[], positions: Record<string, unknown>[] = []) {
  return { call: async (name: string) => {
    if (name === "get_option_orders") return { structuredContent: { data: { orders, next: null } } };
    if (name === "get_option_positions") return { structuredContent: { data: { positions, next: null } } };
    throw new Error(`unexpected ${name}`);
  } };
}
const io = { verified: true, now: () => T0, lookupIntent: async () => null, ownedPositions: async () => [], log: () => {} };
const rec: OptionsIntentRecord = { refId: REF, accountNumber: OPTIONS_LIVE_ACCOUNT, action: "open", fingerprint: "x", state: "unknown", createdAtMs: T0,
  canonicalOrder: { account_number: OPTIONS_LIVE_ACCOUNT, legs: [{ option_id: LEG, side: "buy", position_effect: "open", ratio_quantity: 1 }], quantity: "1", direction: "debit", type: "limit", price: "1.16", time_in_force: "gfd", market_hours: "regular_hours" } };
const order = (o: Partial<Record<string, unknown>>) => ({ id: "o", state: "filled", placed_agent: "user", created_at: new Date(T0 + 60_000).toISOString(), legs: [{ option_id: OTHER, side: "buy", position_effect: "open" }], ...o });

test("proof: an empty list, or only older orders, or only hand orders on other contracts → proven", async () => {
  for (const orders of [[], [order({ placed_agent: "agentic", created_at: new Date(T0 - 3 * 60_000).toISOString(), legs: [{ option_id: LEG }] })], [order({})]]) {
    const p = await new RobinhoodLiveBroker(fakeClient(orders), io).proveNeverPlaced(rec);
    assert.equal(p.proven, true, JSON.stringify(orders));
  }
});

test("proof refused: an agentic/unlabelled order in the window, a hand order on our contract, an unreadable row, or a position on our contract", async () => {
  const cases: [Record<string, unknown>[], Record<string, unknown>[]][] = [
    [[order({ placed_agent: "agentic" })], []],
    [[order({ placed_agent: undefined })], []],
    [[order({ placed_agent: "agentic", created_at: new Date(T0 - 60_000).toISOString() })], []],   // inside the 2-minute lead-in
    [[order({ legs: [{ option_id: LEG }] })], []],
    [[order({ created_at: "garbage" })], []],
    [[order({ legs: [{ side: "buy" }] })], []],
    [[], [{ option_id: LEG, type: "long", quantity: "1" }]],
  ];
  for (const [orders, positions] of cases) {
    const p = await new RobinhoodLiveBroker(fakeClient(orders, positions), io).proveNeverPlaced(rec);
    assert.equal(p.proven, false, JSON.stringify({ orders, positions }));
  }
});

test("proof throws when the broker answers with an error — never read as an empty list", async () => {
  const client = { call: async () => ({ isError: true, content: [{ type: "text", text: "rate limited" }] }) };
  await assert.rejects(new RobinhoodLiveBroker(client, io).proveNeverPlaced(rec), /rate limited/);
});

test("broker error text: masked account numbers and tokens, capped, null when empty", () => {
  const t = brokerErrorText({ isError: true, content: [{ type: "text", text: `Account 685528705 token ${"a".repeat(40)} rejected` }] })!;
  assert.equal(t.includes("685528705"), false);
  assert.equal(t.includes("a".repeat(40)), false);
  assert.match(t, /rejected/);
  assert.equal(brokerErrorText({ isError: true, content: [] }), null);
  assert.equal(brokerErrorText({ isError: true, content: [{ type: "text", text: "x".repeat(500) + " y" }] })!.length <= 200, true);
  assert.throws(() => unwrapRobinhoodRead({ isError: true, structuredContent: { error: "insufficient buying power" } }), /insufficient buying power/);
});
