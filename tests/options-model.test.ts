import assert from "node:assert/strict";
import { CRYPTO_PROXY_EXCLUDED, MAX_QUOTE_AGE_MS, OPTIONS_SYMBOLS, REG_FEE_PER_CONTRACT, canExitAt, etDateOf, isQuoteFresh, dteOf, type Contract, creditCloseCostUsd, isCreditStructure, isPutStructure, positionMarkUsd, settleAtExpiry, spreadCreditUsd, spreadDebitUsd, spreadPctOf, spreadProceedsUsd, tradeable } from "../src/lib/options-model";
import test from "node:test";

import { buildCandidates, pnlAtExpiry } from "../src/lib/options-structures";
import { parseOcc, toOcc } from "../src/lib/options-occ";

const c = (o: Partial<Contract> = {}): Contract => ({
  occ: "WULF261218C00014000", strike: 14, expiry: "2026-12-18", delta: 0.78,
  bid: 5.20, ask: 5.34, bidSize: 50, askSize: 50, ...o,
});

// ---------- contract selection ----------
// Selection MOVED to options-structures.ts on Sep 10 2026. The findings these tests record are
// real and are kept, re-expressed against the engine that now enforces them. The one genuine
// behaviour change: the book no longer picks the contract NEAREST the 0.78 delta target — it
// picks the highest return at the market's own expected move, from among the contracts inside
// the 0.70-0.85 band. The band survived; "nearest to target" did not.
const longCands = (cs: Contract[], budgetUsd: number) =>
  buildCandidates({ calls: cs, puts: [], spot: 18, expiry: "2026-12-18", budgetUsd, kinds: ["long_call"] });

test("the 0.70-0.85 stock-replacement band is still what a long leg must sit in", () => {
  assert.equal(longCands([c({ delta: 0.71 }), c({ delta: 0.79 }), c({ delta: 0.84 })], 1000).length, 3);
  assert.equal(longCands([c({ delta: 0.45 })], 1000).length, 0, "too far out of the money");
  assert.equal(longCands([c({ delta: 0.95 })], 1000).length, 0, "too deep — paying for intrinsic that cannot grow");
});
test("rejects a wide spread even when the contract is cheap — the F/CCL/CHPT trap", () => {
  // $1.60 contract, 8.2% spread: affordable and untradeable.
  assert.equal(longCands([c({ bid: 1.53, ask: 1.66, strike: 13 })], 1000).length, 0);
});
test("rejects a quote with no size behind it", () => {
  assert.equal(longCands([c({ askSize: 0 })], 1000).length, 0);
  assert.equal(longCands([c({ bidSize: 0 })], 1000).length, 0);
});
test("entry pays the ask, not the mid — the spread is a cost, not a rounding detail", () => {
  const [cand] = longCands([c({ bid: 5.20, ask: 5.34 })], 1000);
  assert.equal(cand.debitUsd, 5.34 * 100 + 0.05);
  assert.ok(cand.debitUsd > (5.20 + 5.34) / 2 * 100, "must be worse than mid");
});
test("spreadPctOf is a round-trip percentage of mid", () => {
  assert.ok(Math.abs(spreadPctOf(5.20, 5.34) - 2.657) < 0.01);
  assert.equal(spreadPctOf(0, 0), Infinity);
});

