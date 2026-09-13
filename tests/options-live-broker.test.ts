import assert from "node:assert/strict";
import test from "node:test";
import { decodeBrokerOrder, decodeOrderPayload, decodeReviewPayload, groupPositions, mapOrderState, optionIdOf, orderMatchesCanonical, regularSessionFor } from "../src/lib/options-live-broker";
import { OPTIONS_LIVE_ACCOUNT, optionsRequestFingerprint, type OptionOrderParams } from "../src/lib/options-live-policy";

const params: OptionOrderParams = { account_number: OPTIONS_LIVE_ACCOUNT, legs: [{ option_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", side: "buy", position_effect: "open", ratio_quantity: 1 }], quantity: "1", direction: "debit", type: "limit", price: "0.55", time_in_force: "gfd", market_hours: "regular_hours" };
const fp = optionsRequestFingerprint(params);

test("regular session: Monday Sep 14 2026 is 09:30–16:00 ET; weekend, holiday and early close are honoured", () => {
  const mon = regularSessionFor(Date.parse("2026-09-14T15:00:00Z"))!;
  assert.equal(new Date(mon.opensAtMs).toISOString(), "2026-09-14T13:30:00.000Z");
  assert.equal(new Date(mon.closesAtMs).toISOString(), "2026-09-14T20:00:00.000Z");
  assert.equal(regularSessionFor(Date.parse("2026-09-13T15:00:00Z")), null);   // Sunday
  assert.equal(regularSessionFor(Date.parse("2026-11-26T15:00:00Z")), null);   // Thanksgiving
  const early = regularSessionFor(Date.parse("2026-11-27T15:00:00Z"))!;         // day after: 13:00 ET close, EST
  assert.equal(new Date(early.closesAtMs).toISOString(), "2026-11-27T18:00:00.000Z");
});

test("order states map to the core's vocabulary; unknown states are rejected", () => {
  assert.equal(mapOrderState("confirmed"), "open"); assert.equal(mapOrderState("pending_cancelled"), "open");
  assert.equal(mapOrderState("partially_filled"), "partially_filled"); assert.equal(mapOrderState("filled"), "filled");
  assert.equal(mapOrderState("voided"), "cancelled"); assert.equal(mapOrderState("failed"), "rejected");
  assert.equal(mapOrderState("weird"), null);
});

test("leg option ids are read from an id, a URL or a nested instrument, never from junk", () => {
  const id = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  assert.equal(optionIdOf({ option_id: id }), id);
  assert.equal(optionIdOf({ option: `https://api.robinhood.com/options/instruments/${id}/` }), id);
  assert.equal(optionIdOf({ instrument: { id } }), id);
  assert.equal(optionIdOf({ option: "not-a-uuid" }), null);
});

test("a broker order row decodes with legs, and matches the canonical request only exactly", () => {
  const row = { id: "o1", state: "confirmed", processed_quantity: "0", quantity: "1", price: "0.55", direction: "debit", placed_agent: "agentic", created_at: "2026-09-14T13:40:00Z",
    legs: [{ option: "https://x/instruments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/", side: "buy", position_effect: "open", ratio_quantity: 1 }] };
  const o = decodeBrokerOrder(row)!;
  assert.equal(o.state, "open"); assert.equal(o.filledQuantity, 0); assert.equal(o.placedAgent, "agentic");
  assert.equal(orderMatchesCanonical(o, params), true);
  assert.equal(orderMatchesCanonical(o, { ...params, price: "0.60" }), false);
  assert.equal(orderMatchesCanonical(o, { ...params, quantity: "2" }), false);
  assert.equal(orderMatchesCanonical({ ...o, legs: null }, params), false);
  assert.equal(decodeBrokerOrder({ id: "o2", state: "confirmed" }), null);   // no fill count → unreadable
});

test("owned structures are grouped from broker legs exactly; anything else is foreign", () => {
  const legs = [{ optionId: "A", side: "long" as const, quantity: 1 }, { optionId: "B", side: "short" as const, quantity: 1 }, { optionId: "C", side: "long" as const, quantity: 2 }];
  const owned = [{ id: "ref-1", accountNumber: OPTIONS_LIVE_ACCOUNT, openingRefId: "ref-1", legs: [{ optionId: "A", side: "long" as const, quantity: 1 }, { optionId: "B", side: "short" as const, quantity: 1 }] }];
  const grouped = groupPositions(legs, owned);
  assert.deepEqual(grouped.map((p) => p.id), ["ref-1", "C:long"]);
  // A quantity mismatch is not ours — the structure stands as two foreign legs.
  const off = groupPositions(legs, [{ ...owned[0], legs: [{ optionId: "A", side: "long", quantity: 2 }, { optionId: "B", side: "short", quantity: 1 }] }]);
  assert.deepEqual(off.map((p) => p.id), ["A:long", "B:short", "C:long"]);
});

test("review decoding: fees found → approved; fees missing → not approved; blocking alert → not approved", () => {
  const now = Date.parse("2026-09-14T14:00:00Z");
  const ok = decodeReviewPayload({ data: { quote: { bid_price: "0.50", ask_price: "0.55" }, fees: { total_fees: "0.04" }, buying_power_required: "55.00", order_checks: [{ severity: "info", message: "fine" }] } }, { params, theoreticalMaxLossUsd: 55, nowMs: now });
  assert.equal(ok.approved, true); assert.equal(ok.estimatedFeeUsd, 0.04); assert.equal(ok.buyingPowerRequiredUsd, 55); assert.equal(ok.maxLossUsd, 55); assert.equal(ok.requestFingerprint, fp);
  const noFee = decodeReviewPayload({ data: { quote: {} } }, { params, theoreticalMaxLossUsd: 55, nowMs: now });
  assert.equal(noFee.approved, false); assert.deepEqual(noFee.missing, ["fees"]); assert.ok(Number.isNaN(noFee.estimatedFeeUsd));
  const blocked = decodeReviewPayload({ data: { fees: "0.04", alerts: [{ severity: "blocking", message: "insufficient buying power" }] } }, { params, theoreticalMaxLossUsd: 55, nowMs: now });
  assert.equal(blocked.approved, false); assert.deepEqual(blocked.blocking, ["insufficient buying power"]);
  assert.equal(decodeReviewPayload({ data: { fees: "0.04" }, can_place: false }, { params, theoreticalMaxLossUsd: 55, nowMs: now }).approved, false);
});

test("placement decoding binds the ref_id and fingerprint we sent; garbage is null", () => {
  const bind = { refId: "12345678-1234-4234-8234-123456789abc", fingerprint: fp };
  const o = decodeOrderPayload({ data: { order: { id: "o9", state: "queued", processed_quantity: 0, account_number: OPTIONS_LIVE_ACCOUNT } } }, bind)!;
  assert.equal(o.id, "o9"); assert.equal(o.state, "open"); assert.equal(o.refId, bind.refId); assert.equal(o.requestFingerprint, fp); assert.equal(o.accountNumber, OPTIONS_LIVE_ACCOUNT);
  assert.equal(decodeOrderPayload({ data: { order: { state: "queued" } } }, bind), null);
});
