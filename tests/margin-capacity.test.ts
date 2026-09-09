import assert from "node:assert/strict";
import test from "node:test";
import { classifyRefusal, replaySlots, setupMarginUsd, type CapacitySetup } from "../src/lib/margin-capacity";

// The cost-of-capacity replay must reproduce the executor's admission rules exactly: a free
// slot (a taken trade occupies one until its paper resolution), the cooldown since the last
// taken entry, and the UTC day's cap. Anything looser would overstate what more slots earn.

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 6, h, m)).toISOString();
const setup = (id: number, time: string, o: Partial<CapacitySetup> = {}): CapacitySetup => ({
  id, time, symbol: `C${id}/USD`, timeframe: "5m", kind: "other", note: null,
  status: "resolved", pnl: 100, unrealized: null, resolvedAt: at(23), ...o,
});

test("classifyRefusal reads the executor's own refusal notes", () => {
  assert.equal(classifyRefusal("OD33LV-DUZF7-FIAFOR", null), "taken");
  assert.equal(classifyRefusal(null, "entry refused: 2 positions+resting orders already (max 2)"), "slots");
  assert.equal(classifyRefusal(null, "entry refused: cooldown (30/30 min since last entry)"), "cooldown");
  assert.equal(classifyRefusal(null, "entry refused: 3/3 trades already today"), "daily cap");
  assert.equal(classifyRefusal(null, "entry refused: SUI/USD is not in kraken_margin_symbols (BTC)"), "other");
  assert.equal(classifyRefusal(null, null), "other");
});

test("a taken trade occupies its slot until its paper resolution", () => {
  const s = [
    setup(1, at(1), { resolvedAt: at(10), pnl: 200 }),
    setup(2, at(2), { resolvedAt: at(12), pnl: -300 }),   // slot full (1 slot) → skipped
    setup(3, at(11), { resolvedAt: at(20), pnl: 50 }),    // slot freed at 10:00 → taken
  ];
  const one = replaySlots(s, { slots: 1, perDay: 10, cooldownMin: 0 });
  assert.deepEqual({ taken: one.taken, net: one.net }, { taken: 2, net: 250 });
  const two = replaySlots(s, { slots: 2, perDay: 10, cooldownMin: 0 });
  assert.deepEqual({ taken: two.taken, net: two.net }, { taken: 3, net: -50 });
});

test("the cooldown is measured from the last TAKEN entry, not from every setup", () => {
  const s = [setup(1, at(1, 0)), setup(2, at(1, 20)), setup(3, at(1, 40))];
  const r = replaySlots(s, { slots: 9, perDay: 10, cooldownMin: 30 });
  // 01:00 taken · 01:20 inside cooldown → skipped · 01:40 is 40 min after the last TAKEN → taken
  assert.equal(r.taken, 2);
});

test("the per-day cap counts UTC days", () => {
  const s = [setup(1, at(1)), setup(2, at(2)), setup(3, at(3)), setup(4, new Date(Date.UTC(2026, 8, 7, 0, 30)).toISOString())];
  const r = replaySlots(s, { slots: 9, perDay: 2, cooldownMin: 0 });
  assert.equal(r.taken, 3, "two on Sep 6, the cap resets on Sep 7");
});

test("open setups hold their slot and report as floating; slots 0 = every setup", () => {
  const s = [
    setup(1, at(1), { status: "open", pnl: null, unrealized: -40, resolvedAt: null }),
    setup(2, at(2), { pnl: 120 }),
  ];
  const one = replaySlots(s, { slots: 1, perDay: 10, cooldownMin: 0 });
  assert.deepEqual({ taken: one.taken, open: one.open, floating: one.floating, resolved: one.resolved }, { taken: 1, open: 1, floating: -40, resolved: 0 });
  const all = replaySlots(s, { slots: 0, perDay: Number.POSITIVE_INFINITY, cooldownMin: 0 });
  assert.deepEqual({ taken: all.taken, net: all.net, floating: all.floating }, { taken: 2, net: 120, floating: -40 });
});

