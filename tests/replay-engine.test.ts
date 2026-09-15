import assert from "node:assert/strict";
import test from "node:test";
import { aggregate, between, parseBarsCsv, to1d, to4h } from "../scripts/lib/bars";
import { RISK$, TAKER, blockBootstrap, mcPath, monteCarlo, nonOverlapping, replayLegFees, seededRandom, simulate, simulatePartial, simulatePyramid, tOf, welch, type Entry } from "../scripts/lib/replay-engine";
import { partialTradePnl } from "../src/lib/margin-shadow-legs";
import { exitParams, type ExitProfile } from "../src/lib/margin-shadow";
import { isFourHourClose } from "../src/lib/margin-live-risk";
import type { KrakenBar } from "../src/lib/kraken-margin";

// C6 — the research engine. aggregate() must put 4h bars on the boundaries the live desk calls
// 4h closes; simulate() is paper's exit on a hand-built series; the partial's fee split is the
// legs module's; the bootstrap is reproducible.

const H = 3600;
const hour = (t: number, o: number, h: number, l: number, c: number, v = 1): KrakenBar => ({ t, o, h, l, c, v });

test("aggregate: 4h buckets open on UTC 00/04/08/12/16/20 — the same bars isFourHourClose closes — and 1d on midnight", () => {
  const T0 = Date.parse("2026-09-14T22:00:00Z") / 1000;   // starts mid-bucket (20:00–24:00)
  const bars: KrakenBar[] = [];
  for (let i = 0; i < 29; i++) bars.push(hour(T0 + i * H, 100 + i, 101 + i, 99 + i, 100.5 + i, 10));
  const h4 = to4h(bars);
  // The 20:00 bucket the input joined mid-way (22:00, 23:00) is dropped; then 00:00, 04:00, … ; the last bucket is partial → dropped.
  assert.equal(new Date(h4[0].t * 1000).toISOString(), "2026-09-15T00:00:00.000Z");
  assert.equal(new Date(aggregate(bars, 14400, false)[0].t * 1000).toISOString(), "2026-09-14T20:00:00.000Z", "completeOnly=false keeps the partial first bucket");
  for (const b of h4) { assert.equal(b.t % 14400, 0); assert.ok(isFourHourClose(b.t + 14400 - 60), "the bucket's last minute is a 4h close"); }
  const full = h4.find((b) => new Date(b.t * 1000).toISOString() === "2026-09-15T00:00:00.000Z")!;
  assert.deepEqual({ o: full.o, h: full.h, l: full.l, c: full.c, v: full.v }, { o: 102, h: 106, l: 101, c: 105.5, v: 40 }, "open = first hour's open, close = last hour's close, extremes, summed volume");
  // 29 hours from 22:00 → the last input hour opens 2026-09-16T02:00; the 00:00–04:00 bucket has 3 of 4 hours and is dropped.
  assert.equal(new Date(h4[h4.length - 1].t * 1000).toISOString(), "2026-09-15T20:00:00.000Z");
  assert.equal(aggregate(bars, 14400, false).length, h4.length + 2, "completeOnly=false keeps both partial buckets");
  const d = to1d(bars);
  assert.equal(d.length, 1, "only Sep 15 is a complete day");
  assert.equal(new Date(d[0].t * 1000).toISOString(), "2026-09-15T00:00:00.000Z");
  assert.equal(d[0].v, 240);
  assert.equal(between(bars, "2026-09-15", "2026-09-16").length, 24);
});

test("parseBarsCsv: ms or s timestamps, header skipped, sorted, de-duplicated", () => {
  const bars = parseBarsCsv("t,o,h,l,c,v\n1704070800000,2,3,1,2.5,9\n1704067200000,1,2,0.5,1.5,8\n1704067200000,1,2,0.5,1.5,8\nbad,x,y,z\n");
  assert.deepEqual(bars.map((b) => b.t), [1704067200, 1704070800]);
  assert.equal(bars[0].c, 1.5);
});

// A hand-built 4h series: entry bar, then a run to +2.5R, then a fall through the 2R trail.
function series(): KrakenBar[] {
  const T0 = 1_757_000_000 - (1_757_000_000 % 14400);
  const b = (i: number, o: number, h: number, l: number, c: number): KrakenBar => ({ t: T0 + i * 14400, o, h, l, c, v: 1 });
  return [
    b(0, 100, 100, 100, 100),        // entry bar: close 100 → entry 100.1 (chase), oneR 4.004 at 4%
    b(1, 100, 103, 99, 102),         // +0.47R peak, no ratchet
    b(2, 102, 105, 101, 104.5),      // peak 105 = +1.22R → stop to breakeven (100.1); close 104.5 = +1.10R → add fires here
    b(3, 104.5, 110.2, 104, 110),    // peak 110.2 = +2.52R → 2R trail = 102.19
    b(4, 110, 111, 101, 101.5),      // low 101 ≤ 102.19 → trailing stop hit at 102.19
    b(5, 101.5, 102, 100, 101),
  ];
}

