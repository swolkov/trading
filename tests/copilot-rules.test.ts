import assert from "node:assert/strict";
import test from "node:test";
import { ENTRY_STOP_GRACE_MS, STOP_SETTLE_MS, breakevenPx, costShare, runnerSplit, duration, timeBucket, priceFromOpenPnl, protectiveStop, step, type CopilotOrder, type CopilotSnapshot, type CopilotState } from "../src/lib/copilot-rules";

const T0 = Date.parse("2026-09-23T14:00:00Z");
const stop = (price: number, action: "Buy" | "Sell" = "Sell", qty = 20, symbol: CopilotOrder["symbol"] = "MES"): CopilotOrder => ({ orderId: 1, symbol, action, kind: "stop", price, qty });
const limit = (price: number, action: "Buy" | "Sell" = "Sell", qty = 20): CopilotOrder => ({ orderId: 2, symbol: "MES", action, kind: "limit", price, qty });
function snap(dtMs: number, netPos: number, netPrice: number, orders: CopilotOrder[] | null, price?: number, extra: Partial<CopilotSnapshot> = {}): CopilotSnapshot {
  return { nowMs: T0 + dtMs, positions: netPos ? [{ symbol: "MES", netPos, netPrice }] : [], orders, prices: price != null ? { MES: price } : {}, fills: [], ...extra };
}
function run(steps: CopilotSnapshot[], start: CopilotState = { trips: {} }) {
  let st = start; const out: string[][] = [];
  for (const s of steps) { const r = step(st, s); st = r.state; out.push(r.messages); }
  return { state: st, out };
}

test("long entry with a stop: one card with the dollar risk and the +1R / +2R prices", () => {
  const { out, state } = run([snap(0, 20, 7831.25, [stop(7827.75)])]);
  assert.equal(out[0].length, 1);
  assert.match(out[0][0], /MES LONG 20 @ 7831\.25 · stop 7827\.75 = \$350 \(1R\)/);
  assert.match(out[0][0], /\+1R 7834\.75 · \+2R 7838\.25/);
  assert.equal(state.trips.MES!.riskPts, 3.5);
});

test("short entry: risk and R levels mirror", () => {
  const { out } = run([snap(0, -20, 7840, [stop(7843, "Buy")])]);
  assert.match(out[0][0], /MES SHORT 20 @ 7840\.00 · stop 7843\.00 = \$300 \(1R\)/);
  assert.match(out[0][0], /\+1R 7837\.00 · \+2R 7834\.00/);
});

test("entry without a stop: nothing until the grace period, then the warning; a later stop is announced", () => {
  const { out } = run([
    snap(0, 20, 7831.25, []),
    snap(ENTRY_STOP_GRACE_MS - 1_000, 20, 7831.25, []),
    snap(ENTRY_STOP_GRACE_MS, 20, 7831.25, []),
    snap(ENTRY_STOP_GRACE_MS + 15_000, 20, 7831.25, [stop(7828.25)]),
  ]);
  assert.deepEqual(out[0], []); assert.deepEqual(out[1], []);
  assert.match(out[2][0], /NO STOP on 20 MES/);
  assert.match(out[3][0], /stop placed 7828\.25 · risk \$300/);
});

test("a stop placed inside the grace period makes a normal card, no warning", () => {
  const { out } = run([snap(0, 20, 7831.25, []), snap(15_000, 20, 7831.25, [stop(7828.25)])]);
  assert.deepEqual(out[0], []);
  assert.match(out[1][0], /stop 7828\.25 = \$300 \(1R\)/);
  assert.doesNotMatch(out[1].join(), /NO STOP/);
});

test("stop moves are announced once they settle, not while he drags them; breakeven is named", () => {
  const { out } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 20, 7831.25, [stop(7829)]),                  // dragging
    snap(20_000, 20, 7831.25, [stop(7831.25)]),               // still dragging — new pending
    snap(20_000 + STOP_SETTLE_MS, 20, 7831.25, [stop(7831.25)]),
  ]);
  assert.deepEqual(out[1], []); assert.deepEqual(out[2], []);
  assert.match(out[3][0], /stop → 7831\.25 · breakeven/);
});

