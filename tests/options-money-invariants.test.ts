import assert from "node:assert/strict";
import test from "node:test";
import type { Contract } from "../src/lib/options-paper-model";
import { positionMarkUsd, settleAtExpiry } from "../src/lib/options-paper-model";
import { type Candidate, buildCandidates, pnlAtExpiry } from "../src/lib/options-structures";

// ============ MONEY INVARIANTS, RANDOMISED ============
//
// Both cross-model reviewers were out of credits when this landed, so the money math is
// verified the stronger way instead: by asserting the properties that MUST hold for every
// defined-risk position, over thousands of generated chains. A sign error does not throw and
// a single hand-written example can miss it; a property that holds for one position and not
// another cannot hide.
//
// Seeded so any failure reproduces exactly.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A quote with a ~2% spread — inside the book's 3% ceiling, so it is tradeable. */
function quote(strike: number, mid: number, expiry: string, delta: number): Contract {
  const m = Math.max(0.5, mid);
  return {
    occ: `X${strike}`, strike, expiry, delta,
    bid: r2(m * 0.99), ask: r2(m * 1.01), bidSize: 50, askSize: 50,
  };
}

/** The stored-row shape the shadow layer would have written for a candidate. */
function asStored(c: Candidate) {
  const buy = c.legs.find((l) => l.side === "buy")!.contract;
  const sell = c.legs.find((l) => l.side === "sell")?.contract;
  const structure = c.kind === "put_credit" ? "put_credit_spread" : sell ? "call_spread" : "call";
  return {
    structure, longStrike: buy.strike, shortStrike: sell?.strike ?? null,
    widthUsd: sell ? Math.abs(sell.strike - buy.strike) * 100 : null,
    capitalAtRiskUsd: c.capitalAtRiskUsd, creditUsd: c.creditUsd,
  };
}

const EXP = "2026-12-18";