// ---------- book caps ----------
test("the names that ARE the Kraken book are not in the universe", () => {
  for (const sym of Object.keys(CRYPTO_PROXY_EXCLUDED)) {
    assert.ok(!OPTIONS_SYMBOLS.includes(sym), `${sym} must stay excluded — it duplicates the crypto desk`);
  }
  assert.ok(OPTIONS_SYMBOLS.includes("WULF"), "WULF is 0.09 to BTC — a genuine diversifier, keep it");
  assert.ok(OPTIONS_SYMBOLS.includes("CRWV"));
});
test("OCC symbols parse from the right, so variable-length roots work", () => {
  assert.deepEqual(parseOcc("WULF261218C00014000"), { root: "WULF", expiry: "2026-12-18", type: "call", strike: 14 });
  assert.deepEqual(parseOcc("SPY260908C00505000"), { root: "SPY", expiry: "2026-09-08", type: "call", strike: 505 });
  assert.equal(parseOcc("garbage"), null);
  // toOcc is new with the Robinhood move: Robinhood identifies contracts by UUID, not OCC,
  // so this book now BUILDS the key its table and quote inbox are indexed on. A padding or
  // thousandths bug here would not throw — it would produce a symbol that never matches a
  // stored quote, and open positions would silently stop marking.
  assert.equal(toOcc("WULF", "2026-12-18", "call", 14), "WULF261218C00014000");
  assert.equal(toOcc("SPY", "2026-09-08", "call", 505), "SPY260908C00505000");
  assert.deepEqual(parseOcc(toOcc("IREN", "2026-11-20", "call", 37)), { root: "IREN", expiry: "2026-11-20", type: "call", strike: 37 });
  assert.deepEqual(parseOcc(toOcc("AAPL", "2027-01-15", "put", 312.5)), { root: "AAPL", expiry: "2027-01-15", type: "put", strike: 312.5 });
});
test("dteOf counts days to expiry", () => {
  assert.equal(dteOf("2026-12-18", new Date("2026-09-08T12:00:00Z")), 101);   // floored, not rounded up
  assert.ok(dteOf("2026-09-08", new Date("2026-09-09T12:00:00Z")) <= 0);
});


