import assert from "node:assert/strict";
import test from "node:test";
import { OPTIONS_LADDER, clusterOf, clusterRisk, ddTier, gradeFor, maxLossFor, reserveOk, reserveRefusal, slotsFor, type GradeCandidate } from "../src/lib/options-risk-ladder";
import { drawdownHalt } from "../src/lib/options-live-guardian";
import { divergenceVerdict, roundTrips } from "../src/lib/options-live-ledger";
import { OPTIONS_LIVE_ACCOUNT, optionsRequestFingerprint, type OptionOrderParams } from "../src/lib/options-live-policy";
import type { OptionsIntentRecord } from "../src/lib/options-live-executor";

const strong: GradeCandidate = { setup: "20-session breakout", kind: "long_call", market: { aligned: true }, spreadPct: 4, payoffAtMoveUsd: 150, plannedLoss: 90 };

test("grade: Strong needs a breakout, alignment, a ≤5% spread and 1.5× payoff; A+ needs the promoted switch AND a score ≥ 80", () => {
  assert.equal(gradeFor(strong, false).grade, "Strong");
  assert.equal(gradeFor({ ...strong, setup: "Trend watch" }, false).grade, "Normal");
  assert.equal(gradeFor({ ...strong, market: { aligned: false } }, false).grade, "Normal");
  assert.equal(gradeFor({ ...strong, market: { aligned: null } }, false).grade, "Normal");
  assert.equal(gradeFor({ ...strong, spreadPct: 5.01 }, false).grade, "Normal");
  assert.equal(gradeFor({ ...strong, spreadPct: null }, false).grade, "Normal");
  assert.equal(gradeFor({ ...strong, payoffAtMoveUsd: 134 }, false).grade, "Normal");     // < 1.5 × 90 = 135
  assert.equal(gradeFor({ ...strong, payoffAtMoveUsd: 135 }, false).grade, "Strong");
  assert.equal(gradeFor({ ...strong, score: 95 }, false).grade, "Strong", "A+ stays locked without promotion");
  assert.equal(gradeFor({ ...strong, score: 95 }, true).grade, "A+");
  assert.equal(gradeFor({ ...strong, score: 79 }, true).grade, "Strong");
  assert.equal(gradeFor(strong, true).grade, "Strong", "no score field = not promoted for this candidate");
  assert.equal(gradeFor({ ...strong, setup: "20-session breakdown", kind: "long_put" }, false).grade, "Strong");
});

test("ladder pins: $1,500 / $3,000 / $900 equity, the armed ceiling caps every rung", () => {
  assert.deepEqual([maxLossFor("Normal", 1500), maxLossFor("Strong", 1500), maxLossFor("A+", 1500)], [100.5, 150, 225]);
  assert.deepEqual([maxLossFor("Normal", 3000), maxLossFor("Strong", 3000), maxLossFor("A+", 3000)], [201, 300, 450]);
  assert.deepEqual([maxLossFor("Normal", 900), maxLossFor("Strong", 900), maxLossFor("A+", 900)], [100, 150, 225]);
  assert.equal(maxLossFor("Strong", 3000, 150), 150, "the ceiling wins");
  assert.equal(maxLossFor("A+", null), 225, "no equity on file → the dollar floor");
  assert.equal(OPTIONS_LADDER.Normal.pct, 0.067);
});

test("drawdown tiers at 5/10/15/20% under the high: 4.99% is tier 0; the halt is the larger of $300 and 20%", () => {
  const at = (pct: number, high = 1500) => ddTier(high * (1 - pct / 100), high);
  assert.deepEqual([at(4.99).tier, at(4.99).mult], [0, 1]);
  assert.deepEqual([at(5).tier, at(5).mult], [1, 1]);
  assert.deepEqual([at(9.99).tier, at(10).tier, at(10).mult], [1, 2, 0.5]);
  assert.deepEqual([at(14.99).tier, at(15).tier, at(15).mult], [2, 3, 0.25]);
  assert.deepEqual([at(19.99).tier, at(20).tier, at(20).mult, at(20).halt], [3, 4, 0, true]);
  // $300 floor vs 20%: at a $1,000 high, 20% is $200 but the halt waits for $300 (tier 3 until then); at $3,000 it is $600.
  assert.deepEqual([at(25, 1000).tier, at(25, 1000).halt, at(30, 1000).halt, at(30, 1000).tier], [3, false, true, 4]);
  assert.deepEqual([at(15, 3000).halt, at(20, 3000).halt, at(20, 3000).haltAtUsd], [false, true, 600]);
  assert.equal(ddTier(1650, 1500).newHigh, 1650, "the mark only rises");
  assert.equal(ddTier(1650, 1500).tier, 0);
  // The guardian's drawdownHalt delegates: $300 under a $1,500 high halts; 20% under a $1,650 high is $330.
  assert.deepEqual(drawdownHalt(1199, 1500), { halt: true, newHigh: 1500 });
  assert.deepEqual(drawdownHalt(1201, 1500), { halt: false, newHigh: 1500 });
  assert.deepEqual(drawdownHalt(1319, 1650), { halt: true, newHigh: 1650 });
  assert.deepEqual(drawdownHalt(1321, 1650), { halt: false, newHigh: 1650 });
});

