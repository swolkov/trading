import assert from "node:assert/strict";
import test from "node:test";
import { PENDING_TTL_H, RESOLVE_MAX_SYMBOLS, RETEST_BAND, retestTriggered } from "../src/lib/margin-pending";
import { autoShadowPlans } from "../src/lib/margin-auto-plans";
import { evaluate, type TfSpec } from "../src/lib/margin-scanner";
import type { KrakenBar } from "../src/lib/kraken-margin";

// C5b — swing-retest: the conditional entry. The rule is pure (retestTriggered); the resolver
// around it is I/O and is exercised by the deploy check in the operating-model doc.

const bar = (t: number, o: number, h: number, l: number, c: number): KrakenBar => ({ t, o, h, l, c, v: 1 });

test("registered constants: 0.5% band, 24h expiry, ≤10 symbols per tick", () => {
  assert.equal(RETEST_BAND, 0.005);
  assert.equal(PENDING_TTL_H, 24);
  assert.equal(RESOLVE_MAX_SYMBOLS, 10);
});

test("a long fills on the first completed bar that touches the level (+0.5%) and closes above it", () => {
  const level = 100;
  const bars = [
    bar(60, 103, 104, 102, 103),      // never came back
    bar(120, 103, 103.5, 100.6, 101), // low 100.6 > 100.5: not a touch
    bar(180, 101, 101.5, 100.4, 100.8), // touch (≤ 100.5) and close > 100 → fill
    bar(240, 100.8, 102, 100.7, 101.9),
  ];
  const r = retestTriggered(bars, level, "buy");
  assert.equal(r.outcome, "fill");
  assert.equal((r as { bar: KrakenBar }).bar.t, 180);
});

test("a long fails on a close more than 0.5% below the level; a wick below that reclaims is a fill, not a fail", () => {
  const level = 100;
  assert.equal(retestTriggered([bar(60, 101, 101, 99.2, 100.2)], level, "buy").outcome, "fill", "wick to 99.2, closed back above 100");
  assert.equal(retestTriggered([bar(60, 101, 101, 99.2, 99.9)], level, "buy").outcome, "none", "closed inside the band but below the level: neither");
  const fail = retestTriggered([bar(60, 101, 101, 99, 99.4)], level, "buy");
  assert.equal(fail.outcome, "fail");
  assert.equal((fail as { bar: KrakenBar }).bar.t, 60);
  // A fail before a would-be fill is a fail — the first decisive bar wins.
  assert.equal(retestTriggered([bar(60, 101, 101, 99, 99.4), bar(120, 99.4, 101, 99.4, 100.9)], level, "buy").outcome, "fail");
});

test("no bars, no level, or no decisive bar → none", () => {
  assert.equal(retestTriggered([], 100, "buy").outcome, "none");
  assert.equal(retestTriggered([bar(60, 101, 102, 101, 101.5)], 0, "buy").outcome, "none");
  assert.equal(retestTriggered([bar(60, 101, 102, 101, 101.5)], 100, "buy").outcome, "none");
});

test("shorts mirror: touch from below (≥ level × 0.995) and close below fills; a close 0.5% above fails", () => {
  const level = 100;
  assert.equal(retestTriggered([bar(60, 98, 99.6, 97.5, 99.2)], level, "sell").outcome, "fill");
  assert.equal(retestTriggered([bar(60, 98, 99.4, 97.5, 99.2)], level, "sell").outcome, "none");
  assert.equal(retestTriggered([bar(60, 99, 101, 99, 100.6)], level, "sell").outcome, "fail");
});

test("the scanner stamps the pierced level on the breakout, and the plan carries it as a deferred entry", () => {
  const T0 = 1_757_000_000 - (1_757_000_000 % 14400);
  const bars: KrakenBar[] = [];
  let px = 100;
  for (let i = 0; i < 60; i++) { const o = px, c = px * 1.003, h = Math.max(o, c) * 1.002, l = Math.min(o, c) * 0.998; bars.push({ t: T0 + i * 14400, o, h, l, c, v: 1000 }); px = c; }
  bars[59].h *= 1.03; bars[59].c *= 1.02;
  const tf: TfSpec = { interval: 240, label: "4h", movePct: 0.05, realertMs: 1 };
  const sig = evaluate({ name: "TST", symbol: "TST/USD" }, tf, bars);
  const brk = sig.find((s) => s.kind === "breakout")!;
  const hh = Math.max(...bars.slice(39, 59).map((b) => b.h));
  assert.equal(brk.level, hh, "level = the 20 completed bars' high the forming bar pierced");
  assert.ok(brk.atrFrac != null && brk.atrFrac > 0 && brk.atrFrac < 0.05, `atrFrac ${brk.atrFrac}`);
  assert.equal(sig.find((s) => s.kind !== "breakout" && s.kind !== "breakdown" && s.level != null), undefined, "no other signal carries a level");
  const plans = autoShadowPlans("breakout", "4h", { tier: "high", factors: [] }, 5, { btcUp: true }, "TST/USD", { level: brk.level });
  assert.deepEqual(plans.find((p) => p.source === "swing-retest"), { source: "swing-retest", lev: 5, deferred: true, level: hh });
});
