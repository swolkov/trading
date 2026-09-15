import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAlert, type AlertPayload } from "../src/lib/futures-desk-rules";
import {
  EXPECTED_MOVE_ATR_K, LIQUIDITY_SCORE, MIN_BARS_FOR_REGIME, NEUTRAL, REGIME_LABELS, SCORE_BUCKET_MIN_N, SCORE_PARTS, VOL_HIGH_FROM, VOL_LOW_BELOW,
  atrSeries, bucketStats, futuresOpportunityScore, minScoreRefusal, parseMinScore, parseRegime, percentileOfLast, pineContextOf, regimeLabel, regimeLabelFor, regimeOf, regimeStamp,
  scoreBucketsOf, scoreJsonOf, scorePromotionVerdict, trendLabelOf, trendOf, volLabelOf, welchT, type DailyBar,
} from "../src/lib/futures-desk-score";
import { renderWeeklyReview, futuresLeaderboard, profitDistribution } from "../src/lib/futures-desk-review";

const body = { secret: "x", desk: "futures", edge: "donchian_60m_long", symbol: "ES", action: "entry", side: "long", price: 6500, stop: 6460, bar: "2026-09-14T21:00:00Z", tf: "60" };
function alertOf(over: Record<string, unknown> = {}): AlertPayload { const p = parseAlert({ ...body, ...over }); if (!p.ok) throw new Error(p.reason); return p.alert; }
const noCells = { edgeRoot: null, edgeRegime: null };

// ---- the score ------------------------------------------------------------------------------------------
test("every part is capped at its weight and the best possible alert scores exactly 100", () => {
  const best = alertOf({ atr: 60, dist20h: 0, d1Up: true, h4Up: true, volRatio: 2 });   // rr = 2×60/40 = 3 → 15
  const s = futuresOpportunityScore(best, "uptrend-midvol", "normal", { edgeRoot: { n: 10, avgR: 0.4 }, edgeRegime: { n: 10, avgR: 1 } });
  for (const [k, cap] of Object.entries(SCORE_PARTS)) assert.ok(s.components[k as keyof typeof SCORE_PARTS] <= cap, `${k} ≤ ${cap}`);
  assert.equal(s.score, 100); assert.deepEqual(s.missing, []);
  assert.equal(Object.values(SCORE_PARTS).reduce((a, b) => a + b, 0), 100);
  // Overshooting inputs cannot exceed the caps.
  const over = futuresOpportunityScore(alertOf({ atr: 600, dist20h: 0.5, d1Up: true, h4Up: true, volRatio: 50 }), "uptrend-lowvol", "normal", { edgeRoot: { n: 500, avgR: 9 }, edgeRegime: { n: 500, avgR: 9 } });
  assert.equal(over.score, 100); assert.equal(over.components.rr, 15); assert.equal(over.components.volume, 10);
});

test("the total is an integer 0–100 for any mix of inputs, never NaN", () => {
  const seeds = [0.1, 0.37, 0.5, 0.73, 0.99];
  for (const x of seeds) {
    const a = alertOf({ atr: x * 100, dist20h: -x / 10, volRatio: x * 3, stop: 6500 - x * 200 });
    const s = futuresOpportunityScore(a, REGIME_LABELS[Math.floor(x * 9)], x > 0.5 ? "reduced" : "paused", { edgeRoot: { n: 12, avgR: x - 0.5 }, edgeRegime: null });
    assert.ok(Number.isInteger(s.score) && s.score >= 0 && s.score <= 100, `score ${s.score}`);
    for (const v of Object.values(s.components)) assert.ok(Number.isFinite(v));
  }
  // A short is mirrored: a downtrend scores it as an uptrend scores a long.
  const shortA = { ...alertOf({ d1Up: false, h4Up: false, dist20h: -0.05 }), side: "short" as const, stop: 6540 };
  const s = futuresOpportunityScore(shortA, "downtrend-midvol", "normal", noCells);
  assert.equal(s.components.trend, 10); assert.equal(s.components.structure, 20);
  // The worst long: everything against it.
  const worst = futuresOpportunityScore(alertOf({ atr: 5, dist20h: -0.2, d1Up: false, h4Up: false, volRatio: 0.1 }), "downtrend-highvol", "paused", { edgeRoot: { n: 40, avgR: -1 }, edgeRegime: { n: 40, avgR: -1 } });
  assert.equal(worst.score, LIQUIDITY_SCORE.ES);   // only the static liquidity part survives
});

