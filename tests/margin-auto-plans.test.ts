import assert from "node:assert/strict";
import test from "node:test";
import { RETIRED_AUTO_SOURCES, autoShadowPlans } from "../src/lib/margin-auto-plans";

test("retired sleeves never appear in new auto plans", () => {
  const kinds = ["breakout", "breakdown"] as const;
  const tfs = ["15m", "1h", "4h", "1d"] as const;
  const tiers = ["low", "med", "high"] as const;
  for (const kind of kinds) {
    for (const tf of tfs) {
      for (const tier of tiers) {
        for (const p of autoShadowPlans(kind, tf, tier, 5)) {
          assert.equal(RETIRED_AUTO_SOURCES.has(p.source), false, `${p.source} must not auto-open`);
        }
      }
    }
  }
});

test("med/low conviction opens nothing — conviction filter is the intelligence", () => {
  assert.deepEqual(autoShadowPlans("breakout", "15m", "med", 5), []);
  assert.deepEqual(autoShadowPlans("breakdown", "1d", "low", 5), []);
  assert.deepEqual(autoShadowPlans("breakout", "4h", "HIGH", 5), []); // case-sensitive, same as scorer
  assert.deepEqual(autoShadowPlans("rsi", "1h", "high", 5), []);
});

test("high-conviction intraday is selective only (scanner retired)", () => {
  assert.deepEqual(autoShadowPlans("breakout", "15m", "high", 5), [{ source: "selective", lev: 5 }]);
  assert.deepEqual(autoShadowPlans("breakdown", "1h", "high", 5), [{ source: "selective", lev: 5 }]);
});

test("high-conviction 4h/1d also fills the two gathering swing sleeves", () => {
  assert.deepEqual(autoShadowPlans("breakout", "4h", "high", 5), [
    { source: "selective", lev: 5 },
    { source: "swing-lev", lev: 5 },
    { source: "swing-spot", lev: 1 },
  ]);
  assert.deepEqual(autoShadowPlans("breakdown", "1d", "high", 8), [
    { source: "selective", lev: 8 },
    { source: "swing-lev", lev: 8 },
    { source: "swing-spot", lev: 1 },
  ]);
});

test("retired set covers the four stopped sleeves", () => {
  assert.ok(RETIRED_AUTO_SOURCES.has("scanner"));
  assert.ok(RETIRED_AUTO_SOURCES.has("selective-swing"));
  assert.ok(RETIRED_AUTO_SOURCES.has("fast-tight"));
  assert.ok(RETIRED_AUTO_SOURCES.has("sweep-fade"));
  assert.equal(RETIRED_AUTO_SOURCES.has("selective"), false);
  assert.equal(RETIRED_AUTO_SOURCES.has("swing-lev"), false);
});