test("no defined-risk position can lose more than its capital at risk, ever", () => {
  const rand = rng(20260910);
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const spot = 20 + rand() * 200;
    // Calls: one in the money, one above spot to sell against it.
    const kLong = r2(spot * (0.70 + rand() * 0.15));
    const kShort = r2(spot * (1.0 + rand() * 0.25));
    const longMid = (spot - kLong) + spot * 0.03 * rand();
    const shortMid = Math.max(0.5, longMid * (0.15 + 0.45 * rand()));
    const calls = [quote(kLong, longMid, EXP, 0.78), quote(kShort, shortMid, EXP, 0.35)];
    // Puts: a short strike below spot and a long strike below that.
    const pShort = r2(spot * (0.90 + rand() * 0.07));
    const pLong = r2(pShort * (0.90 + rand() * 0.06));
    const pShortMid = Math.max(0.5, spot * 0.03 * (0.5 + rand()));
    const puts = [quote(pShort, pShortMid, EXP, -0.32), quote(pLong, pShortMid * (0.3 + 0.4 * rand()), EXP, -0.18)];

    const cands = buildCandidates({
      calls, puts, spot, expiry: EXP, budgetUsd: 1e9,
      kinds: ["long_call", "call_debit", "put_credit"],
    });
    for (const c of cands) {
      const stored = asStored(c);
      for (let k = 0; k < 12; k++) {
        const close = k === 0 ? 0 : r2(spot * (0.2 + rand() * 2.5));
        const pnl = pnlAtExpiry(c, close);

        // 1. Never lose more than the capital at risk.
        assert.ok(pnl >= -c.capitalAtRiskUsd - 1e-6,
          `${c.kind} @${close}: pnl ${pnl} below -capitalAtRisk ${-c.capitalAtRiskUsd}`);
        // 2. Never make more than the stated maximum (naked longs are exempt — unbounded).
        if (c.maxProfitUsd !== null) {
          assert.ok(pnl <= c.maxProfitUsd + 1e-6,
            `${c.kind} @${close}: pnl ${pnl} above maxProfit ${c.maxProfitUsd}`);
        }
        // 3. The stored-row settlement must agree with the engine's payoff, always.
        const s = settleAtExpiry({ ...stored, close });
        assert.ok(Math.abs(s.pnlUsd - pnl) < 1e-6,
          `${c.kind} @${close}: stored ${s.pnlUsd} vs engine ${pnl}`);
        // 4. Terminal value is capital at risk plus P&L, and never negative.
        assert.ok(s.valueUsd >= -1e-6, `${c.kind} @${close}: negative value ${s.valueUsd}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 2000, `expected a broad sweep, only checked ${checked}`);
});

test("the mark is never negative and never exceeds what the position can be worth", () => {
  const rand = rng(7734);
  for (let i = 0; i < 3000; i++) {
    const capitalAtRisk = 100 + rand() * 4000;
    const isCredit = rand() < 0.5;
    const credit = isCredit ? rand() * capitalAtRisk : 0;
    // Deliberately hostile quotes, including crossed and absurd ones.
    const longBid = rand() < 0.1 ? 0 : rand() * 60;
    const shortAsk = rand() < 0.1 ? 0 : rand() * 60;
    const mark = positionMarkUsd({
      structure: isCredit ? "put_credit_spread" : "call_spread",
      capitalAtRiskUsd: capitalAtRisk, creditUsd: credit,
      longBid, shortAsk,
    });
    assert.ok(mark >= 0, `mark went negative: ${mark}`);
    assert.ok(Number.isFinite(mark), `mark not finite: ${mark}`);
    if (isCredit) {
      // A credit position is worth at most collateral + the whole credit — the case where the
      // spread expires worthless and every dollar collected is kept.
      assert.ok(mark <= capitalAtRisk + credit + 1e-6,
        `credit mark ${mark} exceeds collateral+credit ${capitalAtRisk + credit}`);
    }
  }
});

test("a debit position's mark still reduces to what it could be sold for", () => {
  // The property that let every pre-existing exit rule survive the change untouched.
  const rand = rng(4242);
  for (let i = 0; i < 1000; i++) {
    const longBid = rand() * 50;
    const capitalAtRisk = 50 + rand() * 3000;
    assert.ok(Math.abs(
      positionMarkUsd({ structure: "call", capitalAtRiskUsd: capitalAtRisk, creditUsd: 0, longBid }) - longBid * 100,
    ) < 1e-9, "naked call marks at the bid");
    const shortAsk = rand() * 50;
    const expected = Math.max(0, (longBid - shortAsk) * 100);
    assert.ok(Math.abs(
      positionMarkUsd({ structure: "call_spread", capitalAtRiskUsd: capitalAtRisk, creditUsd: 0, longBid, shortAsk }) - expected,
    ) < 1e-9, "debit spread marks at what unwinding it pays");
  }
});

test("bullish structures never get worse as the underlying rises", () => {
  const rand = rng(999);
  for (let i = 0; i < 200; i++) {
    const spot = 30 + rand() * 150;
    const kLong = r2(spot * 0.8);
    const kShort = r2(spot * 1.1);
    const calls = [quote(kLong, (spot - kLong) + spot * 0.02, EXP, 0.78), quote(kShort, spot * 0.02, EXP, 0.3)];
    const pShort = r2(spot * 0.93);
    const pLong = r2(spot * 0.85);
    const puts = [quote(pShort, spot * 0.03, EXP, -0.3), quote(pLong, spot * 0.012, EXP, -0.15)];
    const cands = buildCandidates({ calls, puts, spot, expiry: EXP, budgetUsd: 1e9, kinds: ["long_call", "call_debit", "put_credit"] });
    for (const c of cands) {
      let prev = -Infinity;
      for (let px = 0; px <= spot * 2; px += spot / 20) {
        const pnl = pnlAtExpiry(c, px);
        assert.ok(pnl >= prev - 1e-6, `${c.kind} fell as price rose at ${px}: ${pnl} < ${prev}`);
        prev = pnl;
      }
    }
  }
});
