import assert from "node:assert/strict";
import test from "node:test";
import { barFeatures, evaluate, scoreConviction, type TfSpec } from "../src/lib/margin-scanner";
import { gatherIntel, INTEL_VERSION, stampSql } from "../src/lib/margin-intel";
import { INTEL_STAMP_COLUMNS } from "../src/lib/margin-shadow";
import type { KrakenBar } from "../src/lib/kraken-margin";

// A deterministic synthetic 4h series: a gentle uptrend, one volume spike on the last
// completed bar, and a forming bar that pierces the 20-bar high. Built from arithmetic, not
// fetched, so the golden pin below can never drift with the market.
const T0 = 1_757_000_000 - (1_757_000_000 % 14400);
function synth(n: number): KrakenBar[] {
  const out: KrakenBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const drift = 0.004 + 0.003 * Math.sin(i / 7);
    const o = px; const c = px * (1 + drift); const h = Math.max(o, c) * 1.004; const l = Math.min(o, c) * 0.996;
    const v = 1000 + 300 * Math.sin(i / 3) + (i === n - 2 ? 4000 : 0);
    out.push({ t: T0 + i * 14400, o, h, l, c, v }); px = c;
  }
  out[n - 1].h *= 1.03; out[n - 1].c *= 1.02;
  return out;
}
const TF4H: TfSpec = { interval: 240, label: "4h", movePct: 0.05, realertMs: 24 * 3600_000 };
const COIN = { name: "TST", symbol: "TST/USD" };

test("GOLDEN PIN: evaluate() and scoreConviction() on the fixture are what they were before the features landed", () => {
  const bars = synth(120);
  const sig = evaluate(COIN, TF4H, bars);
  assert.deepEqual(sig.map((s) => s.kind), ["overbought", "breakout", "volume-spike", "near-high"]);
  for (const s of sig) { assert.equal(s.price, 168.83836835519006); assert.equal(s.realertMs, 86_400_000); assert.equal(s.timeframe, "4h"); }
  assert.match(sig[0].detail, /^RSI 100 overbought$/);
  assert.match(sig[1].detail, /^pierced 20-bar high /);
  assert.match(sig[2].detail, /^volume 4\.4x average$/);
  assert.match(sig[3].detail, /^within 2% of its recent high /);
  const conv = scoreConviction(sig[1], sig);
  assert.deepEqual(conv, { tier: "low", score: 1, factors: ["volume confirms", "at decision zone", "stretched (−)"] });
});

test("barFeatures never changes what evaluate() or scoreConviction() see: same bars, same output, before and after", () => {
  const bars = synth(120);
  const snapshot = JSON.parse(JSON.stringify(bars)) as KrakenBar[];
  const before = evaluate(COIN, TF4H, bars);
  const convBefore = scoreConviction(before[1], before);
  const f = barFeatures(bars, 240, (bars[bars.length - 1].t + 100) * 1000);
  assert.deepEqual(bars, snapshot, "bars are not mutated");
  const after = evaluate(COIN, TF4H, bars);
  assert.deepEqual(after, before);
  assert.deepEqual(scoreConviction(after[1], after), convBefore);
  // The features describe the same series the detectors read.
  assert.equal(f.close, before[0].price);
  assert.ok(f.hh20 < f.close, "the forming bar pierced the 20-bar high");
  assert.ok(f.volRatio20 > 4 && f.volRatio20 < 4.5, "the 4.4× spike");
  assert.equal(f.rsi14, 100);
  assert.ok(f.close >= f.hh90 * 0.98, "near-high");
  assert.ok(f.atrRatio30 > 1 && f.atrRatio30 < 1.8, "neither compression nor expansion, as evaluate said");
  assert.ok(f.dollarVol20 > 0 && f.lastRange > 0 && f.atr14 > 0);
  assert.equal(f.sma20 > f.prevClose20, true);
  assert.deepEqual([f.gapBars, f.dupBars, f.staleMs, f.dataOk, f.dataReason], [0, 0, 0, true, null]);
});