// ---------- regressions from the Sep 8 cross-model review (Codex) ----------
test("REGRESSION: a Dec-18 expiry is not 0 DTE when the 22:00 UTC cron runs on Dec 17", () => {
  // The cron fires at 22:00 UTC daily. Timestamp subtraction + floor made the day BEFORE
  // expiry read as 0 and settled every position a day early — deterministically, because
  // that is exactly when the job runs. Calendar days fix it.
  assert.equal(dteOf("2026-12-18", new Date("2026-12-17T22:00:00Z")), 1);
  assert.equal(dteOf("2026-12-18", new Date("2026-12-18T13:00:00Z")), 0);
  assert.equal(dteOf("2026-12-18", new Date("2026-12-21T22:00:00Z")), -3);
});
test("etDateOf resolves the ET calendar date across the UTC day boundary", () => {
  // 01:00 UTC on the 9th is still the 8th in New York — the difference between settling a
  // contract on the right day and the wrong one.
  assert.equal(etDateOf(new Date("2026-09-09T01:00:00Z")), "2026-09-08");
  assert.equal(etDateOf(new Date("2026-09-08T18:00:00Z")), "2026-09-08");
});
test("REGRESSION: a bid with no size behind it cannot close a position", () => {
  const now = new Date("2026-09-08T20:00:00Z");
  const fresh = now.toISOString();
  assert.equal(canExitAt({ bid: 6, bidSize: 0, quoteTs: fresh }, now), false, "zero size is not an exit");
  assert.equal(canExitAt({ bid: 0, bidSize: 50, quoteTs: fresh }, now), false);
  assert.equal(canExitAt({ bid: 6, bidSize: 1, quoteTs: fresh }, now), true);
});
test("REGRESSION: a stale quote cannot open or close a position", () => {
  const now = new Date("2026-09-08T20:00:00Z");
  const old = new Date(now.getTime() - MAX_QUOTE_AGE_MS - 1000).toISOString();
  assert.equal(isQuoteFresh(old, now), false);
  assert.equal(isQuoteFresh(null, now), false);
  assert.equal(canExitAt({ bid: 6, bidSize: 50, quoteTs: old }, now), false);
  assert.equal(isQuoteFresh(new Date(now.getTime() - 3600_000).toISOString(), now), true);
});
test("tradeable holds the short leg to the same standard as the long", () => {
  assert.equal(tradeable(c()), true);
  assert.equal(tradeable(c({ bid: 0 })), false);              // no two-sided market
  assert.equal(tradeable(c({ bidSize: 0 })), false);          // no size behind the bid
  assert.equal(tradeable(c({ askSize: 0 })), false);          // nothing offered
  assert.equal(tradeable(c({ bid: 5.00, ask: 5.40 })), false); // 7.7% wide, over the 3% ceiling
});
test("credit received opening a vertical is the short's bid less the long's ask, both fees", () => {
  assert.ok(Math.abs(spreadCreditUsd(3.00, 1.44) - (156 - 2 * REG_FEE_PER_CONTRACT)) < 1e-9);
});
test("spread cash flows charge BOTH legs a fee on each side", () => {
  // Pay the long's ask, receive the short's bid.
  assert.ok(Math.abs(spreadDebitUsd(23.70, 9.95) - (1375 + 2 * REG_FEE_PER_CONTRACT)) < 1e-9);
  // Sell the long's bid, buy the short's ask back.
  assert.ok(Math.abs(spreadProceedsUsd(23.15, 10.20) - (1295 - 2 * REG_FEE_PER_CONTRACT)) < 1e-9);
});
test("a vertical can never be worth less than nothing", () => {
  // Crossed/stale quotes must not book a loss deeper than the debit paid.
  assert.ok(spreadProceedsUsd(5.00, 9.00) < 0);                       // fees only
  assert.ok(spreadProceedsUsd(5.00, 9.00) >= -2 * REG_FEE_PER_CONTRACT);
});
test("isCreditStructure knows which side of the trade we are on", () => {
  assert.equal(isCreditStructure("put_credit_spread"), true);
  assert.equal(isCreditStructure("call_credit_spread"), true);
  assert.equal(isCreditStructure("call_spread"), false);
  assert.equal(isCreditStructure("call"), false);
  assert.equal(isCreditStructure(null), false);
});
test("a debit position's mark is still just what it could be sold for", () => {
  // Naked call: the bid.
  assert.equal(positionMarkUsd({ structure: "call", capitalAtRiskUsd: 2370.05, creditUsd: 0, longBid: 21.00 }), 2100);
  // Debit spread: sell the long, buy the short back.
  assert.equal(positionMarkUsd({ structure: "call_spread", capitalAtRiskUsd: 1375.10, creditUsd: 0, longBid: 25.00, shortAsk: 11.00 }), 1400);
  // Crossed quotes cannot mark it below zero.
  assert.equal(positionMarkUsd({ structure: "call_spread", capitalAtRiskUsd: 1375.10, creditUsd: 0, longBid: 5.00, shortAsk: 9.00 }), 0);
});
test("a credit position is marked as collateral plus what it has made so far", () => {
  // Short $95 put / long $90 put: credit $155.90, collateral $344.10, width $500.
  const base = { structure: "put_credit_spread", capitalAtRiskUsd: 344.10, creditUsd: 155.90 };
  // Right after entry it is DOWN the round trip, exactly like a fresh long is.
  const atEntry = positionMarkUsd({ ...base, longBid: 1.40, shortAsk: 3.06 });
  assert.ok(atEntry < 344.10 && atEntry > 300, `expected just under collateral, got ${atEntry}`);
  // Decayed to nothing — the whole credit is kept, so the position is worth the full width.
  assert.ok(Math.abs(positionMarkUsd({ ...base, longBid: 0, shortAsk: 0 }) - 500) < 1e-9);
  // Fully against us: costs the width to close, so the collateral is gone.
  assert.equal(positionMarkUsd({ ...base, longBid: 0, shortAsk: 5.00 }), 0);
  // And never below zero, however ugly the quotes get.
  assert.equal(positionMarkUsd({ ...base, longBid: 0, shortAsk: 40 }), 0);
});
test("closing a credit spread costs the short's ask less the long's bid, plus both fees", () => {
  assert.ok(Math.abs(creditCloseCostUsd(3.06, 1.40, 500) - (166 + 2 * REG_FEE_PER_CONTRACT)) < 1e-9);
  // A worthless spread still costs the fees to close — and never a negative amount.
  assert.ok(Math.abs(creditCloseCostUsd(0.01, 0.05, 500) - 2 * REG_FEE_PER_CONTRACT) < 1e-9);
});
test("a credit spread can never be closed for more than its width — parity is enough to breach it", () => {
  // Short 95p / long 90p, $5 wide. Stock at 82.50: 95p ask 12.60, 90p bid 7.40. Crossing both
  // legs costs $5.20 of a $5.00-wide spread — no crossed market required, just parity.
  // Uncapped this booked a 105% loss on a defined-risk position.
  const width = 500;
  assert.equal(creditCloseCostUsd(12.60, 7.40, width), width);
  // So the worst P&L equals the collateral exactly, never worse.
  const credit = 144.90;
  const collateral = width - credit;
  const worstPnl = credit - creditCloseCostUsd(12.60, 7.40, width);
  assert.ok(Math.abs(worstPnl + collateral) < 1e-9, `worst pnl ${worstPnl} must equal -collateral ${-collateral}`);
});
test("credit settlement: keep it all above the short strike, lose the collateral below the long", () => {
  const base = { structure: "put_credit_spread", longStrike: 90, shortStrike: 95, widthUsd: 500, capitalAtRiskUsd: 344.10, creditUsd: 155.90 };
  const at = (close: number) => settleAtExpiry({ ...base, close });

  assert.ok(Math.abs(at(120).pnlUsd - 155.90) < 1e-9, "well above: keep the whole credit");
  assert.ok(Math.abs(at(120).valueUsd - 500) < 1e-9, "which is the full width");
  assert.ok(Math.abs(at(95).pnlUsd - 155.90) < 1e-9, "at the short strike it still expires worthless");
  assert.ok(Math.abs(at(93).pnlUsd + 44.10) < 1e-9, "partly through: credit minus the intrinsic");
  assert.ok(Math.abs(at(90).pnlUsd + 344.10) < 1e-9, "at the long strike: the full collateral");
  assert.ok(Math.abs(at(0).pnlUsd + 344.10) < 1e-9, "and no worse if it goes to zero");
  assert.ok(at(0).valueUsd === 0);
});
test("debit settlement is unchanged and still capped at the width", () => {
  const spread = { structure: "call_spread", longStrike: 85, shortStrike: 115, widthUsd: 3000, capitalAtRiskUsd: 1375.10, creditUsd: 0 };
  assert.ok(Math.abs(settleAtExpiry({ ...spread, close: 150 }).valueUsd - 3000) < 1e-9, "capped above the short strike");
  assert.ok(Math.abs(settleAtExpiry({ ...spread, close: 150 }).pnlUsd - 1624.90) < 1e-9);
  assert.ok(Math.abs(settleAtExpiry({ ...spread, close: 80 }).pnlUsd + 1375.10) < 1e-9);
  const naked = { structure: "call", longStrike: 85, shortStrike: null, widthUsd: null, capitalAtRiskUsd: 2370.05, creditUsd: 0 };
  assert.ok(Math.abs(settleAtExpiry({ ...naked, close: 150 }).valueUsd - 6500) < 1e-9, "a naked call is never capped");
});
test("settlement agrees with the structure engine's independent payoff function", () => {
  // Two implementations written separately: the stored-row settlement here, and the
  // candidate payoff in options-structures.ts. If they ever disagree, one of them is wrong.
  const puts = [
    { occ: "P95", strike: 95, expiry: "2026-12-18", delta: -0.35, bid: 3.00, ask: 3.06, bidSize: 50, askSize: 50 },
    { occ: "P90", strike: 90, expiry: "2026-12-18", delta: -0.20, bid: 1.40, ask: 1.44, bidSize: 50, askSize: 50 },
  ];
  const [cand] = buildCandidates({ calls: [], puts, spot: 101.49, expiry: "2026-12-18", budgetUsd: 2000, kinds: ["put_credit"] });
  assert.ok(cand, "the credit spread must be a candidate");
  for (const close of [0, 85, 90, 92.5, 93, 95, 101.49, 140]) {
    const engine = pnlAtExpiry(cand, close);
    const stored = settleAtExpiry({
      structure: "put_credit_spread", longStrike: 90, shortStrike: 95,
      widthUsd: 500, close, capitalAtRiskUsd: cand.capitalAtRiskUsd, creditUsd: cand.creditUsd,
    }).pnlUsd;
    assert.ok(Math.abs(engine - stored) < 1e-9, `close ${close}: engine ${engine} vs stored ${stored}`);
  }
});
test("leg type and direction are different questions — conflating them inverts settlement", () => {
  // A put credit spread is BULLISH but its legs are PUTS; a call credit spread is BEARISH but
  // its legs are CALLS. Settlement follows the leg type, never the direction.
  assert.equal(isPutStructure("put_credit_spread"), true);
  assert.equal(isPutStructure("call_credit_spread"), false);
  assert.equal(isPutStructure("put"), true);
  assert.equal(isPutStructure("put_spread"), true);
  assert.equal(isPutStructure("call"), false);
  assert.equal(isPutStructure("call_spread"), false);
  assert.equal(isCreditStructure("put_credit_spread"), true);
  assert.equal(isCreditStructure("call_credit_spread"), true);
  assert.equal(isCreditStructure("put_spread"), false);
});