test("missing Pine fields, regime, policy and cells score their neutral parts and are listed in `missing`", () => {
  const v1 = alertOf();   // no atr / volRatio / dist20h / d1Up / h4Up
  const s = futuresOpportunityScore(v1, null, null, noCells);
  assert.equal(s.components.structure, NEUTRAL.structureProx + 2 * NEUTRAL.structureMtf);
  assert.equal(s.components.trend, NEUTRAL.trend); assert.equal(s.components.volume, NEUTRAL.volume); assert.equal(s.components.catalyst, NEUTRAL.catalyst);
  assert.equal(s.components.rr, NEUTRAL.rr); assert.equal(s.components.regimeFit, NEUTRAL.regimeFit); assert.equal(s.components.expectancy, NEUTRAL.expectancy);
  assert.equal(s.components.liquidity, 10);
  assert.equal(s.score, Math.round(10 + 5 + 5 + 10 + 5 + 7.5 + 5 + 7));   // 54.5 → 55
  assert.deepEqual(s.missing, ["dist20h", "d1Up", "h4Up", "regime", "volRatio", "eventMode", "atr", "regimeFit (<10 trades in edge×regime)", "expectancy (<10 trades in edge×root)"]);
  // A cell with 9 trades is still neutral; 10 scores. "unknown" regime is neutral too.
  assert.equal(futuresOpportunityScore(v1, "unknown", "normal", { edgeRoot: { n: 9, avgR: 2 }, edgeRegime: null }).components.expectancy, NEUTRAL.expectancy);
  assert.equal(futuresOpportunityScore(v1, "unknown", "normal", { edgeRoot: { n: 10, avgR: 2 }, edgeRegime: null }).components.expectancy, 15);
  assert.ok(futuresOpportunityScore(v1, "unknown", "normal", noCells).missing.includes("regime"));
  // R:R with an ATR but no stop is neutral and names the stop; the stated k is 2.
  const noStop = { ...alertOf({ atr: 50 }), stop: null };
  const r = futuresOpportunityScore(noStop, null, null, noCells);
  assert.equal(r.components.rr, NEUTRAL.rr); assert.ok(r.missing.includes("stop")); assert.equal(EXPECTED_MOVE_ATR_K, 2);
  // Event modes: 10 / 5 / 0.
  assert.equal(futuresOpportunityScore(v1, null, "normal", noCells).components.catalyst, 10);
  assert.equal(futuresOpportunityScore(v1, null, "reduced", noCells).components.catalyst, 5);
  assert.equal(futuresOpportunityScore(v1, null, "paused", noCells).components.catalyst, 0);
});

// ---- regime labels ----------------------------------------------------------------------------------------
/** A synthetic daily series: `n` bars of a path with a fixed range per bar (so ATR is flat) unless `rangeOf` says otherwise. */
function series(n: number, closeAt: (i: number) => number, rangeOf: (i: number) => number = () => 2): DailyBar[] {
  return Array.from({ length: n }, (_, i) => { const c = closeAt(i), r = rangeOf(i); return { h: c + r / 2, l: c - r / 2, c }; });
}

test("trend labels: close vs SMA50 vs SMA200 with exact boundaries; vol labels at the 1/3 and 2/3 percentiles", () => {
  assert.equal(trendLabelOf(110, 105, 100), "uptrend"); assert.equal(trendLabelOf(90, 95, 100), "downtrend");
  assert.equal(trendLabelOf(105, 105, 100), "range"); assert.equal(trendLabelOf(110, 100, 100), "range"); assert.equal(trendLabelOf(90, 105, 100), "range");
  assert.equal(volLabelOf(0), "lowvol"); assert.equal(volLabelOf(VOL_LOW_BELOW - 1e-9), "lowvol"); assert.equal(volLabelOf(VOL_LOW_BELOW), "midvol");
  assert.equal(volLabelOf(VOL_HIGH_FROM - 1e-9), "midvol"); assert.equal(volLabelOf(VOL_HIGH_FROM), "highvol"); assert.equal(volLabelOf(1), "highvol");
  assert.equal(percentileOfLast([1, 2, 3, 4, 5]), 1); assert.equal(percentileOfLast([5, 4, 3, 2, 1]), 0); assert.equal(percentileOfLast([1, 3, 2]), 0.5); assert.equal(percentileOfLast([7]), 0.5);
  assert.equal(REGIME_LABELS.length, 9);
});