test("a stop past entry reports what it locks", () => {
  const { out } = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, [stop(7833.25)]), snap(30_000, 20, 7831.25, [stop(7833.25)])]);
  assert.match(out[2][0], /stop → 7833\.25 · locks \$200/);
});

test("the stop disappearing is a warning, once", () => {
  const { out } = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, []), snap(30_000, 20, 7831.25, []), snap(45_000, 20, 7831.25, [])]);
  assert.match(out[2][0], /your stop is gone — 20 MES/);
  assert.deepEqual(out[3], []);
});

test("orders not read this poll keep the last known stop (no false 'stop gone')", () => {
  const { out } = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, null), snap(30_000, 20, 7831.25, null)]);
  assert.deepEqual(out[1], []); assert.deepEqual(out[2], []);
});

test("+1R once with the plan's next step; after he has sold some, no extra line", () => {
  const a = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, null, 7834.75), snap(30_000, 20, 7831.25, null, 7835.5)]);
  assert.match(a.out[1][0], /MES \+1R at 7834\.75 \(\+\$350 open\) · nothing to do yet — the plan sells at \+2R 7838\.25/);
  assert.deepEqual(a.out[2], []);
  const b = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 10, 7831.25, null, 7833, { fills: [{ symbol: "MES", action: "Sell", qty: 10, price: 7833, ms: T0 + 14_000 }] }), snap(30_000, 10, 7831.25, null, 7834.75)]);
  assert.match(b.out[1][0], /sold 10 @ 7833\.00 \(\+0\.5R\) · 10 left · stop 7827\.75/);
  assert.match(b.out[2][0], /\+1R at 7834\.75 \(\+\$175 open\)$/);
});

test("+2R fires once", () => {
  const { out } = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, null, 7838.5), snap(30_000, 20, 7831.25, null, 7839)]);
  assert.equal(out[1].length, 1);
  assert.match(out[1][0], /\+1R at 7838\.50[\s\S]*\+2R at 7838\.50/);
  assert.deepEqual(out[2], []);
});

test("give-back: +1R then back near entry with the stop still under entry — warned once; not if the stop is at breakeven", () => {
  const a = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, null, 7836), snap(30_000, 20, 7831.25, null, 7831.75), snap(45_000, 20, 7831.25, null, 7831.5)]);
  assert.match(a.out[2][0], /was \+1\.4R, now \+0\.1R and the stop is still under entry/);
  assert.deepEqual(a.out[3], []);
  const b = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, [stop(7831.25)], 7836), snap(30_000, 20, 7831.25, [stop(7831.25)], 7836), snap(45_000, 20, 7831.25, [stop(7831.25)], 7831.5)]);
  assert.doesNotMatch(b.out.flat().join("\n"), /was \+/);
});

test("a manual exit inside 10 minutes gets the hands-off note; a stop-out does not", () => {
  const quick = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(45_000, 0, 0, [], undefined, { fills: [{ symbol: "MES", action: "Sell", qty: 20, price: 7830.5, ms: T0 + 44_000 }] })]);
  assert.match(quick.out[1][0], /MES long 20 closed by hand after ~45s @ 7830\.50 · −0\.2R/);
  assert.match(quick.out[1][0], /Out by hand after 45s — your rule is hands off for 10 minutes/);
  const stopped = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(45_000, 0, 0, [], undefined, { fills: [{ symbol: "MES", action: "Sell", qty: 20, price: 7827.5, ms: T0 + 44_000 }] })]);
  assert.match(stopped.out[1][0], /stopped out after ~45s @ 7827\.50 · −1\.1R/);
  assert.doesNotMatch(stopped.out[1][0], /hands off/);
});

