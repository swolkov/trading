import assert from "node:assert/strict";
import test from "node:test";
import { screenResearchContracts, realizedVol20, type OptionsResearch, type ResearchContract } from "../src/lib/options-desk-model";
import { buildOptionsTradeCard, breakevenOf, candidateKey, renderOptionsTradeCard, researchTradeCards, structureComparison } from "../src/lib/options-trade-card";
import { entryTickCards } from "../scripts/robinhood/live-desk-cards";

// SOFI, Tue Sep 15 2026 15:00Z: a 20-session breakout to 12.10 over a 10.20–12.00 range, two expiries (Oct 16 = 31.2 DTE, Nov 6 = 52.2 DTE),
// a single call and a 12/13 call debit on each. Every number on the card is pinned by hand below.
const NOW = Date.parse("2026-09-15T15:00:00Z");
const AT = new Date(NOW).toISOString();
function sofi(iv = 0.40): OptionsResearch {
  const bars = Array.from({ length: 201 }, (_, i) => {
    const day = new Date(NOW - (201 - i) * 86_400_000).toISOString().slice(0, 10);
    if (i === 200) return { day, open: 11.5, high: 12.2, low: 11.4, close: 12.1, volume: 2_000_000 };
    if (i >= 180) return { day, open: 11, high: 12.0, low: 10.2, close: 11, volume: 1_000_000 };
    return { day, open: 10.5, high: 10.8, low: 10.2, close: 10.5, volume: 1_000_000 };
  });
  const base = { symbol: "SOFI", multiplier: 100, bidSize: 20, askSize: 20, at: AT, volume: 3000, openInterest: 8000, selloutAt: null };
  const contracts: ResearchContract[] = [
    { ...base, id: "nc12", type: "call", strike: 12, expiry: "2026-10-16", bid: 0.80, ask: 0.85, delta: 0.55, iv, theta: -0.02 },
    { ...base, id: "nc13", type: "call", strike: 13, expiry: "2026-10-16", bid: 0.37, ask: 0.40, delta: 0.35, iv, theta: -0.015 },
    { ...base, id: "np12", type: "put", strike: 12, expiry: "2026-10-16", bid: 0.65, ask: 0.70, delta: -0.45, iv, theta: -0.02 },
    { ...base, id: "fc12", type: "call", strike: 12, expiry: "2026-11-06", bid: 1.05, ask: 1.10, delta: 0.58, iv, theta: -0.012 },
    { ...base, id: "fc13", type: "call", strike: 13, expiry: "2026-11-06", bid: 0.55, ask: 0.60, delta: 0.40, iv, theta: -0.01 },
    { ...base, id: "fp12", type: "put", strike: 12, expiry: "2026-11-06", bid: 0.90, ask: 0.95, delta: -0.42, iv, theta: -0.012 },
  ];
  return { capturedAt: AT, source: "Robinhood MCP", bars: { SOFI: bars }, contracts, scans: [], errors: [],
    events: { SOFI: { earningsAt: "2026-11-20", earningsTiming: "pm", calendarThrough: "2026-11-15", exDivAt: null, dividendAmount: null, at: AT } } };
}