test("regimeOf on synthetic series: uptrend / downtrend / range × the ATR percentile; 199 bars → unknown; junk never throws", () => {
  const up = regimeOf(series(260, (i) => 100 + i));
  assert.equal(up.trend, "uptrend"); assert.equal(up.label, "uptrend-lowvol");   // a flat range → every ATR equal → nothing strictly below → percentile 0 → lowvol
  const down = regimeOf(series(260, (i) => 400 - i));
  assert.equal(down.trend, "downtrend");
  const flat = regimeOf(series(260, () => 100));
  assert.equal(flat.trend, "range");
  // A quiet year then a wild last month: the last ATR is the highest → percentile 1 → highvol.
  const spike = regimeOf(series(260, (i) => 100 + i, (i) => (i >= 230 ? 20 : 2)));
  assert.equal(spike.vol, "highvol"); assert.equal(spike.label, "uptrend-highvol");
  // A wild year then a quiet last month → lowvol.
  const calm = regimeOf(series(260, (i) => 100 + i, (i) => (i >= 230 ? 2 : 20)));
  assert.equal(calm.vol, "lowvol"); assert.equal(calm.label, "uptrend-lowvol");
  assert.equal(regimeLabel(series(MIN_BARS_FOR_REGIME - 1, (i) => 100 + i)), "unknown");
  assert.equal(regimeLabel(series(MIN_BARS_FOR_REGIME, (i) => 100 + i)), "uptrend-lowvol");
  for (const junk of [[], null, undefined, [{ h: NaN, l: 1, c: 1 }], [{ h: 0, l: 0, c: 0 }], "x"]) assert.equal(regimeLabel(junk as unknown as DailyBar[]), "unknown");
  assert.equal(atrSeries(series(10, () => 100)).length, 0);
  assert.equal(atrSeries(series(20, () => 100)).length, 6);   // 19 true ranges → ATR from the 14th on
  assert.equal(trendOf("range-highvol"), "range"); assert.equal(trendOf("unknown"), null); assert.equal(trendOf(null), null);
});

test("the regime key round-trips and reads tolerantly; the journal stamp is null for unknown", () => {
  const snap = { at: "2026-09-15T05:01:00Z", byRoot: { ES: { label: "uptrend-midvol", close: 6500, sma50: 6400, sma200: 6000, atr: 60, atrPct: 0.5, at: "2026-09-15T05:01:00Z" }, GC: { label: "bogus", at: "x" }, SI: { label: "unknown", at: "x" } } };
  const p = parseRegime(JSON.stringify(snap));
  assert.ok(p); assert.equal(p.byRoot.ES.label, "uptrend-midvol"); assert.equal(p.byRoot.GC, undefined); assert.equal(p.byRoot.SI.label, "unknown");
  assert.equal(regimeLabelFor(p, "ES"), "uptrend-midvol"); assert.equal(regimeLabelFor(p, "NQ"), "unknown"); assert.equal(regimeLabelFor(null, "ES"), "unknown");
  assert.equal(regimeStamp(p, "ES"), "uptrend-midvol"); assert.equal(regimeStamp(p, "SI"), null); assert.equal(regimeStamp(p, "NQ"), null);
  for (const raw of [null, "", "{", "[]", JSON.stringify({ at: 1 }), JSON.stringify({ at: "x" })]) assert.equal(parseRegime(raw), null);
});

// ---- the signal JSON -------------------------------------------------------------------------------------
test("score_json carries the Pine context and the score; the queue replay reads back ONLY the Pine fields", () => {
  const a = alertOf({ atr: 50, rsi: 28, volRatio: 1.2, dist20h: -0.01, d1Up: true, h4Up: false });
  const s = futuresOpportunityScore(a, "uptrend-midvol", "normal", noCells);
  const json = scoreJsonOf(a, s);
  assert.deepEqual(JSON.parse(json).opportunity, s);
  assert.deepEqual(pineContextOf(json), { atr: 50, rsi: 28, volRatio: 1.2, dist20h: -0.01, d1Up: true, h4Up: false });
  assert.deepEqual(pineContextOf(JSON.stringify({ atr: 50, opportunity: { score: 90 }, score: 90 })), { atr: 50 });
  assert.deepEqual(pineContextOf(null), {}); assert.deepEqual(pineContextOf("{"), {}); assert.deepEqual(pineContextOf(JSON.stringify({ d1Up: "yes", atr: "50" })), {});
  assert.equal(scoreJsonOf(alertOf(), null), "{}");
});