test("simulate on a hand-built series: paper's 2R trail exits at the trail level; the 1R control earlier", () => {
  const bars = series();
  const wide = exitParams("swing-wide", 5, 1), control = exitParams("swing-lev", 5, 1);
  const w = simulate("ETH", bars, 0, 4, wide, TAKER);
  const entry = 100 * 1.001, oneR = entry * 0.04;
  const trailStop = 110.2 - 2 * oneR;
  const notional = RISK$ / 0.04;
  const heldH = 16;   // bars 1..4 → closedAt = bar 4 open time = 4 bars later
  const gross = (notional * (trailStop - entry)) / entry;
  const fees = notional * (TAKER + TAKER) + notional * 0.0002 * (heldH / 4);
  assert.equal(w.reason, "trail");
  assert.equal(w.exitBar, 4);
  assert.ok(Math.abs(w.pnl - (gross - fees)) < 1e-6, `wide pnl ${w.pnl} vs ${gross - fees}`);
  assert.ok(Math.abs(w.r - w.pnl / RISK$) < 1e-12);
  // The 1R control trails 1R behind 110.2 = 106.196 → the same bar stops it, at a better price.
  const c = simulate("ETH", bars, 0, 4, control, TAKER);
  assert.equal(c.reason, "trail");
  assert.ok(c.pnl > w.pnl, "the 1R trail keeps more on a reversal — exactly the give-back trade-off");
  // Time stop: a profile with a 4h hold exits at bar 1's close.
  const short: ExitProfile = { maxHoldH: 4, oneR: 0.04, carry: true };
  const s = simulate("ETH", bars, 0, 4, short, TAKER);
  assert.equal(s.reason, "time stop"); assert.equal(s.exitBar, 1);
  // Initial stop: a series that falls through 4%.
  const falling = [bars[0], { ...bars[1], l: 95, c: 96 }];
  assert.equal(simulate("ETH", falling, 0, 4, wide, TAKER).reason, "initial stop");
});

test("simulatePyramid: the add fires on the close ≥ +1R, risk-sized to the resting stop, and never on a 1.25R rule that is not reached", () => {
  const bars = series();
  const wide = exitParams("swing-wide", 5, 1);
  const p = simulatePyramid("ETH", bars, 0, 4, wide, TAKER, true, 1);
  assert.equal(p.added, true);
  assert.equal(p.reason, "trail");
  const base = simulate("ETH", bars, 0, 4, wide, TAKER);
  // The add: bar 2 closes 104.5 (+1.10R) → chased to 104.6045; the stop resting then is breakeven
  // (100.1) → risk-sized notional = RISK$ × price ÷ (price − stop), capped at a full unit. It exits
  // with the first unit at the 2R trail (102.19) — BELOW its own entry: on this shape the add loses,
  // which is exactly the replay's honest worst case (−$499 vs −$403 on the Sep 12 run).
  const entry = 100 * 1.001, oneR = entry * 0.04, notional = RISK$ / 0.04;
  const addPx = 104.5 * 1.001, addStop = entry;
  const n2 = Math.min(notional, (RISK$ * addPx) / (addPx - addStop));
  const trailStop = 110.2 - 2 * oneR;
  const addHeldH = (bars[4].t - bars[2].t) / 3600;
  const addPnl = (n2 * (trailStop - addPx)) / addPx - n2 * (TAKER + TAKER) - n2 * 0.0002 * (addHeldH / 4);
  assert.ok(Math.abs(p.pnl - (base.pnl + addPnl)) < 1e-6, `pyramid = base + the add's own P&L (${p.pnl} vs ${base.pnl + addPnl})`);
  assert.ok(p.pnl < base.pnl, "on this shape the add is under water at the trail exit");
  // A same-notional add (the rejected variant) loses more on the same shape.
  const same = simulatePyramid("ETH", bars, 0, 4, wide, TAKER, false, 1);
  assert.ok(same.pnl < p.pnl);
  // addAtR 1.25: bar 2's close is +1.10R → not yet; bar 3's close +2.47R → fires at bar 3.
  const late = simulatePyramid("ETH", bars, 0, 4, wide, TAKER, true, 1.25);
  assert.equal(late.added, true);
  assert.ok(late.pnl < p.pnl, "a later add at a higher price earns less on the same exit");
  const never = simulatePyramid("ETH", bars, 0, 4, wide, TAKER, true, 5);
  assert.equal(never.added, false);
  assert.ok(Math.abs(never.pnl - base.pnl) < 1e-9, "no add → identical to simulate()");
});