test("NaN guards: an under-sampled series yields NaN features and dataOk=false, never a throw", () => {
  const f = barFeatures(synth(10), 240, Date.now());
  for (const k of ["sma20", "prevClose20", "hh20", "ll20", "atr14", "atrRatio30", "rsi14", "dollarVol20"] as const) assert.ok(Number.isNaN(f[k]), k);
  assert.ok(Number.isFinite(f.close) && Number.isFinite(f.hh90) && Number.isFinite(f.lastRange));
  assert.equal(f.dataOk, false);
  assert.match(f.dataReason!, /insufficient bars \(10\)/);
  const empty = barFeatures([], 240, Date.now());
  assert.equal(empty.dataOk, false);
  assert.ok(Number.isNaN(empty.close));
});

test("data quality: a gap in the last 20 bars, a duplicate bar, or a stale newest bar marks the series not OK", () => {
  const clean = synth(60);
  const now = (clean[clean.length - 1].t + 60) * 1000;
  assert.equal(barFeatures(clean, 240, now).dataOk, true);

  const gapped = synth(60); gapped.splice(55, 1);   // one bucket missing inside the last 20
  const g = barFeatures(gapped, 240, now);
  assert.equal(g.gapBars, 1); assert.equal(g.dataOk, false); assert.match(g.dataReason!, /1 gap\(s\) in the last 20 bars/);

  const oldGap = synth(60); oldGap.splice(20, 1);   // a hole 40 bars back is not this tick's problem
  assert.equal(barFeatures(oldGap, 240, now).dataOk, true);

  const dup = synth(60); dup[50] = { ...dup[49] };
  const d = barFeatures(dup, 240, now);
  assert.equal(d.dupBars, 1); assert.equal(d.dataOk, false); assert.match(d.dataReason!, /duplicate/);

  const stale = barFeatures(clean, 240, (clean[clean.length - 1].t + 3 * 14400) * 1000 + 1);   // just past 2 full bars beyond the newest close
  assert.equal(stale.dataOk, false); assert.match(stale.dataReason!, /past its close/);
  assert.ok(stale.staleMs > 2 * 14400 * 1000);
  // Still forming = not stale; exactly at 2× the timeframe = not stale (strictly greater trips it).
  assert.equal(barFeatures(clean, 240, (clean[clean.length - 1].t + 14400 * 3) * 1000).dataOk, true);
});

test("gatherIntel + stampSql: every scanned coin gets an MTF stamp; every stamped column is one ensureShadowColumns creates", () => {
  const created = new Set(INTEL_STAMP_COLUMNS.map((c) => c.split(" ")[0]));
  const bars = synth(120);
  const features = { "TST:1d": barFeatures(bars, 1440), "TST:4h": barFeatures(bars, 240), "TST:1h": barFeatures(bars, 60), "BTC:4h": barFeatures(bars, 240) };
  const intel = gatherIntel({ features });
  assert.equal(intel.version, INTEL_VERSION);
  assert.equal(intel.event, null); assert.equal(intel.btc, null); assert.equal(intel.deriv, null);
  assert.ok("BTC" in intel.mtf && "ETH" in intel.mtf, "the whole universe is stamped, flat when unseen");
  assert.equal(intel.mtf.ETH.text, "F/F/F");
  assert.equal(intel.mtf.BTC.text, "F/U/F");
  const s = stampSql(intel, "BTC");
  // regime_label (B6) rides on every universe coin's row — "unknown" without a 1d series.
  assert.deepEqual(s, { columns: ["mtf_state", "intel_version", "regime_label"], values: ["F/U/F", INTEL_VERSION, "unknown"] });
  assert.deepEqual(stampSql(intel, "NOPE"), { columns: ["mtf_state", "intel_version"], values: [null, INTEL_VERSION] });
  const withEvent = stampSql(gatherIntel({ features }, { mode: "reduced" }), "BTC");
  assert.deepEqual(withEvent.columns, ["mtf_state", "intel_version", "event_mode", "regime_label"]);
  assert.equal(withEvent.values[2], "reduced");
  for (const c of [...s.columns, ...withEvent.columns]) assert.ok(created.has(c), `${c} is created by ensureShadowColumns`);
});
