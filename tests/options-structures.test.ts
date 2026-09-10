import assert from "node:assert/strict";
import test from "node:test";
import type { Contract } from "../src/lib/options-paper-model";
import {
  BEARISH_KINDS, BULLISH_KINDS, MAX_CREDIT_FRAC_OF_WIDTH, type Candidate,
  atmOf, buildCandidates, expectedMove, legsQuotedTogether, pnlAtExpiry, returnAt,
  scenarioTable, selectStructure,
} from "../src/lib/options-structures";

const EXP = "2026-12-18";
/** A liquid contract at `strike`; override bid/ask/delta per case. */
const K = (strike: number, o: Partial<Contract> = {}): Contract => ({
  occ: `X${strike}`, strike, expiry: EXP, delta: 0.5,
  bid: 1.00, ask: 1.10, bidSize: 50, askSize: 50, ...o,
});
const one = (cs: Candidate[]) => { assert.equal(cs.length, 1, `expected exactly one candidate, got ${cs.length}`); return cs[0]; };

// The live INTC chain measured on 2026-09-10, spot $101.49.
const INTC_85 = K(85, { bid: 23.15, ask: 23.70, delta: 0.76 });
const INTC_115 = K(115, { bid: 9.95, ask: 10.20, delta: 0.446 });

test("long call: unbounded upside, loss floored at the debit, breakeven is exact", () => {
  const c = one(buildCandidates({ calls: [INTC_85], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["long_call"] }));
  assert.equal(c.maxProfitUsd, null, "a long call's upside is genuinely unbounded");
  assert.ok(Math.abs(c.debitUsd - 2370.05) < 1e-9);
  assert.ok(Math.abs(c.maxLossUsd - 2370.05) < 1e-9);
  assert.ok(Math.abs(pnlAtExpiry(c, 0) + 2370.05) < 1e-9, "worthless expiry loses exactly the debit");
  assert.ok(Math.abs(pnlAtExpiry(c, c.breakeven)) < 1e-6, "pnl is zero at the stated breakeven");
  assert.ok(pnlAtExpiry(c, 200) > pnlAtExpiry(c, 150), "keeps gaining above every strike");
});

test("long put: upside is bounded by the stock reaching zero, not unbounded", () => {
  const c = one(buildCandidates({ calls: [], puts: [K(100, { bid: 8.00, ask: 8.15, delta: -0.78 })], spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["long_put"] }));
  assert.ok(c.maxProfitUsd != null);
  assert.ok(Math.abs(c.maxProfitUsd! - (100 * 100 - 815.05)) < 1e-9);
  assert.ok(Math.abs(pnlAtExpiry(c, 0) - c.maxProfitUsd!) < 1e-9, "max profit is realised at zero");
  assert.ok(Math.abs(pnlAtExpiry(c, 150) + 815.05) < 1e-9, "above the strike it loses the debit");
  assert.ok(Math.abs(pnlAtExpiry(c, c.breakeven)) < 1e-6);
});

test("call debit spread: the live INTC 85/115 numbers", () => {
  const c = one(buildCandidates({ calls: [INTC_85, INTC_115], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 1925, kinds: ["call_debit"] }));
  assert.ok(Math.abs(c.debitUsd - 1375.10) < 1e-9, "pay the long's ask, receive the short's bid, two fees");
  assert.ok(Math.abs(c.maxProfitUsd! - 1624.90) < 1e-9);
  assert.ok(Math.abs(c.maxLossUsd - 1375.10) < 1e-9);
  assert.ok(Math.abs(c.breakeven - 98.751) < 1e-6, "breakeven is BELOW spot — the point of the structure");
  assert.ok(c.breakeven < 101.49);
  assert.ok(Math.abs(pnlAtExpiry(c, 115) - c.maxProfitUsd!) < 1e-9, "capped at the short strike");
  assert.ok(Math.abs(pnlAtExpiry(c, 500) - c.maxProfitUsd!) < 1e-9, "and stays capped far above it");
  assert.ok(Math.abs(pnlAtExpiry(c, 85) + c.maxLossUsd) < 1e-9);
  assert.ok(Math.abs(pnlAtExpiry(c, c.breakeven)) < 1e-6);
});