test("order of arrival decides who gets the slot, whatever order the rows come in", () => {
  const s = [setup(2, at(2), { pnl: 999 }), setup(1, at(1), { pnl: 1 })];
  const r = replaySlots(s, { slots: 1, perDay: 10, cooldownMin: 0 });
  assert.deepEqual({ taken: r.taken, net: r.net }, { taken: 1, net: 1 });
});

// ── 2026-09-09: a slot is not a slot — margin is per coin ───────────────────────────────
const MARGIN = { equity: 4636, riskFrac: 0.05, stopFrac: 0.04, floorPct: 150 };

test("classifyRefusal reads the two refusals the margin floor and leverage clamp added", () => {
  assert.equal(classifyRefusal(null, "entry refused: would leave margin level at 111% (floor 150%, Kraken calls at 80%)"), "margin");
  assert.equal(classifyRefusal(null, "entry refused: tsmom's 8% stop does not survive the leverage clamp even at 4×"), "leverage");
  // Still classified before, so the ledger does not silently reshuffle old rows.
  assert.equal(classifyRefusal(null, "entry refused: 2 positions+resting orders already (max 2)"), "slots");
  assert.equal(classifyRefusal("OD33LV-DUZF7-FIAFOR", null), "taken");
});

test("the same risk costs very different margin depending on the coin's venue leverage", () => {
  const btc = setupMarginUsd("BTC/USD", MARGIN);      // 20× venue, capped to 9× by the 4% stop
  const eth = setupMarginUsd("ETH/USD", MARGIN);      // 10× venue, also 9×
  const pepe = setupMarginUsd("PEPE/USD", MARGIN);    // 5× venue
  const pengu = setupMarginUsd("PENGU/USD", MARGIN);  // 3× — the dearest venue left after the probe
  assert.equal(btc.leverage, 9, "a 4% stop caps BTC at 9×, not 20×");
  assert.equal(eth.leverage, 9);
  assert.equal(pepe.leverage, 5);
  assert.equal(pengu.leverage, 3);
  // XLM was 2× until the 2026-09-09 probe proved the venue accepts 5×. It is now as cheap
  // to hold as any other mid-cap — which is the entire payoff of having verified it.
  assert.equal(setupMarginUsd("XLM/USD", MARGIN).leverage, 5);
  assert.ok(btc.margin < pepe.margin && pepe.margin < pengu.margin, "cheaper leverage, dearer slot");
  // The ratio is the point: the dearest venue still eats ~3× the margin of a major.
  assert.ok(pengu.margin / eth.margin > 2.5, `PENGU costs ${(pengu.margin / eth.margin).toFixed(1)}× an ETH slot`);
});

test("the margin floor refuses entries a slot count would have waved through", () => {
  // Three cheap majors at once: fine, that is what three slots are for.
  const majors = [setup(1, at(1), { symbol: "ETH/USD" }), setup(2, at(2), { symbol: "SOL/USD" }), setup(3, at(3), { symbol: "BTC/USD" })];
  assert.equal(replaySlots(majors, { slots: 3, perDay: 10, cooldownMin: 0, margin: MARGIN }).taken, 3);
  // Three of the dearest coin: slot-counting takes all three, the margin model does not.
  const dear = [setup(1, at(1), { symbol: "XLM/USD" }), setup(2, at(2), { symbol: "ALGO/USD" }), setup(3, at(3), { symbol: "XLM/USD" })];
  const bySlots = replaySlots(dear, { slots: 3, perDay: 10, cooldownMin: 0 });
  const byMargin = replaySlots(dear, { slots: 3, perDay: 10, cooldownMin: 0, margin: MARGIN });
  assert.equal(bySlots.taken, 3, "counting slots says the desk had room");
  assert.ok(byMargin.taken < bySlots.taken, `margin model took ${byMargin.taken}, slot model ${bySlots.taken}`);
  assert.ok(byMargin.refusedByMargin > 0, "and it says WHY, rather than silently agreeing");
  // Omitting the margin config must leave the old behaviour untouched.
  assert.equal(replaySlots(dear, { slots: 3, perDay: 10, cooldownMin: 0 }).refusedByMargin, 0);
});