test("an exit at his own target is named as such, with no quick-exit note", () => {
  const { out } = run([snap(0, 20, 7831.25, [stop(7827.75), limit(7833.25)]), snap(60_000, 0, 0, [], undefined, { fills: [{ symbol: "MES", action: "Sell", qty: 20, price: 7833.25, ms: T0 + 59_000 }] })]);
  assert.match(out[1][0], /target filled after ~1m 00s @ 7833\.25 · \+0\.6R/);
  assert.doesNotMatch(out[1][0], /Out inside/);
});

test("a +1R trade closed red is named as a give-back on the close line", () => {
  const { out } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, null, 7835),
    snap(600_000, 0, 0, [], undefined, { fills: [{ symbol: "MES", action: "Sell", qty: 20, price: 7830, ms: T0 + 599_000 }] }),
  ]);
  assert.match(out[2][0], /It was \+1\.1R and finished red/);
});

test("adding updates the average and the risk to the stop", () => {
  const { out, state } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 40, 7832.25, [stop(7827.75, "Sell", 40)], undefined, { fills: [{ symbol: "MES", action: "Buy", qty: 20, price: 7833.25, ms: T0 + 14_000 }] }),
  ]);
  assert.match(out[1][0], /added 20 @ 7833\.25 → 40 @ avg 7832\.25 · risk to stop \$900/);
  assert.equal(state.trips.MES!.maxQty, 40);
});

test("a flip closes the long, then cards the short — in that order", () => {
  const { out } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(60_000, -20, 7830, [stop(7833, "Buy")], undefined, { fills: [{ symbol: "MES", action: "Sell", qty: 40, price: 7830, ms: T0 + 59_000 }] }),
  ]);
  const text = out[1][0];
  assert.ok(text.indexOf("🏁") >= 0 && text.indexOf("🏁") < text.indexOf("SHORT 20"));
});

test("gold prints one decimal; its own target shows its R", () => {
  const s: CopilotSnapshot = { nowMs: T0, positions: [{ symbol: "MGC", netPos: 20, netPrice: 4385.3 }], orders: [stop(4383.3, "Sell", 20, "MGC"), { orderId: 3, symbol: "MGC", action: "Sell", kind: "limit", price: 4389.3, qty: 20 }], prices: {}, fills: [] };
  const { messages } = step({ trips: {} }, s);
  assert.match(messages[0], /MGC LONG 20 @ 4385\.3 · stop 4383\.3 = \$400 \(1R\)/);
  assert.match(messages[0], /your target 4389\.3 \(\+2\.0R\)/);
});

test("MES target limit is read; the nearest stop is the protective one", () => {
  assert.deepEqual(protectiveStop([stop(7820), stop(7827.75)], "MES", 1), { px: 7827.75, qty: 40, trailing: false });
  const { out } = run([snap(0, 20, 7831.25, [stop(7827.75), limit(7838.25)])]);
  assert.match(out[0][0], /your target 7838\.25 \(\+2\.0R\)/);
});

test("price from the account's open P&L: exact for one position, refused for two", () => {
  assert.deepEqual(priceFromOpenPnl([{ symbol: "MES", netPos: 20, netPrice: 7831.25 }], 350), { MES: 7834.75 });
  assert.deepEqual(priceFromOpenPnl([{ symbol: "MES", netPos: -20, netPrice: 7840 }], 300), { MES: 7837 });
  assert.deepEqual(priceFromOpenPnl([{ symbol: "MES", netPos: 20, netPrice: 1 }, { symbol: "MNQ", netPos: 20, netPrice: 1 }], 10), {});
  assert.deepEqual(priceFromOpenPnl([{ symbol: "MES", netPos: 20, netPrice: 7831.25 }], null), {});
});

test("a stop he just dragged that then filled is a stop-out, not 'by hand'", () => {
  const { out } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 20, 7831.25, [stop(7830)]),     // dragged, not yet announced
    snap(20_000, 0, 0, [], undefined, { fills: [{ symbol: "MES", action: "Sell", qty: 20, price: 7830, ms: T0 + 19_000 }] }),
  ]);
  assert.match(out[2][0], /stopped out/);
  assert.doesNotMatch(out[2][0], /Out inside/);
});