test("put debit spread gains as the stock FALLS and is capped at the width", () => {
  const puts = [K(100, { bid: 8.00, ask: 8.15, delta: -0.78 }), K(90, { bid: 3.00, ask: 3.06, delta: -0.28 })];
  const c = one(buildCandidates({ calls: [], puts, spot: 101.49, expiry: EXP, budgetUsd: 2000, kinds: ["put_debit"] }));
  assert.ok(Math.abs(c.debitUsd - (515 + 0.10)) < 1e-9);
  assert.ok(Math.abs(c.maxProfitUsd! - (1000 - 515.10)) < 1e-9);
  assert.ok(pnlAtExpiry(c, 80) > pnlAtExpiry(c, 95), "more profitable the further it falls");
  assert.ok(Math.abs(pnlAtExpiry(c, 90) - c.maxProfitUsd!) < 1e-9, "capped at the lower strike");
  assert.ok(Math.abs(pnlAtExpiry(c, 0) - c.maxProfitUsd!) < 1e-9);
  assert.ok(Math.abs(pnlAtExpiry(c, 120) + c.maxLossUsd) < 1e-9, "worthless above the long strike");
});

test("put credit spread: the collateral is the risk, NOT the credit", () => {
  const puts = [K(95, { bid: 3.00, ask: 3.06, delta: -0.35 }), K(90, { bid: 1.40, ask: 1.44, delta: -0.20 })];
  const c = one(buildCandidates({ calls: [], puts, spot: 101.49, expiry: EXP, budgetUsd: 2000, kinds: ["put_credit"] }));
  assert.ok(Math.abs(c.creditUsd - 155.90) < 1e-9);
  // The number that gets credit spreads mis-sold as free money.
  assert.ok(Math.abs(c.capitalAtRiskUsd - 344.10) < 1e-9, "width minus credit, not the credit");
  assert.ok(c.capitalAtRiskUsd > c.creditUsd, "risking more than is collected — always true for these");
  assert.ok(Math.abs(c.maxProfitUsd! - 155.90) < 1e-9);
  assert.ok(Math.abs(pnlAtExpiry(c, 120) - 155.90) < 1e-9, "well above the short strike, keep the whole credit");
  assert.ok(Math.abs(pnlAtExpiry(c, 90) + 344.10) < 1e-9, "through the long strike, lose the collateral");
  assert.ok(Math.abs(pnlAtExpiry(c, 0) + 344.10) < 1e-9, "and no worse than that, ever");
  assert.ok(Math.abs(pnlAtExpiry(c, c.breakeven)) < 1e-6);
});

test("call credit spread is the mirror image and loses when the stock RISES", () => {
  const calls = [K(110, { bid: 3.00, ask: 3.06, delta: 0.35 }), K(115, { bid: 1.40, ask: 1.44, delta: 0.20 })];
  const c = one(buildCandidates({ calls, puts: [], spot: 101.49, expiry: EXP, budgetUsd: 2000, kinds: ["call_credit"] }));
  assert.ok(Math.abs(c.creditUsd - 155.90) < 1e-9);
  assert.ok(Math.abs(c.capitalAtRiskUsd - 344.10) < 1e-9);
  assert.ok(Math.abs(pnlAtExpiry(c, 90) - 155.90) < 1e-9, "below the short strike, keep the credit");
  assert.ok(Math.abs(pnlAtExpiry(c, 115) + 344.10) < 1e-9, "through the long strike, max loss");
  assert.ok(Math.abs(pnlAtExpiry(c, 400) + 344.10) < 1e-9, "capped — this is why it is defined risk");
});

test("every structure's pnl is zero at its own stated breakeven", () => {
  const calls = [INTC_85, INTC_115, K(110, { bid: 3.00, ask: 3.06, delta: 0.35 })];
  const puts = [K(100, { bid: 8.00, ask: 8.15, delta: -0.78 }), K(95, { bid: 3.00, ask: 3.06, delta: -0.35 }), K(90, { bid: 1.40, ask: 1.44, delta: -0.20 })];
  const all = [...BULLISH_KINDS, ...BEARISH_KINDS];
  const cands = buildCandidates({ calls, puts, spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: all });
  assert.ok(cands.length >= 6, `expected candidates across all shapes, got ${cands.length}`);
  for (const c of cands) {
    assert.ok(Math.abs(pnlAtExpiry(c, c.breakeven)) < 1e-6, `${c.kind} breakeven ${c.breakeven} gave pnl ${pnlAtExpiry(c, c.breakeven)}`);
  }
});

