import assert from "node:assert/strict";
import test from "node:test";
import { RETIRED_AUTO_SOURCES, autoShadowPlans } from "../src/lib/margin-auto-plans";
import { scoreConviction, type ScanSignal } from "../src/lib/margin-scanner";

const high = { tier: "high", factors: ["3 timeframes breaking", "volume confirms", "momentum aligned"] };
const highStretched = { tier: "high", factors: ["3 timeframes breaking", "volume confirms", "stretched (−)"] };
const med = { tier: "med", factors: ["2 timeframes breaking"] };
const low = { tier: "low", factors: [] };

test("retired sleeves never appear in new auto plans", () => {
  const kinds = ["breakout", "breakdown"] as const;
  const tfs = ["5m", "15m", "1h", "4h", "1d"] as const;
  const convs = [high, highStretched, med, low];
  for (const kind of kinds) {
    for (const tf of tfs) {
      for (const conv of convs) {
        for (const p of autoShadowPlans(kind, tf, conv, 5)) {
          assert.equal(RETIRED_AUTO_SOURCES.has(p.source), false, `${p.source} must not auto-open`);
          assert.equal(p.source, "selective");
        }
      }
    }
  }
});

test("shorts / breakdowns never auto-open — 12 selective sells hit 17% and lost $3.2k", () => {
  assert.deepEqual(autoShadowPlans("breakdown", "5m", high, 5), []);
  assert.deepEqual(autoShadowPlans("breakdown", "15m", high, 5), []);
  assert.deepEqual(autoShadowPlans("rsi", "5m", high, 5), []);
});

test("med/low conviction opens nothing", () => {
  assert.deepEqual(autoShadowPlans("breakout", "5m", med, 5), []);
  assert.deepEqual(autoShadowPlans("breakout", "15m", low, 5), []);
});

test("stretched highs are skipped — buying into the RSI extreme was a coin-flip", () => {
  assert.deepEqual(autoShadowPlans("breakout", "5m", highStretched, 5), []);
  assert.deepEqual(autoShadowPlans("breakout", "15m", highStretched, 5), []);
});

test("1h/4h/1d high longs are paused — 3%/48h selective is a 5m/15m container", () => {
  assert.deepEqual(autoShadowPlans("breakout", "1h", high, 5), []);
  assert.deepEqual(autoShadowPlans("breakout", "4h", high, 5), []);
  assert.deepEqual(autoShadowPlans("breakout", "1d", high, 5), []);
});

test("the paying paper path: high 5m/15m long, not stretched → selective only", () => {
  assert.deepEqual(autoShadowPlans("breakout", "5m", high, 5), [{ source: "selective", lev: 5 }]);
  assert.deepEqual(autoShadowPlans("breakout", "15m", high, 8), [{ source: "selective", lev: 8 }]);
});

test("swings are not opened — not the live candidate", () => {
  for (const p of autoShadowPlans("breakout", "4h", high, 5)) {
    assert.notEqual(p.source, "swing-lev");
    assert.notEqual(p.source, "swing-spot");
  }
});

function sig(partial: Partial<ScanSignal> & Pick<ScanSignal, "kind" | "timeframe">): ScanSignal {
  return { coin: "BTC", symbol: "BTC/USD", price: 100, realertMs: 1, detail: "x", ...partial };
}

test("real scorer: 3-TF + volume is high and opens; adding RSI stretch still high but does not open", () => {
  const br = sig({ kind: "breakout", timeframe: "5m" });
  const confluence: ScanSignal[] = [
    br,
    sig({ kind: "breakout", timeframe: "15m" }),
    sig({ kind: "breakout", timeframe: "1h" }),
    sig({ kind: "volume-spike", timeframe: "5m" }),
  ];
  const clean = scoreConviction(br, confluence);
  assert.equal(clean.tier, "high");
  assert.deepEqual(autoShadowPlans(br.kind, br.timeframe, clean, 5), [{ source: "selective", lev: 5 }]);

  const stretched = scoreConviction(br, [...confluence, sig({ kind: "overbought", timeframe: "5m" })]);
  assert.equal(stretched.tier, "high");
  assert.ok(stretched.factors.some((f) => /stretched/i.test(f)));
  assert.deepEqual(autoShadowPlans(br.kind, br.timeframe, stretched, 5), []);
});