test("a trailing stop is labelled and its exit is never called 'by hand'", () => {
  const trail: CopilotOrder = { orderId: 9, symbol: "MES", action: "Sell", kind: "stop", price: 7827.75, qty: 20, trailing: true };
  const { out } = run([snap(0, 20, 7831.25, [trail]), snap(40_000, 0, 0, [], undefined, { fills: [{ symbol: "MES", action: "Sell", qty: 20, price: 7833, ms: T0 + 39_000 }] })]);
  assert.match(out[0][0], /trailing stop from 7827\.75 = \$350/);
  assert.match(out[1][0], /closed \(trailing stop or by hand\)/);
  assert.doesNotMatch(out[1][0], /Out inside/);
});

test("after adding, the +1R line shows the real open P&L on the size held", () => {
  const { out } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 40, 7832.25, [stop(7827.75, "Sell", 40)], undefined, { fills: [{ symbol: "MES", action: "Buy", qty: 20, price: 7833.25, ms: T0 + 14_000 }] }),
    snap(30_000, 40, 7832.25, null, 7834.75),
  ]);
  assert.match(out[2][0], /\+1R at 7834\.75 \(\+\$500 open\)/);   // (7834.75 − 7832.25) × $5 × 40
});

test("re-entry inside 3 minutes of the last exit is flagged on the new card; later entries are not", () => {
  const fillsOut = { fills: [{ symbol: "MES" as const, action: "Sell" as const, qty: 20, price: 7833, ms: T0 + 59_000 }] };   // a WIN
  const quick = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(60_000, 0, 0, [], undefined, fillsOut), snap(105_000, 20, 7829, [stop(7826)])]);
  assert.match(quick.out[2][0], /back in 45s after your last exit/);
  const later = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(60_000, 0, 0, [], undefined, fillsOut), snap(60_000 + 181_000, 20, 7829, [stop(7826)])]);
  assert.doesNotMatch(later.out[2][0], /back in/);
});

test("his record for this market and time of day rides on the entry card (3+ trades only)", () => {
  const rec = { MES: { label: "2–5 PM ET", n: 4, netUsd: -485, since: "Sep 21" } };
  const { out } = run([snap(0, 20, 7831.25, [stop(7827.75)], undefined, { records: rec })]);
  assert.match(out[0][0], /your record, MES 2–5 PM ET: 4 trades · −\$485 \(since Sep 21\)/);
  const thin = run([snap(0, 20, 7831.25, [stop(7827.75)], undefined, { records: { MES: { ...rec.MES, n: 2 } } })]);
  assert.doesNotMatch(thin.out[0][0], /your record/);
});

test("fees + slip share of the stop: flagged on tight stops, quiet on wide ones", () => {
  assert.equal(Math.round(costShare("MES", 3.5) * 100), 26);      // ($2.06 + $2.50) / $17.50
  assert.match(run([snap(0, 20, 7831.25, [stop(7827.75)])]).out[0][0], /fees \+ 1-tick slip = 26% of this stop/);
  assert.doesNotMatch(run([snap(0, 20, 7831.25, [stop(7821.25)])]).out[0][0], /fees \+ 1-tick slip/);   // 10 pts: 9%
});

test("time-of-day buckets in ET", () => {
  assert.equal(timeBucket(Date.parse("2026-09-22T14:00:00Z")), "open to 11:30 AM ET");     // 10:00 ET
  assert.equal(timeBucket(Date.parse("2026-09-22T19:30:00Z")), "2–5 PM ET");
  assert.equal(timeBucket(Date.parse("2026-09-23T02:00:00Z")), "overnight (6 PM–8 AM ET)");
});

