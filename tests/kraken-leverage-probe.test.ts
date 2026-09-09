import assert from "node:assert/strict";
import test from "node:test";
import { PROBE_PLAN } from "../src/lib/kraken-leverage-probe";
import { US_MARGIN_MAX_LEVERAGE } from "../src/lib/kraken-pairs";

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