test("structure comparison: rows carry cost, max loss/gain, RoR, breakeven, net greeks, IV/RV, payoff and theta drag; the prompt's rule picks the spread when the single costs >1.15×; the live IV/RV rule wins on disagreement", () => {
  const data = sofi(0.40);
  const rv = realizedVol20(data.bars.SOFI)!;
  const cands = screenResearchContracts(data, 150, 1500, NOW);
  assert.ok(Math.abs(0.4 / rv - 1.18) < 0.01, "IV 40% over ~34% realized = 1.18× > 1.15 → spreads first");
  assert.deepEqual(cands.map((c) => `${c.kind} ${c.strikes.join("/")} ${c.expiry}`), ["call_debit 12/13 2026-10-16", "call_debit 12/13 2026-11-06", "long_call 12 2026-11-06", "long_call 13 2026-11-06", "long_call 12 2026-10-16", "long_call 13 2026-10-16"]);
  const cmp = structureComparison(cands, data.contracts);
  const near = cmp.rows.find((r) => r.kind === "call_debit" && r.expiry === "2026-10-16")!;
  // Near 12/13 call debit: 0.85 − 0.37 = 0.48 debit → $50 with the $2 reserve; width $100 − $48 − $2 = $50 max gain; breakeven 12.48;
  // ATM straddle 0.825 + 0.675 = 1.50 → expected move ±12.4% → S = 13.60 → intrinsic 1.00 → payoff $50; net theta −0.005 → $5 drag over 10 days.
  assert.deepEqual([near.cost, near.maxLoss, near.maxGain, near.returnOnRisk, near.breakeven], [50, 50, 50, 1, 12.48]);
  assert.deepEqual([near.netDelta, near.netTheta, near.payoffAtMove, near.thetaDrag, near.payoffPerDollar], [0.2, -0.005, 50, 5, 0.9]);
  assert.equal(near.iv, 0.4); assert.equal(near.ivOverRv, Math.round(0.4 / rv * 100) / 100);
  const farSingle = cmp.rows.find((r) => r.kind === "long_call" && r.expiry === "2026-11-06")!;
  // Far 12 call: 1.10 → $111; straddle 2.00 → ±16.5% → S = 14.10 → (2.10 − 1.10) × 100 − 1 = $99; theta −0.012 → $12 drag; (99 − 12)/111 = 0.7838. Uncapped.
  assert.deepEqual([farSingle.cost, farSingle.maxGain, farSingle.returnOnRisk, farSingle.breakeven, farSingle.payoffAtMove, farSingle.thetaDrag, farSingle.payoffPerDollar], [111, null, null, 13.1, 99, 12, 0.7838]);
  assert.equal(cmp.bestSingle!.kind, "long_call"); assert.equal(cmp.bestSingle!.expiry, "2026-11-06");
  assert.equal(cmp.bestSpread!.expiry, "2026-10-16");
  // $111 > 1.15 × $50 = $57.50 → the spread; the live rule also says spread → no disagreement.
  assert.equal(cmp.chosen.family, "spread"); assert.match(cmp.chosen.reason, /costs more than 1.15× the spread \(single \$111 vs spread \$50 \(limit 1.15× = \$57.5\)\)/);
  assert.equal(cmp.existingRule.family, "spread"); assert.equal(cmp.disagreement, null);
  // Cheap IV (30%) → IV/RV ≤ 1.15 → the live rule prefers the single; the comparison still says spread (cost) → disagreement, existing rule wins.
  const fair = sofi(0.30);
  const cands2 = screenResearchContracts(fair, 150, 1500, NOW);
  assert.equal(cands2[0].kind, "long_call");
  const cmp2 = structureComparison(cands2, fair.contracts);
  assert.equal(cmp2.existingRule.family, "single"); assert.equal(cmp2.chosen.family, "spread");
  assert.match(cmp2.disagreement ?? "", /live IV\/RV rule takes the single .* and wins/);
  // A single within 1.15× of the spread's cost that pays more per dollar is chosen: a nearly worthless 13 call (0.10/0.11) makes the
  // near spread 0.75 → $77 paying (1.00 − 0.75) × 100 − 2 − $5 = $18 → 0.23/$, while that 13 call alone is a $12 single paying
  // (0.60 − 0.11) × 100 − 1 − $15 = $33 → 2.75/$ — cheaper AND more per dollar.
  const cheap = sofi(0.30); cheap.contracts = cheap.contracts.filter((c) => c.expiry === "2026-10-16");
  Object.assign(cheap.contracts.find((c) => c.id === "nc13")!, { bid: 0.10, ask: 0.11 });
  const cmp3 = structureComparison(screenResearchContracts(cheap, 150, 1500, NOW), cheap.contracts);
  assert.equal(cmp3.chosen.family, "single"); assert.equal(cmp3.chosen.kind, "long_call"); assert.match(cmp3.chosen.reason, /single \$12 vs spread \$77 \(limit 1.15× = \$88.55\); payoff per \$ at the expected move 2.75 vs 0.2338/);
  assert.equal(cmp3.existingRule.family, "single"); assert.equal(cmp3.disagreement, null);
  const only = sofi(0.30); only.contracts = only.contracts.filter((c) => c.id !== "nc13" && c.id !== "fc13");   // no spreads on file at all
  const cmp4 = structureComparison(screenResearchContracts(only, 150, 1500, NOW), only.contracts);
  assert.equal(cmp4.chosen.family, "single"); assert.equal(cmp4.bestSpread, null); assert.equal(cmp4.disagreement, null);
  assert.equal(breakevenOf("long_put", 12, 0.7), 11.3); assert.equal(breakevenOf("put_debit", 12, 0.5), 11.5);
});