test("clusters: SPY + QQQ + NVDA calls are one tech bet; NVDA call + F put are two; RIOT and MSTR share crypto-proxy", () => {
  assert.equal(clusterOf("SPY"), "index"); assert.equal(clusterOf("NVDA"), "semis"); assert.equal(clusterOf("F"), "consumer");
  assert.equal(clusterOf("MSTR"), "crypto-proxy"); assert.equal(clusterOf("RIOT"), "crypto-proxy"); assert.equal(clusterOf("NFLX"), "megacap"); assert.equal(clusterOf("SOFI"), "fintech");
  assert.equal(clusterOf("ZZZZ"), null);
  const spyCall = { symbol: "SPY", kind: "long_call" };
  assert.deepEqual(clusterRisk([spyCall], { symbol: "QQQ", kind: "call_debit" }), { refused: true, reason: "cluster: SPY call + QQQ call would be one index bet — refused" });
  assert.deepEqual(clusterRisk([spyCall], { symbol: "NVDA", kind: "long_call" }), { refused: true, reason: "cluster: SPY call + NVDA call would be one tech bet — refused" });
  assert.equal(clusterRisk([{ symbol: "NVDA", kind: "long_call" }], { symbol: "SPY", kind: "long_call" }).refused, true, "either order");
  assert.equal(clusterRisk([{ symbol: "AAPL", kind: "long_call" }], { symbol: "QQQ", kind: "long_call" }).refused, true, "megacap + index");
  assert.equal(clusterRisk([{ symbol: "NVDA", kind: "long_call" }], { symbol: "F", kind: "long_put" }).refused, false);
  assert.equal(clusterRisk([{ symbol: "NVDA", kind: "long_call" }], { symbol: "F", kind: "long_call" }).refused, false, "different clusters, same direction is fine");
  assert.equal(clusterRisk([spyCall], { symbol: "QQQ", kind: "long_put" }).refused, false, "opposite direction is a hedge, not the same bet");
  assert.equal(clusterRisk([{ symbol: "RIOT", kind: "long_call" }], { symbol: "MSTR", kind: "call_debit" }).refused, true);
  assert.equal(clusterRisk([], { symbol: "NVDA", kind: "long_call" }).refused, false);
});

test("reserve: everything at risk stays within 25% of equity; unknown equity refuses", () => {
  assert.equal(reserveOk(375, 1500), true); assert.equal(reserveOk(375.01, 1500), false); assert.equal(reserveOk(100, null), false);
  assert.equal(reserveRefusal(325, 150, 1500), "reserve: $325 already at risk + $150 would exceed 25% of $1,500");
  assert.equal(reserveRefusal(0, 150, 1500), null);
  assert.equal(reserveRefusal(0, 100, null), "reserve: account value unknown — cannot size against it");
});

