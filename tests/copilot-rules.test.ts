import assert from "node:assert/strict";
import test from "node:test";
import { ENTRY_STOP_GRACE_MS, STOP_SETTLE_MS, duration, priceFromOpenPnl, protectiveStop, step, type CopilotOrder, type CopilotSnapshot, type CopilotState } from "../src/lib/copilot-rules";

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

test("+1R once with his template; after he has sold some, no 'sell half' line", () => {
  const a = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(15_000, 20, 7831.25, null, 7834.75), snap(30_000, 20, 7831.25, null, 7835.5)]);
  assert.match(a.out[1][0], /MES \+1R at 7834\.75 \(\+\$350 open\) · your winners: sell half here, stop to breakeven/);
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

test("quick manual exit gets the 2-minute note; a stop-out does not", () => {
  const quick = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(45_000, 0, 0, [], undefined, { fills: [{ symbol: "MES", action: "Sell", qty: 20, price: 7830.5, ms: T0 + 44_000 }] })]);
  assert.match(quick.out[1][0], /MES long 20 closed by hand after ~45s @ 7830\.50 · −0\.2R/);
  assert.match(quick.out[1][0], /Out inside 2 minutes/);
  const stopped = run([snap(0, 20, 7831.25, [stop(7827.75)]), snap(45_000, 0, 0, [], undefined, { fills: [{ symbol: "MES", action: "Sell", qty: 20, price: 7827.5, ms: T0 + 44_000 }] })]);
  assert.match(stopped.out[1][0], /stopped out after ~45s @ 7827\.50 · −1\.1R/);
  assert.doesNotMatch(stopped.out[1][0], /Out inside/);
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

test("duration formatting", () => {
  assert.equal(duration(45_000), "45s");
  assert.equal(duration(190_000), "3m 10s");
  assert.equal(duration(8_040_000), "2h 14m");
});