test("the trade card pins every TOP-5 field for the SOFI entry: natural vs mark vs expected fill, contracts, debit, max loss/gain, breakeven, % of equity, R:R, greeks, IV, expected move, target, invalidation, hold, grade, score labelled paper ranker", () => {
  const data = sofi(0.40);
  const cands = screenResearchContracts(data, 150, 1500, NOW);
  const c = cands[0];
  const card = buildOptionsTradeCard({ source: "entry", candidate: c, contracts: data.contracts, live: { natural: 0.5, mark: 0.45, expectedFill: 0.5 }, quantity: 1, grade: "Strong", cap: 150, equity: 1500, feeReserveUsd: 2, score: 72, action: "ENTER", comparison: structureComparison(cands, data.contracts), at: AT });
  assert.equal(card.symbol, "SOFI"); assert.equal(card.direction, "bullish"); assert.equal(card.structure, "call_debit"); assert.equal(card.setup, "20-session breakout");
  assert.equal(card.expiry, "2026-10-16"); assert.equal(card.dte, 31.2); assert.equal(card.dteBucket, "30-45"); assert.deepEqual(card.strikes, [12, 13]);
  assert.deepEqual([card.natural, card.mark, card.expectedFill], [0.5, 0.45, 0.5]);
  // Re-priced live at 0.50 (research said 0.48): debit $50, max loss $52 with the $2 reserve, max gain $48, breakeven 12.50.
  assert.equal(card.contracts, 1); assert.equal(card.debitUsd, 50); assert.equal(card.maxLossUsd, 52); assert.equal(card.maxGainUsd, 48); assert.equal(card.breakeven, 12.5);
  assert.equal(card.pctEquityAtRisk, 3.47);          // 52 / 1500
  assert.equal(card.riskReward, 0.92);               // 48 / 52
  assert.equal(card.riskRewardAtMove, 1);            // research payoff $50 at the expected move over the research $50 planned loss
  assert.equal(card.delta, 0.2); assert.equal(card.theta, -0.005); assert.equal(card.iv, 0.4);
  assert.equal(card.expectedMovePct, 12.4); assert.equal(card.expectedMoveLevel, 13.6);
  assert.deepEqual(card.target, { level: 13, basis: "short strike" });
  assert.deepEqual(card.invalidation, { level: 11.94, rangeLow: 10.2, rangeHigh: 12 });   // 12.00 × (1 − 0.5%)
  assert.equal(card.expectedHoldDays, 10); assert.equal(card.thetaDragUsd, 5);
  assert.equal(card.grade, "Strong"); assert.equal(card.cap, 150);
  assert.deepEqual(card.confidence, { score: 72, label: "paper ranker" });
  assert.deepEqual(card.earnings, { class: "none", at: "2026-11-20" }); assert.equal(card.exDivAt, null);
  assert.equal(card.action, "ENTER"); assert.equal(card.gate, null); assert.equal(card.comparison?.disagreement, null);
  assert.match(card.text, /^ENTER · SOFI bullish · call debit 12\/13 exp 2026-10-16 \(31\.2 DTE, 30-45\)/);
  assert.match(card.text, /natural 0\.50 · mark 0\.45 · expected fill 0\.50 · 1 contract · debit \$50/);
  assert.match(card.text, /max loss \$52 incl\. fees \(3\.47% of equity\) · max gain \$48 · R:R 0\.92/);
  assert.match(card.text, /target 13\.00 \(short strike\) · invalidation 11\.94 \(range 10\.2–12\)/);
  assert.match(card.text, /score 72 \(paper ranker\)/);
  // A two-lot doubles the dollars, not the levels; a single leg's target is the expected-move level and its gain is uncapped.
  const two = buildOptionsTradeCard({ source: "entry", candidate: c, contracts: data.contracts, quantity: 2, feeReserveUsd: 2, equity: 1500, action: "ENTER" });
  assert.deepEqual([two.debitUsd, two.maxLossUsd, two.maxGainUsd, two.pctEquityAtRisk, two.breakeven], [96, 100, 100, 6.67, 12.48]);   // research 0.48 × 2
  const single = buildOptionsTradeCard({ source: "research", candidate: cands.find((x) => x.kind === "long_call" && x.expiry === "2026-11-06")!, contracts: data.contracts, action: "RESEARCH" });
  assert.deepEqual(single.target, { level: 14.1, basis: "expected move" }); assert.equal(single.maxGainUsd, null); assert.equal(single.riskReward, null);
  assert.equal(single.natural, null); assert.match(single.text, /^RESEARCH · SOFI bullish · long call 12 exp 2026-11-06/); assert.match(single.text, /max gain uncapped · R:R uncapped/);
  assert.equal(renderOptionsTradeCard(single), single.text);
});

