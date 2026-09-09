import assert from "node:assert/strict";
import test from "node:test";
import {
  CRYPTO_PROXY_EXCLUDED, MAX_ENTRIES_PER_MONTH, OPTIONS_SYMBOLS,
  type Bar, type BookState, type Contract,
  dteOf, entryRefusal, exitReason, groupOf, isEntrySignal, isExitSignal,
  pickContract, positionBudget, spreadPctOf,
} from "../src/lib/options-paper-model";
import { parseOcc } from "../src/lib/alpaca-options";

const c = (o: Partial<Contract> = {}): Contract => ({
  occ: "WULF261218C00014000", strike: 14, expiry: "2026-12-18", delta: 0.78,
  bid: 5.20, ask: 5.34, bidSize: 50, askSize: 50, ...o,
});
const book = (o: Partial<BookState> = {}): BookState =>
  ({ openCount: 0, openPremium: 0, entriesThisMonth: 0, openGroups: [], ...o });

// ---------- contract selection ----------
test("picks the contract closest to the 0.78 delta target", () => {
  const pick = pickContract([c({ delta: 0.71 }), c({ delta: 0.79, occ: "X" }), c({ delta: 0.84 })], 1000);
  assert.equal(pick?.contract.occ, "X");
});

test("rejects a wide spread even when the contract is cheap — the F/CCL/CHPT trap", () => {
  // $1.60 contract, 8.2% spread: affordable and untradeable.
  assert.equal(pickContract([c({ bid: 1.53, ask: 1.66, strike: 13 })], 1000), null);
});

test("rejects out-of-the-money and deep-ITM deltas outside 0.70-0.85", () => {
  assert.equal(pickContract([c({ delta: 0.45 })], 1000), null);
  assert.equal(pickContract([c({ delta: 0.95 })], 1000), null);
});

test("rejects a quote with no size behind it", () => {
  assert.equal(pickContract([c({ askSize: 0 })], 1000), null);
  assert.equal(pickContract([c({ bidSize: 0 })], 1000), null);
});

test("rejects a contract over the position budget, and the $1k budget is 55%", () => {
  assert.equal(positionBudget(1000), 550);
  assert.equal(positionBudget(5000), 2750);
  // A real CRWV quote: $31.39 mid = $3,139. Unaffordable on $1k, affordable on neither
  // budget here — exactly the finding that motivated the two-sleeve experiment.
  const crwv = c({ bid: 31.37, ask: 31.41, delta: 0.81, occ: "CRWV" });
  assert.equal(pickContract([crwv], positionBudget(1000)), null);
  assert.equal(pickContract([crwv], positionBudget(5000)), null);
});

test("a real WULF quote ($539) fits the $1k budget — the cap must not shut the sleeve out", () => {
  // The live Sep 8 quote: WULF Dec-18 $14 call, 0.78 delta, 2.6% spread, $5.39 ask.
  // At a 40% cap ($400) this was refused and the $1k sleeve could never have traded at all.
  const pick = pickContract([c({ bid: 5.25, ask: 5.39, delta: 0.78 })], positionBudget(1000));
  assert.ok(pick, "WULF $14 call must pass on the $1k sleeve");
  assert.ok(pick!.costUsd <= positionBudget(1000));
  assert.ok(pick!.spreadPct < 3);
});

test("$1k still cannot reach CRWV or IREN — that gap IS the experiment", () => {
  const crwv = c({ bid: 31.37, ask: 31.41, delta: 0.81 });
  const iren = c({ bid: 17.42, ask: 17.46, delta: 0.85 });
  assert.equal(pickContract([crwv, iren], positionBudget(1000)), null);
  assert.ok(pickContract([iren], positionBudget(5000)), "the $5k sleeve reaches IREN");
  assert.equal(pickContract([crwv], positionBudget(5000)), null, "even $5k cannot reach CRWV");
});

test("entry pays the ask, not the mid — the spread is a cost, not a rounding detail", () => {
  const pick = pickContract([c({ bid: 5.20, ask: 5.34 })], 1000);
  assert.equal(pick!.costUsd, 5.34 * 100 + 0.05);
  assert.ok(pick!.costUsd > (5.20 + 5.34) / 2 * 100, "must be worse than mid");
});

test("spreadPctOf is a round-trip percentage of mid", () => {
  assert.ok(Math.abs(spreadPctOf(5.20, 5.34) - 2.657) < 0.01);
  assert.equal(spreadPctOf(0, 0), Infinity);
});

// ---------- book caps ----------
test("monthly entry cap is the frequency discipline and fires first", () => {
  assert.equal(entryRefusal(book({ entriesThisMonth: MAX_ENTRIES_PER_MONTH }), "semis", 1000, 100), "monthly entry cap");
});

test("one position per correlation group — WULF and IREN cannot both be open", () => {
  assert.equal(groupOf("WULF"), "ai-datacenter");
  assert.equal(groupOf("IREN"), "ai-datacenter");
  assert.equal(entryRefusal(book({ openGroups: ["ai-datacenter"] }), "ai-datacenter", 1000, 100), "correlated position already open");
  assert.equal(entryRefusal(book({ openGroups: ["ai-datacenter"] }), "consumer", 1000, 100), null);
});