test("expected move comes from the quoted straddle, not a forecast", () => {
  const call = K(100, { bid: 5.90, ask: 6.10 });
  const put = K(100, { bid: 3.90, ask: 4.10 });
  // (6.00 + 4.00) / 100
  assert.ok(Math.abs(expectedMove(call, put, 100)! - 0.10) < 1e-9);
  assert.equal(expectedMove(null, put, 100), null);
  assert.equal(expectedMove(call, put, 0), null);
  assert.equal(atmOf([K(90), K(103), K(110)], 101.49, EXP)?.strike, 103);
  assert.equal(atmOf([K(90, { expiry: "2027-01-15" })], 101.49, EXP), null);
});

test("illiquid legs and unaffordable structures never become candidates", () => {
  // Short leg quoted 15% wide — a tight long against a garbage short is not a spread.
  const wideShort = K(115, { bid: 9.00, ask: 10.50, delta: 0.446 });
  assert.equal(buildCandidates({ calls: [INTC_85, wideShort], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["call_debit"] }).length, 0);
  // No size behind the short's bid.
  const noSize = K(115, { bid: 9.95, ask: 10.20, bidSize: 0, delta: 0.446 });
  assert.equal(buildCandidates({ calls: [INTC_85, noSize], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["call_debit"] }).length, 0);
  // The naked call costs $2,370 against a $1,925 budget.
  assert.equal(buildCandidates({ calls: [INTC_85], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 1925, kinds: ["long_call"] }).length, 0);
  // Wrong expiry is never mixed into a vertical.
  assert.equal(buildCandidates({ calls: [INTC_85, K(115, { expiry: "2027-01-15", bid: 9.95, ask: 10.20 })], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["call_debit"] }).length, 0);
});

test("a vertical that costs more than its own width can never be a candidate", () => {
  // Long the $100 put at $8.15, short the $95 put at $3.00: a $515.10 debit on a spread
  // worth at most $500. It has a plausible-looking breakeven of $94.85 that the payoff can
  // never actually reach.
  const puts = [K(100, { bid: 8.00, ask: 8.15, delta: -0.55 }), K(95, { bid: 3.00, ask: 3.06, delta: -0.35 })];
  assert.equal(buildCandidates({ calls: [], puts, spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["put_debit"] }).length, 0);
});

test("two independent defences reject the out-of-the-money lottery ticket", () => {
  // FIRST: the delta band. A 0.05-delta call is nowhere near the 0.70-0.85 stock-replacement
  // band, so it is never even built into a candidate. This is the primary defence, and it is
  // what stops the reference-price ranking from falling in love with a cheap call struck just
  // below the reference — which would show a spectacular percentage return there.
  const lotto = K(130, { bid: 1.97, ask: 2.00, delta: 0.05 });
  assert.equal(buildCandidates({ calls: [lotto], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 1925, kinds: ["long_call"] }).length, 0);

  // SECOND: the reference price. Even a properly in-band contract is rejected when it is not
  // profitable at the move the market is actually pricing. The $85 call costs $2,370.05, so
  // with a 1% expected move ($102.50) it is still $620 underwater at expiry.
  const inBand = buildCandidates({ calls: [INTC_85], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["long_call"] });
  assert.equal(inBand.length, 1, "in-band and affordable, so it IS a candidate");
  assert.ok(pnlAtExpiry(inBand[0], 101.49 * 1.01) < 0);
  assert.equal(selectStructure(inBand, 101.49, 0.01), null, "but it needs more than the expected move");
  assert.ok(selectStructure(inBand, 101.49, 0.10), "with a big enough expected move it qualifies");

  // THIRD: the liquidity gate catches the genuinely cheap ones before any of this runs — a
  // 2-cent spread on a 29-cent contract is 6.9% wide. Measured on the live chain 2026-09-10:
  // SOFI 5.3%, APLD 9.5%, UBER 11.7%, all sub-$11 contracts.
  const penny = K(130, { bid: 0.28, ask: 0.30, delta: 0.78 });
  assert.equal(buildCandidates({ calls: [penny], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 1925, kinds: ["long_call"] }).length, 0);
});

test("a sold leg must be out of the money at entry", () => {
  // Selling an in-the-money put is selling the move that already happened, and hands the
  // buyer an immediate reason to exercise early.
  const itmShort = [K(105, { bid: 5.00, ask: 5.10, delta: -0.62 }), K(95, { bid: 1.40, ask: 1.44, delta: -0.20 })];
  assert.equal(buildCandidates({ calls: [], puts: itmShort, spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["put_credit"] }).length, 0);
  const otmShort = [K(95, { bid: 3.00, ask: 3.06, delta: -0.35 }), K(90, { bid: 1.40, ask: 1.44, delta: -0.20 })];
  assert.equal(buildCandidates({ calls: [], puts: otmShort, spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["put_credit"] }).length, 1);
});