test("a refusal card carries the gate; research cards are the top five in screen order with the comparison attached; the live tick's cards put the chosen structure first", () => {
  const data = sofi(0.40);
  const cands = screenResearchContracts(data, 150, 1500, NOW);
  const refused = buildOptionsTradeCard({ source: "refusal", candidate: cands[0], contracts: data.contracts, action: "REFUSED", gate: "market veto — SPY below its 20-day (651.2 vs 660.4) and -2.1% on 2026-09-14 — bullish single-name entries refused" });
  assert.equal(refused.action, "REFUSED"); assert.match(refused.gate ?? "", /market veto/); assert.match(refused.text, /^REFUSED — market veto — SPY below/);
  const research = researchTradeCards(cands, data.contracts, { equity: 1500, scores: new Map([[candidateKey(cands[0]), 66]]), at: AT });
  assert.equal(research.length, 5, "top five of six"); assert.ok(research.every((c) => c.source === "research" && c.action === "RESEARCH" && c.comparison));
  assert.equal(research[0].confidence.score, 66); assert.equal(research[1].confidence.score, null);
  assert.deepEqual(research.map((c) => c.structure), cands.slice(0, 5).map((c) => c.kind));
  const tick = entryTickCards({ data, chosen: { candidate: cands[0], live: { natural: 0.5, mark: 0.45, expectedFill: 0.5 }, quantity: 1, grade: "Strong", cap: 150 }, result: { status: "accepted" },
    refused: [{ candidate: cands[1], gate: "reserve: $325 already at risk + $59 would exceed 25% of $1,500" }], equity: 1500, feeReserveUsd: 2, scoreOf: () => 58, at: AT });
  assert.deepEqual(tick.map((c) => [c.source, c.action]), [["entry", "ENTER"], ["refusal", "REFUSED"]]);
  assert.equal(tick[1].gate, "reserve: $325 already at risk + $59 would exceed 25% of $1,500"); assert.equal(tick[0].confidence.score, 58);
  // The core refusing the chosen structure is a refusal card naming the core's reason; no chosen structure → only the refusals.
  const coreNo = entryTickCards({ data, chosen: { candidate: cands[0], live: { natural: 0.5, mark: 0.45, expectedFill: 0.5 }, quantity: 1, grade: "Strong", cap: 150 }, result: { status: "refused", reason: "live guardian is not healthy" }, refused: [], equity: 1500, feeReserveUsd: 2 });
  assert.equal(coreNo[0].source, "refusal"); assert.equal(coreNo[0].gate, "core refused: live guardian is not healthy");
  assert.equal(entryTickCards({ data, chosen: null, result: null, refused: [], equity: null, feeReserveUsd: 2 }).length, 0);
});