test("concurrent and book-premium caps hold", () => {
  assert.equal(entryRefusal(book({ openCount: 3 }), "semis", 1000, 100), "max concurrent positions");
  assert.equal(entryRefusal(book({ openPremium: 750 }), "semis", 1000, 100), "book premium cap");
  assert.equal(entryRefusal(book({ openPremium: 700 }), "semis", 1000, 100), null);
  // 55% + 55% > the 80% book cap, so two full-size positions can never coexist.
  assert.equal(entryRefusal(book({ openCount: 1, openPremium: 550 }), "semis", 1000, 550), "book premium cap");
});

test("a contract over the position budget is refused by the book too", () => {
  assert.equal(entryRefusal(book(), "semis", 1000, 551), "no contract passes filters");
  assert.equal(entryRefusal(book(), "semis", 1000, 550), null);
});

// ---------- the crypto-proxy exclusion ----------
test("the names that ARE the Kraken book are not in the universe", () => {
  for (const sym of Object.keys(CRYPTO_PROXY_EXCLUDED)) {
    assert.ok(!OPTIONS_SYMBOLS.includes(sym), `${sym} must stay excluded — it duplicates the crypto desk`);
  }
  assert.ok(OPTIONS_SYMBOLS.includes("WULF"), "WULF is 0.09 to BTC — a genuine diversifier, keep it");
  assert.ok(OPTIONS_SYMBOLS.includes("CRWV"));
});

test("every universe name has a correlation group", () => {
  for (const s of OPTIONS_SYMBOLS) assert.ok(groupOf(s), `${s} needs a group`);
});

// ---------- the signal ----------
const bars = (closes: number[]): Bar[] => closes.map((c, i) => ({ t: `d${i}`, c, h: c, l: c }));

test("entry needs a 50-day high AND the 200-day trend filter", () => {
  const rising = Array.from({ length: 260 }, (_, i) => 100 + i);          // new high, above SMA
  assert.equal(isEntrySignal(bars(rising)), true);
  const falling = Array.from({ length: 260 }, (_, i) => 400 - i);         // new low
  assert.equal(isEntrySignal(bars(falling)), false);
});

test("a 50-day high BELOW the 200-day average is refused — no breakouts inside a downtrend", () => {
  // Long decline, then a bounce that clears the last 50 days but stays under the 200-day SMA.
  const decline = Array.from({ length: 220 }, (_, i) => 400 - i * 1.5);
  const bounce = Array.from({ length: 40 }, (_, i) => 75 + i);
  const series = [...decline, ...bounce];
  const closes = series.map((c) => c);
  const sma = closes.slice(-200).reduce((s, x) => s + x, 0) / 200;
  assert.ok(closes[closes.length - 1] < sma, "fixture must sit below its 200-day average");
  assert.equal(isEntrySignal(bars(series)), false);
});

test("not enough history is never a signal", () => {
  assert.equal(isEntrySignal(bars([1, 2, 3])), false);
});

test("exit fires on a 25-day low", () => {
  assert.equal(isExitSignal(bars(Array.from({ length: 40 }, (_, i) => 100 - i))), true);
  assert.equal(isExitSignal(bars(Array.from({ length: 40 }, (_, i) => 100 + i))), false);
});

// ---------- exits ----------
test("exit priority: trend, then the DTE floor, then the premium stop", () => {
  assert.equal(exitReason({ trendExit: true, dte: 90, markUsd: 900, costUsd: 500 }), "trend exit");
  assert.equal(exitReason({ trendExit: false, dte: 21, markUsd: 900, costUsd: 500 }), "dte floor");
  assert.equal(exitReason({ trendExit: false, dte: 90, markUsd: 250, costUsd: 500 }), "premium stop");
  assert.equal(exitReason({ trendExit: false, dte: 90, markUsd: 251, costUsd: 500 }), null);
});

test("there is no profit target — a winner is never cut", () => {
  assert.equal(exitReason({ trendExit: false, dte: 90, markUsd: 5000, costUsd: 500 }), null);
});

// ---------- OCC parsing ----------
test("OCC symbols parse from the right, so variable-length roots work", () => {
  assert.deepEqual(parseOcc("WULF261218C00014000"), { root: "WULF", expiry: "2026-12-18", type: "call", strike: 14 });
  assert.deepEqual(parseOcc("SPY260908C00505000"), { root: "SPY", expiry: "2026-09-08", type: "call", strike: 505 });
  assert.equal(parseOcc("garbage"), null);
});

test("dteOf counts days to expiry", () => {
  assert.equal(dteOf("2026-12-18", new Date("2026-09-08T12:00:00Z")), 101);   // floored, not rounded up
  assert.ok(dteOf("2026-09-08", new Date("2026-09-09T12:00:00Z")) <= 0);
});