test("simulatePartial's fee split equals margin-shadow-legs on the same legs, with the replay's linear rollover", () => {
  const bars = series();
  const prof = exitParams("swing-partial", 5, 1);   // 2R trail, 30% at +2R
  const r = simulatePartial("ETH", bars, 0, 4, prof, TAKER);
  assert.equal(r.banked, true, "bar 3's high 110.2 reached +2R (108.1)");
  const entry = 100 * 1.001, oneR = entry * 0.04, notional = RISK$ / 0.04;
  const level = entry + 2 * oneR;
  const trailStop = 110.2 - 2 * oneR;
  const expected = partialTradePnl({
    dir: 1, entry, exit: trailStop, notional,
    partial: { px: Math.max(level, 104.5), t: bars[3].t, notional: notional * 0.3 },
    tOpen: bars[0].t, tExit: bars[4].t, carry: true, fees: replayLegFees("ETH", TAKER),
  });
  assert.ok(Math.abs(r.pnl - expected.pnl) < 1e-9, `${r.pnl} vs ${expected.pnl}`);
  assert.deepEqual(replayLegFees("ETH", TAKER).periods!(10), 2.5, "linear rollover: 10h = 2.5 periods");
  // Without a partial in the profile it is simulate().
  const plain = simulatePartial("ETH", bars, 0, 4, exitParams("swing-wide", 5, 1), TAKER);
  assert.equal(plain.banked, false);
  assert.ok(Math.abs(plain.pnl - simulate("ETH", bars, 0, 4, exitParams("swing-wide", 5, 1), TAKER).pnl) < 1e-12);
});

test("nonOverlapping keeps one open trade per coin, decided by the control profile", () => {
  const bars = series();
  const e = (i: number, coin = "ETH"): Entry => ({ coin, tf: "4h", i, month: "26-09" });
  const list = [{ e: e(0), bars }, { e: e(1), bars }, { e: e(3), bars }, { e: e(0, "SOL"), bars }];
  const kept = nonOverlapping(list, 4, exitParams("swing-lev", 5, 1));
  // ETH's first trade exits at bar 4 → entries at 1 and 3 are inside it; SOL's own first trade is independent.
  assert.deepEqual(kept.map((k) => `${k.e.coin}:${k.e.i}`), ["ETH:0", "SOL:0"]);
});

test("tOf and welch: the numbers behind every line", () => {
  const s = tOf([1, 2, 3, 4]);
  assert.equal(s.n, 4); assert.equal(s.mean, 2.5); assert.ok(Math.abs(s.sd - 1.2909944) < 1e-6); assert.ok(Math.abs(s.t - 3.8729833) < 1e-6);
  assert.deepEqual(tOf([]), { n: 0, mean: 0, sd: 0, t: 0, ci: [0, 0] });
  const w = welch([1, 2, 3, 4], [2, 3, 4, 5]);
  assert.equal(w.diff, -1); assert.ok(Math.abs(w.t + 1.0954451) < 1e-6);
  assert.equal(welch([1, 1], [1, 1]).t, 0, "degenerate → 0, never NaN");
});

test("seeded bootstrap is deterministic: same seed → same paths; a different seed → different", () => {
  const sample = [1, -1, 0.5, -1, 2, -0.5, 3, -1, -1, 0.2];
  const a = blockBootstrap(sample, 25, 5, seededRandom(7));
  const b = blockBootstrap(sample, 25, 5, seededRandom(7));
  assert.deepEqual(a, b);
  assert.equal(a.length, 25);
  assert.notDeepEqual(a, blockBootstrap(sample, 25, 5, seededRandom(8)));
  // Blocks are consecutive runs of the sample (circular).
  for (let k = 0; k + 4 < 25; k += 5) { const start = sample.indexOf(a[k]); assert.ok(start >= 0); for (let j = 0; j < 5; j++) assert.equal(a[k + j], sample[(start + j) % sample.length]); }
  assert.deepEqual(blockBootstrap([], 10, 5, seededRandom(1)), []);
  const mc1 = monteCarlo(sample, { paths: 200, trades: 30, seed: 3 });
  const mc2 = monteCarlo(sample, { paths: 200, trades: 30, seed: 3 });
  assert.deepEqual(mc1, mc2);
  assert.deepEqual(mc1.map((m) => m.riskPct), [3, 5, 8]);
  for (const m of mc1) { assert.ok(m.pBreaker >= 0 && m.pBreaker <= 1); assert.ok(m.p95DD >= m.medianDD); }
});

test("mcPath: the breaker halts at a 15% drawdown from the running peak; streaks count non-positive R", () => {
  const p = mcPath([1, 1, -1, -1, -1, 1], 5000, 0.08);
  // +8%, +8% → peak 5832; −8% → 5365 (dd 8%); −8% → 4936 (dd 15.4%) → the breaker halts the path
  // after the SECOND loss; the third is never taken.
  assert.equal(p.breaker, true);
  assert.equal(p.streak, 2);
  assert.ok(p.maxDD > 0.15 && p.maxDD < 0.16);
  assert.ok(Math.abs(p.final - (1.08 * 1.08 * 0.92 * 0.92 - 1)) < 1e-12);
  const calm = mcPath([0.5, -0.5, 0.5, -0.5], 5000, 0.03);
  assert.equal(calm.breaker, false);
  assert.ok(Math.abs(calm.final - ((1.015 * 0.985) ** 2 - 1)) < 1e-12);
});