// ---- ledger --------------------------------------------------------------------------------------
const uuid = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
function rec(n: number, action: "open" | "close", opts: { positionId?: string; state?: OptionsIntentRecord["state"]; orderState?: "filled" | "cancelled"; fee?: number; avg?: number | null; limit?: number; qty?: number } = {}): OptionsIntentRecord {
  const limit = opts.limit ?? 1, qty = opts.qty ?? 1;
  const params: OptionOrderParams = { account_number: OPTIONS_LIVE_ACCOUNT, legs: [{ option_id: "A", side: action === "open" ? "buy" : "sell", position_effect: action, ratio_quantity: 1 }], quantity: String(qty), direction: action === "open" ? "debit" : "credit", type: "limit", price: limit.toFixed(2), time_in_force: "gfd", market_hours: "regular_hours" };
  const fp = optionsRequestFingerprint(params);
  return { refId: uuid(n), accountNumber: OPTIONS_LIVE_ACCOUNT, action, positionId: opts.positionId, fingerprint: fp, state: opts.state ?? "settled", createdAtMs: n * 1000,
    canonicalOrder: params, intent: { refId: uuid(n), action, kind: "long_call", positionId: opts.positionId, quantity: qty, limitPrice: limit, legs: [{ optionId: "A", side: action === "open" ? "buy" : "sell" }] },
    order: { id: `o${n}`, accountNumber: OPTIONS_LIVE_ACCOUNT, refId: uuid(n), requestFingerprint: fp, state: opts.orderState ?? "filled", filledQuantity: opts.orderState === "cancelled" ? 0 : qty, averagePrice: opts.avg === undefined ? limit : opts.avg },
    review: { estimatedFeeUsd: opts.fee ?? 0.05, maxLossUsd: limit * 100 * qty, buyingPowerRequiredUsd: limit * 100 * qty } };
}
function ledger(trips: number, extra: OptionsIntentRecord[] = []): OptionsIntentRecord[] {
  const out: OptionsIntentRecord[] = [];
  for (let i = 0; i < trips; i++) { out.push(rec(i * 2 + 1, "open"), rec(i * 2 + 2, "close", { positionId: uuid(i * 2 + 1) })); }
  return [...out, ...extra];
}

test("round trips pair a filled open with the close that names it; unfilled or open-ended intents are not trips", () => {
  const trips = roundTrips(ledger(2, [rec(90, "open", { orderState: "cancelled" }), rec(91, "open")]));
  assert.equal(trips.length, 3); assert.equal(trips.filter((t) => t.closed).length, 2);
  assert.equal(trips[2].open.refId, uuid(91)); assert.equal(trips[2].closed, false);
  assert.equal(trips[0].close?.refId, uuid(2));
});

test("slot unlock: 10 closed trips all green open the second slot; 10 with one unknown intent (or a wide fill, or a fee over the reserve) do not", () => {
  const green = ledger(10);
  assert.equal(divergenceVerdict(roundTrips(green), green, 2).green, true);
  assert.equal(slotsFor(divergenceVerdict(roundTrips(green), green, 2).closedTrades, true), 2);
  assert.equal(slotsFor(9, true), 1); assert.equal(slotsFor(10, false), 1); assert.equal(slotsFor(50, true), 2);
  const withUnknown = ledger(10, [rec(99, "open", { state: "unknown" })]);
  const v = divergenceVerdict(roundTrips(withUnknown), withUnknown, 2);
  assert.equal(v.green, false); assert.match(v.reasons[0], /1 unknown intent/);
  assert.equal(slotsFor(v.closedTrades, v.green), 1);
  const wide = ledger(9, [rec(21, "open", { avg: 1.06 }), rec(22, "close", { positionId: uuid(21) })]);   // 6% over the limit
  const w = divergenceVerdict(roundTrips(wide), wide, 2);
  assert.equal(w.green, false); assert.match(w.reasons[0], /diverges 6.0%/);
  const near = ledger(9, [rec(21, "open", { avg: 1.05 }), rec(22, "close", { positionId: uuid(21) })]);
  assert.equal(divergenceVerdict(roundTrips(near), near, 2).green, true, "5% is within");
  const fee = ledger(9, [rec(21, "open", { fee: 2.01 }), rec(22, "close", { positionId: uuid(21) })]);
  assert.match(divergenceVerdict(roundTrips(fee), fee, 2).reasons[0], /review fee \$2.01 over the \$2 reserve/);
  const twoLot = ledger(9, [rec(21, "open", { fee: 3, qty: 2 }), rec(22, "close", { positionId: uuid(21), qty: 2 })]);
  assert.equal(divergenceVerdict(roundTrips(twoLot), twoLot, 2).green, true, "the reserve scales with contracts");
  const noFill = ledger(9, [rec(21, "open", { avg: null }), rec(22, "close", { positionId: uuid(21) })]);
  const n = divergenceVerdict(roundTrips(noFill), noFill, 2);
  assert.equal(n.green, true); assert.equal(n.rows.find((r) => r.refId === uuid(21))?.fillSource, "limit");
  // Only the last ten trips are judged: an old wide fill ages out.
  const old = [rec(1, "open", { avg: 2 }), rec(2, "close", { positionId: uuid(1) }), ...ledger(10).map((r, i) => ({ ...r, refId: uuid(100 + i), createdAtMs: (100 + i) * 1000, intent: { ...r.intent!, refId: uuid(100 + i), positionId: r.action === "close" ? uuid(100 + i - 1) : undefined }, positionId: r.action === "close" ? uuid(100 + i - 1) : undefined }))];
  assert.equal(divergenceVerdict(roundTrips(old), old, 2).green, true);
});