test("a REJECTED stop is called out at once, naming the naked position — once per order", () => {
  const rej: CopilotOrder = { orderId: 77, symbol: "MNQ", action: "Buy", kind: "stop", price: 31042.75, qty: 20 };
  const pos = (dt: number, orders: CopilotOrder[], extra: Partial<CopilotSnapshot> = {}): CopilotSnapshot => ({ nowMs: T0 + dt, positions: [{ symbol: "MNQ", netPos: -20, netPrice: 31044 }], orders, prices: {}, fills: [], ...extra });
  const { out } = run([pos(0, [], { rejectedStops: [rej] }), pos(15_000, [], { rejectedStops: [rej] })]);
  assert.match(out[0].join("\n"), /REJECTED your stop \(Buy Stop 31042\.75 ×20\)\. You are SHORT 20 MNQ with NO STOP\. A buy stop must sit ABOVE the market/);
  assert.doesNotMatch(out[1].join("\n"), /REJECTED/);
  const covered = run([pos(0, [{ orderId: 78, symbol: "MNQ", action: "Buy", kind: "stop", price: 31050, qty: 20 }], { rejectedStops: [rej] })]);
  assert.match(covered.out[0].join("\n"), /Another stop is working at 31050\.00/);
});

test("duration formatting", () => {
  assert.equal(duration(45_000), "45s");
  assert.equal(duration(190_000), "3m 10s");
  assert.equal(duration(8_040_000), "2h 14m");
});

// ---- the runner plan (Sep 23): ¾ off at +2R, ¼ rides at breakeven, trailing 5R once +5R ----
const sold = (qty: number, price: number, dt: number, action: "Buy" | "Sell" = "Sell") => ({ fills: [{ symbol: "MES" as const, action, qty, price, ms: T0 + dt }] });

test("runnerSplit: a quarter rides from 4 contracts up, none below", () => {
  assert.deepEqual(runnerSplit(20), { sell: 15, runner: 5 });
  assert.deepEqual(runnerSplit(15), { sell: 12, runner: 3 });
  assert.deepEqual(runnerSplit(4), { sell: 3, runner: 1 });
  assert.deepEqual(runnerSplit(3), { sell: 3, runner: 0 });
  assert.deepEqual(runnerSplit(1), { sell: 1, runner: 0 });
});

test("entry card states the plan with his size; under 4 contracts it is all out at +2R", () => {
  const a = run([snap(0, 20, 7831.25, [stop(7827.75)])]);
  assert.match(a.out[0][0], /plan: at \+2R sell 15, stop on the last 5 → breakeven 7831\.25 · runner trails 5R once \+5R/);
  const b = run([snap(0, 3, 7831.25, [stop(7827.75, "Sell", 3)])]);
  assert.match(b.out[0][0], /plan: all out at \+2R/);
});

test("+2R says what to sell and where the runner's stop goes; after a partial sale it sells down to the runner, then keeps it", () => {
  const a = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, null, 7838.25)]);
  assert.match(a.out[1][0], /\+2R at 7838\.25 \(\+\$700 open\) — sell 15 now, move the stop on the last 5 to breakeven 7831\.25/);
  const b = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 10, 7831.25, null, 7838.5, sold(10, 7835, 14_000))]);
  assert.match(b.out[1].join("\n"), /\+2R at 7838\.50 .* — sell 5 now, move the stop on the last 5 to breakeven 7831\.25/);
  const c = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 5, 7831.25, null, 7838.5, sold(15, 7835, 14_000))]);
  assert.match(c.out[1].join("\n"), /\+2R at 7838\.50 .* — keep the runner: stop on what's left → breakeven 7831\.25/);
});

test("runner trail (long): +5R names breakeven, each further 1R names the new stop once, smaller moves stay quiet", () => {
  const { out, state } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 20, 7831.25, null, 7838.25),                              // +2R
    snap(30_000, 5, 7831.25, null, 7838.25, sold(15, 7838.25, 29_000)),   // sells 15
    snap(45_000, 5, 7831.25, null, 7848.75),                              // +5R
    snap(60_000, 5, 7831.25, null, 7852.25),                              // +6R → locks 1R
    snap(75_000, 5, 7831.25, null, 7853),                                 // +6.2R → quiet
    snap(90_000, 5, 7831.25, null, 7845),                                 // pullback → quiet
  ]);
  assert.match(out[3].join("\n"), /🚀 MES \+5\.0R — runner stop → 7831\.25 \(breakeven\); from here it trails 5R behind the best price/);
  assert.match(out[4].join("\n"), /🚀 MES runner stop → 7834\.75 \(locks \+1\.0R\) · best so far \+6\.0R/);
  assert.deepEqual(out[5], []); assert.deepEqual(out[6], []);
  assert.equal(state.trips.MES!.trailPx, 7834.75);
});

