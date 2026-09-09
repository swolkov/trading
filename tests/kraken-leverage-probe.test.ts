import assert from "node:assert/strict";
import test from "node:test";
import { PROBE_PLAN, judge } from "../src/lib/kraken-leverage-probe";
import { US_MARGIN_MAX_LEVERAGE } from "../src/lib/kraken-pairs";
import { leverageThatFitsStop } from "../src/lib/margin-live-risk";

// The probe only earns its private-call budget if it asks about the coins that are actually
// in dispute, and if it carries controls that would expose a broken probe.

test("the probe asks about every coin where the table and Kraken's public feed disagree", () => {
  // Kraken public AssetPairs (international product), read 2026-09-09.
  const publicFeed: Record<string, number> = { XLM: 5, ALGO: 5, NEAR: 5, RENDER: 5, PENGU: 3, BTC: 10, ETH: 10 };
  for (const [coin, pub] of Object.entries(publicFeed)) {
    const table = US_MARGIN_MAX_LEVERAGE[coin];
    if (table !== undefined && table < pub) {
      assert.ok(PROBE_PLAN[coin], `${coin} is understated in the table (${table}× vs ${pub}×) and must be probed`);
      assert.ok(Math.max(...PROBE_PLAN[coin]) >= pub, `${coin} must be probed up to at least ${pub}×`);
    }
  }
});

test("the probe carries controls that would catch a broken probe", () => {
  // BTC is the one coin whose US cap is PROVEN by real fills at 20×. If a run rejects BTC at
  // 20× then the probe itself is wrong — venue pair, key scope, volume — and no table change
  // should be made from that run.
  assert.ok(PROBE_PLAN.BTC?.includes(20), "BTC@20x is the proof-by-fills control");
  assert.equal(US_MARGIN_MAX_LEVERAGE.BTC, 20);
  // ETH is the agreement control: table and public feed both say 10x.
  assert.ok(PROBE_PLAN.ETH?.includes(10));
  assert.equal(US_MARGIN_MAX_LEVERAGE.ETH, 10);
});

test("every probed level is a real Kraken rung and never below the margin minimum", () => {
  for (const [coin, levels] of Object.entries(PROBE_PLAN)) {
    assert.ok(levels.length > 0, coin);
    for (const l of levels) {
      assert.ok(Number.isInteger(l), `${coin} ${l}`);
      assert.ok(l >= 2, `${coin}: ${l}× is below Kraken's margin minimum of 2`);
      assert.ok(l <= 20, `${coin}: ${l}× is above anything Kraken offers`);
    }
    assert.deepEqual([...levels].sort((a, b) => a - b), levels, `${coin} levels should be ascending`);
  }
});

test("BTC's 12x rung is probed — the executor can ask for it and nobody has verified it", () => {
  // leverageThatFitsStop(3%, 20) = 12, so every FAST-container sleeve on BTC would send
  // leverage:"12" once kraken_shadow_lev >= 12. Kraken's public rungs for XBT stop at 10 and
  // the US venue is known to differ, so 12 is unverified. A rejection is fail-safe, but it
  // would make BTC silently unenterable for the whole fast family.
  assert.equal(leverageThatFitsStop(3, 20), 12, "this is the rung the fast container reaches for");
  assert.ok(PROBE_PLAN.BTC?.includes(12), "so the probe must ask about it");
  // The controls must still be there alongside it.
  assert.ok(PROBE_PLAN.BTC?.includes(20) && PROBE_PLAN.BTC?.includes(10));
});

test("a REJECTED rung below an accepted one outranks 'matches'", () => {
  // The exact scenario 12x was added to detect: Kraken refuses 12 but accepts 10 and 20.
  // maxAccepted is 20, which equals the table — so judging on maxAccepted alone reports
  // "matches" while the executor can still ask for 12 and be refused on every BTC entry.
  const gap = judge("BTC", 20, [10, 12, 20], [10, 20]);
  assert.equal(gap.verdict, "gap in ladder");
  assert.deepEqual(gap.rejected, [12]);
  assert.match(gap.detail, /REFUSED 12/);
  // A clean run still reads "matches", and a rung rejected ABOVE the max is just the ceiling.
  assert.equal(judge("BTC", 20, [10, 12, 20], [10, 12, 20]).verdict, "matches");
  assert.equal(judge("ETH", 10, [5, 10, 20], [5, 10]).verdict, "matches", "20 rejected above the max is the cap, not a gap");
  // Table drift is still detected, and total failure never reads as drift.
  assert.equal(judge("XLM", 2, [2, 3, 4, 5], [2, 3, 4, 5]).verdict, "table is LOW");
  assert.equal(judge("PENGU", 5, [2, 3], [2, 3]).verdict, "table is HIGH");
  assert.equal(judge("XLM", 5, [2, 3, 4, 5], []).verdict, "nothing accepted");
});

test("the rung the desk actually runs at is probed on every venue class it touches", () => {
  // The settled config pins the ceiling at 9 and the 4% container yields 9 on every major.
  const running = leverageThatFitsStop(4, 9);
  assert.equal(running, 9);
  for (const coin of ["BTC", "ETH", "SOL"]) assert.ok(PROBE_PLAN[coin]?.includes(running), `${coin} must probe ${running}×`);
});
