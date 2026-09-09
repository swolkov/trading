import assert from "node:assert/strict";
import test from "node:test";
import { RETIRED_AUTO_SOURCES, autoShadowPlans, SWING_TFS, SWING_LEV_TFS } from "../src/lib/margin-auto-plans";
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
          assert.ok(["selective", "selective-x5", "selective-tight", "selective-launch", "swing-lev", "swing-spot", "swing-wide"].includes(p.source), p.source);
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
  assert.deepEqual(autoShadowPlans("breakout", "4h", high, 5), [{ source: "swing-lev", lev: 5 }, { source: "swing-spot", lev: 1 }, { source: "swing-wide", lev: 5 }], "4h high breakouts feed the slow family (reactivated Sep 8) plus the wide-trail twin (Sep 9)");
  // 1d feeds the SPOT sleeve only. The leveraged container was measured 4h-only on 2026-09-09
  // (4h t=2.72 vs 1d t=-1.12, Welch t=2.34 on the difference); swing-spot's 6%/14d container
  // was NOT tested, so it keeps both timeframes rather than inheriting an untested cut.
  assert.deepEqual(autoShadowPlans("breakout", "1d", high, 5), [{ source: "swing-spot", lev: 1 }]);
});

test("the paying paper path: high 5m/15m long, not stretched → selective plus its ×5-size twin", () => {
  assert.deepEqual(autoShadowPlans("breakout", "5m", high, 5), [{ source: "selective", lev: 5 }, { source: "selective-x5", lev: 5 }, { source: "selective-tight", lev: 5 }, { source: "selective-launch", lev: 5 }]);
  assert.deepEqual(autoShadowPlans("breakout", "15m", high, 8), [{ source: "selective", lev: 8 }, { source: "selective-x5", lev: 5 }, { source: "selective-tight", lev: 8 }, { source: "selective-launch", lev: 8 }]);
});

test("the ×5-size twin rides the same signal, never on its own, and sizes at 5× the risk", async () => {
  const { positionNotional } = await import("../src/lib/margin-shadow");
  const base = positionNotional("selective", 5, 100, 5000, 0.06);
  const big = positionNotional("selective-x5", 5, 100, 5000, 0.06);
  assert.ok(Math.abs(base - 5000 * 2) < 1e-6, "selective at 6% risk / 3% stop = 2× equity");
  assert.ok(Math.abs(big - 5000 * 5) < 1e-6, "the ×5 twin wants 10× equity and is capped at the 5× leverage cap");
  assert.deepEqual(autoShadowPlans("breakdown", "5m", high, 5), [], "no twin without a base plan");
});

test("the slow family (reactivated Sep 8) opens ONLY on high-conviction 4h/1d breakouts, longs, and never the fast twins", () => {
  assert.deepEqual(autoShadowPlans("breakout", "4h", high, 5).map((p) => p.source), ["swing-lev", "swing-spot", "swing-wide"]);
  assert.deepEqual(autoShadowPlans("breakout", "1d", high, 8), [{ source: "swing-spot", lev: 1 }], "1d is spot-only; the leveraged container is 4h-only");
  assert.deepEqual(autoShadowPlans("breakout", "4h", highStretched, 5).map((p) => p.source), ["swing-lev", "swing-spot", "swing-wide"], "the Sep 3–4 rule had no stretched filter — kept, so the record stays continuous");
  assert.deepEqual(autoShadowPlans("breakout", "4h", med, 5), []);
  assert.deepEqual(autoShadowPlans("breakdown", "4h", high, 5, { btcUp: false }), [], "longs only");
  for (const tf of ["5m", "15m"]) assert.ok(!autoShadowPlans("breakout", tf, high, 5).some((p) => p.source.startsWith("swing")), `${tf} never feeds the slow family`);
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
  assert.deepEqual(autoShadowPlans(br.kind, br.timeframe, clean, 5), [{ source: "selective", lev: 5 }, { source: "selective-x5", lev: 5 }, { source: "selective-tight", lev: 5 }, { source: "selective-launch", lev: 5 }]);

  const stretched = scoreConviction(br, [...confluence, sig({ kind: "overbought", timeframe: "5m" })]);
  assert.equal(stretched.tier, "high");
  assert.ok(stretched.factors.some((f) => /stretched/i.test(f)));
  assert.deepEqual(autoShadowPlans(br.kind, br.timeframe, stretched, 5), []);
});

test("the leveraged swing container is 4h-only; the spot container keeps both timeframes", () => {
  // Measured, not assumed (scripts/backtest-variants.ts, 2026-09-09): replaying swing-lev's
  // own 4%/96h container over every available Kraken bar, one open trade per coin —
  //   4h  88 trades  avg +$152  t= 2.72   95% CI  +$42 … +$262
  //   1d  31 trades  avg −$107  t=-1.12   95% CI −$295 … +$81
  //   Welch on the difference: +$259/trade, t=2.34, 95% CI +$42 … +$477  ← the legs differ
  // 1d is NOT significantly negative on its own; what is established is that it is
  // significantly WORSE than 4h in this container, and it dragged the combined record from
  // t=2.72 to t=1.72. swing-spot's container was never measured, so it is deliberately
  // untouched — the asymmetry below is the whole point of this test.
  const high = { tier: "high", factors: ["3 timeframes breaking", "volume confirms", "momentum aligned"] };
  const at = (tf: string) => autoShadowPlans("breakout", tf, high, 5).map((p) => p.source);
  assert.deepEqual(at("4h"), ["swing-lev", "swing-spot", "swing-wide"]);
  assert.deepEqual(at("1d"), ["swing-spot"]);
  assert.deepEqual(at("1h"), [], "1h still opens nothing");
  assert.ok(SWING_LEV_TFS.has("4h") && !SWING_LEV_TFS.has("1d"));
  assert.ok(SWING_TFS.has("4h") && SWING_TFS.has("1d"), "the spot family still spans both");
});