test("runner trail (short) mirrors", () => {
  const { out } = run([
    snap(0, -20, 7840, [stop(7843, "Buy")]),
    snap(15_000, -20, 7840, null, 7834),                                   // +2R
    snap(30_000, -5, 7840, null, 7834, sold(15, 7834, 29_000, "Buy")),
    snap(45_000, -5, 7840, null, 7825),                                    // +5R
    snap(60_000, -5, 7840, null, 7822),                                    // +6R
  ]);
  assert.match(out[3].join("\n"), /runner stop → 7840\.00 \(breakeven\)/);
  assert.match(out[4].join("\n"), /runner stop → 7837\.00 \(locks \+1\.0R\)/);
});

test("a jump straight past +5R in one poll still gives +1R, +2R and the runner stop, in that order", () => {
  const { out } = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, null, 7852.25)]);
  const m = out[1].join("\n");
  assert.ok(m.indexOf("+1R at") < m.indexOf("+2R at") && m.indexOf("+2R at") < m.indexOf("runner stop → 7834.75"));
});

test("runner closed by hand above the plan's stop is named; closed at the plan's stop is not", () => {
  const path = (exitPx: number) => run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 20, 7831.25, null, 7838.25),
    snap(30_000, 5, 7831.25, null, 7838.25, sold(15, 7838.25, 29_000)),
    snap(45_000, 5, 7831.25, null, 7852.25),                               // trail 7834.75
    snap(300_000, 0, 0, [], undefined, sold(5, exitPx, 299_000)),
  ]);
  assert.match(path(7850).out[4][0], /The runner went out by hand — the plan's stop was 7834\.75/);
  assert.doesNotMatch(path(7834.75).out[4][0], /went out by hand/);
});

test("state saved before the runner plan (no hit5R / trailPx fields) still steps", () => {
  const first = run([snap(0, 20, 7831.25, [stop(7827.75)])]);
  const t = { ...first.state.trips.MES! } as Record<string, unknown>; delete t.hit5R; delete t.trailPx;
  const { out } = run([snap(15_000, 20, 7831.25, null, 7852.25)], { trips: { MES: t as never } });
  assert.match(out[0].join("\n"), /runner stop → 7834\.75/);
});

// ---- review fixes ----
test("under 4 contracts there is no runner: closing by hand after +2R is not called a runner", () => {
  const { out } = run([
    snap(0, 3, 7831.25, [stop(7827.75, "Sell", 3)]),
    snap(15_000, 3, 7831.25, null, 7838.5),
    snap(30_000, 1, 7831.25, null, 7838.5, sold(2, 7838.5, 29_000)),
    snap(45_000, 0, 0, [], undefined, sold(1, 7839, 44_000)),
  ]);
  assert.match(out[1].join("\n"), /the plan: all out here/);
  assert.doesNotMatch(out[3].join("\n"), /runner/);
});

test("no fill read (stale last price) never calls the runner's exit 'by hand' against the plan", () => {
  const { out } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 20, 7831.25, null, 7838.25),
    snap(30_000, 5, 7831.25, null, 7840, sold(15, 7838.25, 29_000)),
    snap(45_000, 0, 0, [], undefined),                                    // closed; fills could not be read
  ]);
  assert.doesNotMatch(out[3].join("\n"), /went out by hand/);
});