test("selection ranks on return at the market's own expected move", () => {
  const cands = buildCandidates({ calls: [INTC_85, INTC_115], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["long_call", "call_debit"] });
  const sel = selectStructure(cands, 101.49, 0.08);   // ref = $109.61
  assert.ok(sel);
  // At $109.61 the spread returns (109.61-85)*100 - 1375.10 = $1,085.90 on $1,375.10 risked
  // (+79%); the naked call returns (109.61-85)*100 - 2370.05 = $90.95 on $2,370.05 (+3.8%).
  assert.equal(sel!.best.kind, "call_debit");
  assert.ok(sel!.returnAtRef > 0.7 && sel!.returnAtRef < 0.9, `got ${sel!.returnAtRef}`);
  assert.ok(Math.abs(sel!.referencePrice - 101.49 * 1.08) < 1e-9);
  assert.equal(selectStructure([], 101.49, 0.08), null);
  assert.equal(selectStructure(cands, 101.49, 0), null, "no expected move, no yardstick, no trade");
});

test("returnAt and the scenario grid stay consistent with the payoff", () => {
  const c = one(buildCandidates({ calls: [INTC_85, INTC_115], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 1925, kinds: ["call_debit"] }));
  assert.ok(Math.abs(returnAt(c, 115)! - c.maxProfitUsd! / c.capitalAtRiskUsd) < 1e-9);
  const grid = scenarioTable(c, 101.49);
  assert.equal(grid.length, 7);
  assert.ok(grid[0].move === -0.10 && grid[6].move === 0.10);
  for (const g of grid) assert.ok(Math.abs(g.pnl - pnlAtExpiry(c, g.price)) < 1e-9);
  // Monotonic for a call spread: it can only do better as the stock rises.
  for (let i = 1; i < grid.length; i++) assert.ok(grid[i].pnl >= grid[i - 1].pnl);
});


// ============ CROSS-LEG SANITY ============
// tradeable() judges each leg in isolation, so these are the checks that stop a vertical being
// assembled from two prices that never existed at the same moment.

test("legs quoted far apart cannot be combined into one vertical", () => {
  const t0 = "2026-09-10T14:00:00Z";
  const near = "2026-09-10T14:30:00Z";
  const far = "2026-09-10T17:00:00Z";
  const long = K(85, { bid: 23.15, ask: 23.70, delta: 0.76, quoteTs: t0 });
  const shortNear = K(115, { bid: 9.95, ask: 10.20, delta: 0.446, quoteTs: near });
  const shortFar = K(115, { bid: 9.95, ask: 10.20, delta: 0.446, quoteTs: far });

  assert.equal(legsQuotedTogether(long, shortNear), true, "30 minutes apart is one price");
  assert.equal(legsQuotedTogether(long, shortFar), false, "3 hours apart is not");
  assert.equal(legsQuotedTogether(long, K(115, { bid: 9.95, ask: 10.20 })), true, "missing timestamps stay permissive");

  const ok = buildCandidates({ calls: [long, shortNear], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["call_debit"] });
  assert.equal(ok.length, 1);
  const skewed = buildCandidates({ calls: [long, shortFar], puts: [], spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["call_debit"] });
  assert.equal(skewed.length, 0, "a stale leg must not become half of a spread");
});

test("an implausibly large credit on an out-of-the-money short is a mispriced leg, not an edge", () => {
  // The failure mode this guards: a stale leg inflates the credit, which SHRINKS capital at
  // risk (width − credit), which INFLATES return-on-risk — so the ranking is attracted to the
  // most mispriced pair precisely because the mispricing is the denominator.
  const rich = [K(95, { bid: 3.50, ask: 3.56, delta: -0.35 }), K(90, { bid: 0.16, ask: 0.20, delta: -0.05 })];
  const [bad] = buildCandidates({ calls: [], puts: rich, spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["put_credit"] });
  assert.equal(bad, undefined, `a $330 credit on a $500-wide spread is ${(330 / 500 * 100).toFixed(0)}% of width, over the ${(MAX_CREDIT_FRAC_OF_WIDTH * 100).toFixed(0)}% bound`);

  const sane = [K(95, { bid: 3.00, ask: 3.06, delta: -0.35 }), K(90, { bid: 1.40, ask: 1.44, delta: -0.20 })];
  assert.equal(buildCandidates({ calls: [], puts: sane, spot: 101.49, expiry: EXP, budgetUsd: 5000, kinds: ["put_credit"] }).length, 1);
});