// ---- buckets and the promotion verdict -------------------------------------------------------------------
const rows = (n: number, score: number, r: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ score, r: r(i) }));
test("score buckets: ≥ 80 / 70–79 / < 70; n = 29 in any bucket refuses; 30 apiece with clear separation is green", () => {
  const b = scoreBucketsOf([...rows(2, 80, () => 1), ...rows(1, 79, () => 0), ...rows(1, 70, () => 0), ...rows(3, 69, () => -1), { score: null, r: 1 }, { score: 50, r: null }]);
  assert.equal(b.top.length, 2); assert.equal(b.mid.length, 2); assert.equal(b.bottom.length, 3); assert.equal(b.unscored, 2);
  const wave = (base: number) => (i: number) => base + (i % 4 === 0 ? -0.6 : i % 4 === 1 ? 0.3 : i % 4 === 2 ? 0.9 : -0.2);
  const green = scorePromotionVerdict(scoreBucketsOf([...rows(30, 85, wave(0.9)), ...rows(30, 75, wave(0.3)), ...rows(30, 40, wave(-0.3))]));
  assert.equal(green.ok, true, green.reasons.join(" · ")); assert.ok((green.tStat as number) >= 2);
  const short = scorePromotionVerdict(scoreBucketsOf([...rows(SCORE_BUCKET_MIN_N - 1, 85, wave(0.9)), ...rows(30, 75, wave(0.3)), ...rows(30, 40, wave(-0.3))]));
  assert.equal(short.ok, false); assert.deepEqual(short.reasons, ["≥ 80: 29 of 30 resolved"]);
  const backwards = scorePromotionVerdict(scoreBucketsOf([...rows(30, 85, wave(-0.3)), ...rows(30, 75, wave(0.3)), ...rows(30, 40, wave(0.9))]));
  assert.equal(backwards.ok, false); assert.ok(backwards.reasons.some((r) => r.includes("does not beat"))); assert.ok(backwards.reasons.some((r) => r.startsWith("Welch t")));
  const noise = scorePromotionVerdict(scoreBucketsOf([...rows(30, 85, wave(0.02)), ...rows(30, 75, wave(0)), ...rows(30, 40, wave(0))]));
  assert.equal(noise.ok, false); assert.equal(noise.reasons.length, 1); assert.ok(noise.reasons[0].startsWith("Welch t"));
  const empty = scorePromotionVerdict(scoreBucketsOf([]));
  assert.equal(empty.ok, false); assert.equal(empty.reasons.length, 4);
  assert.equal(welchT([1, 2], [1]), null); assert.equal(welchT([1, 1], [2, 2]), null);
  const bs = bucketStats("x", [1, -0.5, 2]); assert.equal(bs.n, 3); assert.equal(bs.meanR, 2.5 / 3); assert.equal(bs.pf, 6);
  assert.equal(bucketStats("x", [1, 2]).pf, Infinity); assert.equal(bucketStats("x", []).pf, null); assert.equal(bucketStats("x", [-1]).pf, 0);
});

test("the weekly review renders the score buckets and the verdict line", () => {
  const green = scorePromotionVerdict(scoreBucketsOf([...rows(30, 85, (i) => 1 + (i % 2) * 0.2), ...rows(30, 75, (i) => 0.3 + (i % 2) * 0.2), ...rows(30, 40, (i) => -0.3 + (i % 2) * 0.2)]));
  const base = { weekKey: "2026-W38", board: futuresLeaderboard([], 50_000), distribution: profitDistribution([]), verdicts: [], readiness: null, generatedAt: "2026-09-21T13:00:00Z" };
  const md = renderWeeklyReview({ ...base, scoreBuckets: { ...green, unscored: 3, promoted: false } });
  assert.ok(md.includes("## Score buckets")); assert.ok(md.includes("| ≥ 80 | 30 |")); assert.ok(md.includes("GREEN — promote from /futures (type PROMOTE)")); assert.ok(md.includes("not promoted — a stamp"));
  assert.ok(md.indexOf("## Score buckets") > md.indexOf("## Promotion verdicts") && md.indexOf("## Score buckets") < md.indexOf("## Stage readiness"));
  assert.ok(renderWeeklyReview(base).includes("## Score buckets\n- n/a"));
});

// ---- the promoted-only minimum ----------------------------------------------------------------------------
test("minScoreRefusal: exact string, only when promoted, never at a minimum of 0; the key clamps 0–100 and unreadable reads 0", () => {
  assert.equal(minScoreRefusal(64, 70, true), "score 64 is below the desk minimum 70");
  assert.equal(minScoreRefusal(70, 70, true), null); assert.equal(minScoreRefusal(99, 70, true), null);
  assert.equal(minScoreRefusal(64, 70, false), null);           // not promoted: the score is a stamp, the key is inert
  assert.equal(minScoreRefusal(0, 0, true), null);              // minimum 0 never refuses
  assert.equal(minScoreRefusal(null, 70, true), "score missing — the desk minimum is 70");
  assert.equal(minScoreRefusal(undefined, 70, false), null);
  assert.equal(parseMinScore("70"), 70); assert.equal(parseMinScore("150"), 100); assert.equal(parseMinScore("-5"), 0); assert.equal(parseMinScore("abc"), 0); assert.equal(parseMinScore(null), 0);
});