test("sold a few early: +2R says how many more to sell down to the runner; closing 18 is not 'the runner'", () => {
  const { out } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 18, 7831.25, null, 7832, sold(2, 7832, 14_000)),
    snap(30_000, 18, 7831.25, null, 7838.25),
    snap(45_000, 0, 0, [], undefined, sold(18, 7840, 44_000)),
  ]);
  assert.match(out[2].join("\n"), /sell 13 now, move the stop on the last 5 to breakeven 7831\.25/);
  assert.doesNotMatch(out[3].join("\n"), /went out by hand/);
});

test("after an add, breakeven and the runner stop use his real average", () => {
  const { out } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 40, 7833.625, null, 7836, sold(20, 7836, 14_000, "Buy")),
    snap(30_000, 40, 7833.625, null, 7838.25),                            // +2R from the first entry
    snap(45_000, 10, 7833.625, null, 7848.75, sold(30, 7838.25, 44_000)), // +5R
  ]);
  assert.match(out[2].join("\n"), /sell 30 now, move the stop on the last 10 to breakeven 7833\.75/);
  assert.match(out[3].join("\n"), /runner stop → 7833\.50 \(breakeven\)|runner stop → 7833\.75 \(breakeven\)/);
});

test("one poll straight to +2R: no contradictory 'nothing to do yet' line", () => {
  const { out } = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, null, 7838.5)]);
  assert.doesNotMatch(out[1].join("\n"), /nothing to do yet/);
});

test("breakevenPx: a tradeable price on the safe side", () => {
  assert.equal(breakevenPx("MES", 1, 7833.625), 7833.75);
  assert.equal(breakevenPx("MES", -1, 7833.625), 7833.5);
  assert.equal(breakevenPx("MES", 1, 7831.25), 7831.25);
  assert.equal(breakevenPx("MGC", 1, 4385.33), 4385.4);
});

// ---- his day rules ----
const exitAt = (px: number, dt: number, qty = 20, symbol: "MES" | "MNQ" | "MGC" = "MES") => ({ fills: [{ symbol, action: "Sell" as const, qty, price: px, ms: T0 + dt }] });

test("trade counter on every card; the 6th trade of the day is flagged", () => {
  let st: CopilotState = { trips: {} }; const cards: string[] = [];
  for (let i = 0; i < 6; i++) {
    const t0 = i * 1_200_000;                                        // 20 min apart, all winners (no cooldown, no loss stop)
    const r1 = step(st, snap(t0, 20, 7831.25, [stop(7827.75)])); st = r1.state; cards.push(r1.messages.join("\n"));
    const r2 = step(st, snap(t0 + 700_000, 0, 0, [], undefined, exitAt(7833, t0 + 699_000))); st = r2.state;
  }
  assert.match(cards[0], /Trade 1 of 5 today/);
  assert.match(cards[4], /Trade 5 of 5 today/);
  assert.match(cards[5], /⛔ Trade 6 today — your limit is 5/);
  assert.equal(st.day!.trades, 6); assert.equal(st.day!.losses, 0);
});

test("second loss of the day says done once; the next entry is flagged; a new trading day resets", () => {
  const { out, state } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(700_000, 0, 0, [], undefined, exitAt(7828, 699_000)),                 // loss 1
    snap(1_500_000, 20, 7831.25, [stop(7827.75)]),
    snap(2_200_000, 0, 0, [], undefined, exitAt(7828, 2_199_000)),             // loss 2
    snap(3_000_000, 20, 7831.25, [stop(7827.75)]),
    snap(3_700_000, 0, 0, [], undefined, exitAt(7833, 3_699_000)),            // closed before the session ends
  ]);
  assert.doesNotMatch(out[1].join("\n"), /done for the day/);
  assert.match(out[3].join("\n"), /🛑 That's 2 losses today \(day ≈ −\$[\d,]+\)\. Your rule: done for the day/);
  assert.match(out[4].join("\n"), /⛔ You already have 2 losses today/);
  // 18:00 ET the next session: a fresh day
  const next = step(state, snap(Date.parse("2026-09-23T22:05:00Z") - T0, 20, 7831.25, [stop(7827.75)]));
  assert.match(next.messages.join("\n"), /Trade 1 of 5 today/);
  assert.doesNotMatch(next.messages.join("\n"), /losses today/);
});

