import assert from "node:assert/strict";
import test from "node:test";
import {
  CRYPTO_PROXY_EXCLUDED, MAX_ENTRIES_PER_MONTH, MAX_QUOTE_AGE_MS, OPTIONS_SYMBOLS,
  canExitAt, etDateOf, isQuoteFresh,
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

test("REGRESSION: selection respects the SPENDABLE budget, not just the position budget", () => {
  // $500 already committed on the $1k sleeve leaves $300 under the 80% book cap. The
  // 0.78-delta contract at $500 is nearest the target but unaffordable; the 0.75-delta at
  // $295 passes everything. Selecting on the position budget alone skipped the entry.
  const near = c({ delta: 0.78, bid: 4.95, ask: 5.00, occ: "NEAR" });
  const cheaper = c({ delta: 0.75, bid: 2.92, ask: 2.95, occ: "CHEAPER" });
  assert.equal(pickContract([near, cheaper], positionBudget(1000))?.contract.occ, "NEAR");
  assert.equal(pickContract([near, cheaper], 300)?.contract.occ, "CHEAPER");
});

// ── 2026-09-09: earnings blackout ────────────────────────────────────────────────────────
import { EARNINGS_BLACKOUT_DAYS, inEarningsBlackout } from "../src/lib/options-paper-model";

test("no premium is bought inside the earnings blackout, and the window is what it says", () => {
  const now = new Date("2026-09-09T22:00:00Z");
  const cal = [
    { symbol: "IREN", date: "2026-09-16" },   // 7 days out — inside
    { symbol: "WULF", date: "2026-09-23" },   // 14 days out — the edge, inside
    { symbol: "APLD", date: "2026-09-24" },   // 15 days out — outside
    { symbol: "CRWV", date: "2026-09-09" },   // reports TODAY — inside
    { symbol: "HUT",  date: "2026-09-01" },   // already reported — outside (post-print is the GOOD time)
  ];
  assert.equal(EARNINGS_BLACKOUT_DAYS, 14);
  assert.deepEqual(inEarningsBlackout("IREN", cal, now), { blocked: true, date: "2026-09-16" });
  assert.deepEqual(inEarningsBlackout("WULF", cal, now), { blocked: true, date: "2026-09-23" });
  assert.deepEqual(inEarningsBlackout("APLD", cal, now), { blocked: false });
  assert.deepEqual(inEarningsBlackout("CRWV", cal, now), { blocked: true, date: "2026-09-09" });
  assert.deepEqual(inEarningsBlackout("HUT", cal, now), { blocked: false }, "entering AFTER the print is the intended trade");
  assert.deepEqual(inEarningsBlackout("NBIS", cal, now), { blocked: false }, "not on the calendar → not blocked");
  // Case-insensitive on the symbol; the nearest date wins when a name has several.
  assert.deepEqual(inEarningsBlackout("iren", [...cal, { symbol: "IREN", date: "2026-09-12" }], now), { blocked: true, date: "2026-09-12" });
  // A malformed date can never block or unblock by accident.
  assert.deepEqual(inEarningsBlackout("IREN", [{ symbol: "IREN", date: "not-a-date" }], now), { blocked: false });
});