test("back in within 10 minutes after a LOSS is flagged; after a win it is not; after 10 min it is not", () => {
  const afterLoss = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(700_000, 0, 0, [], undefined, exitAt(7829, 699_000)), snap(700_000 + 240_000, 20, 7830, [stop(7826.5)])]);
  assert.match(afterLoss.out[2][0], /⛔ Back in 4m 00s after a LOSS — your rule is 10 minutes/);
  assert.doesNotMatch(afterLoss.out[2][0], /after your last exit/);
  const afterWin = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(700_000, 0, 0, [], undefined, exitAt(7834, 699_000)), snap(700_000 + 240_000, 20, 7830, [stop(7826.5)])]);
  assert.doesNotMatch(afterWin.out[2][0], /after a LOSS/);
  const waited = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(700_000, 0, 0, [], undefined, exitAt(7829, 699_000)), snap(700_000 + 601_000, 20, 7830, [stop(7826.5)])]);
  assert.doesNotMatch(waited.out[2][0], /after a LOSS/);
});

test("MNQ / MGC entries carry the MES-only note; MES does not", () => {
  const mnq: CopilotSnapshot = { nowMs: T0, positions: [{ symbol: "MNQ", netPos: 10, netPrice: 30700 }], orders: [stop(30690, "Sell", 10, "MNQ")], prices: {}, fills: [] };
  assert.match(step({ trips: {} }, mnq).messages[0], /📌 Not MES — your plan is MES only for now/);
  assert.doesNotMatch(run([snap(0, 20, 7831.25, [stop(7827.75)])]).out[0][0], /Not MES/);
});

test("a partial sale counts toward the trade's result: +2R on 15 then the runner stopped at breakeven is a WIN", () => {
  const { state } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 20, 7831.25, null, 7838.25),
    snap(30_000, 5, 7831.25, null, 7838.25, sold(15, 7838.25, 29_000)),
    snap(700_000, 0, 0, [], undefined, exitAt(7831.25, 699_000, 5)),
  ]);
  assert.equal(state.day!.losses, 0);
  assert.equal(Math.round(state.day!.netUsd), Math.round(15 * 7 * 5 - 2.06 * 20));   // 15 × 7 pts × $5 − fees
  assert.equal(state.lastCloseLoss, false);
});

// ---- review round 2 ----
test("no exit fills: the trade is not classified (a stale price can't hide a stop-out or fake a loss)", () => {
  const { out, state } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 20, 7831.25, null, 7833),
    snap(30_000, 0, 0, [], undefined),                                          // stopped, fills unreadable
  ]);
  assert.equal(state.day!.losses, 0); assert.equal(state.day!.netUsd, 0); assert.equal(state.lastCloseLoss, false);
  assert.match(out[2].join("\n"), /isn't counted in today's losses/);
});

test("breakeven scratches are not losses: two of them don't trigger 'done for the day'", () => {
  const { out, state } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(700_000, 0, 0, [], undefined, exitAt(7831.25, 699_000)),
    snap(1_500_000, 20, 7831.25, [stop(7827.75)]),
    snap(2_200_000, 0, 0, [], undefined, exitAt(7831.25, 2_199_000)),
  ]);
  assert.equal(state.day!.losses, 0);
  assert.doesNotMatch(out.flat().join("\n"), /done for the day/);
});

test("'finished red' judges the whole trade: ¾ banked at +2R, runner stopped a tick under breakeven is not a give-back", () => {
  const { out } = run([
    snap(0, 20, 7831.25, [stop(7827.75)]),
    snap(15_000, 20, 7831.25, null, 7838.25),
    snap(30_000, 5, 7831.25, null, 7838.25, sold(15, 7838.25, 29_000)),
    snap(700_000, 0, 0, [], undefined, exitAt(7831, 699_000, 5)),
  ]);
  assert.doesNotMatch(out[3].join("\n"), /finished red/);
});
