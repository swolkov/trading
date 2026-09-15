import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { LIQUIDITY_TIER, OPP_CAPS, OPP_LIVE_LINE, opportunityBucket, opportunityScore, type OpportunityInputs } from "../src/lib/margin-opportunity-score";
import { OPP_PREREGISTERED_AT, promotionVerdict } from "../src/lib/margin-opportunity-slices";
import { SCAN_UNIVERSE } from "../src/lib/kraken-pairs";
import { INTEL_STAMP_COLUMNS } from "../src/lib/margin-shadow";
import { gatherIntel, stampSql } from "../src/lib/margin-intel";
import type { TfFeatures } from "../src/lib/margin-scanner";
import type { MtfState } from "../src/lib/margin-mtf";

const feat = (over: Partial<TfFeatures> = {}): TfFeatures => ({
  close: 100, ret1: 0.01, sma20: 97, prevClose20: 95, hh20: 99, ll20: 90, hh90: 112, ll90: 80, atr14: 2, atrRatio30: 1, volRatio20: 3, rsi14: 60,
  lastRange: 0.02, dollarVol20: 1e6, gapBars: 0, dupBars: 0, staleMs: 0, dataOk: true, dataReason: null, ...over,
});
const MTF_UP: MtfState = { d1: "up", h4: "up", h1: "up", aligned: "long", text: "U/U/U" };
const MTF_FLAT: MtfState = { d1: "flat", h4: "flat", h1: "flat", aligned: null, text: "F/F/F" };
const BEST: OpportunityInputs = { coin: "BTC", side: "buy", signal: feat(), h4: feat(), mtf: MTF_UP, eventMode: "normal", funding8hRel: -0.0003, oiChg24h: 0.1, btcRegime: "up", stopFrac: 0.04 };
const score = (over: Partial<OpportunityInputs>) => opportunityScore({ ...BEST, ...over });
const sum = (c: Record<string, number>) => Object.values(c).reduce((s, x) => s + x, 0);

test("the prompt's caps sum to 100; the live line is 80; a best-case long scores 100 with nothing missing", () => {
  assert.equal(sum(OPP_CAPS), 100);
  assert.equal(OPP_LIVE_LINE, 80);
  const r = opportunityScore(BEST);
  assert.equal(r.score, 100);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.components, { structure: 20, momentum: 10, volume: 10, oi: 10, funding: 10, catalyst: 15, liquidity: 10, rr: 10, macro: 5 });
});

test("bounded and deterministic: every component within its cap, the total within 0–100, the same inputs → the same output", () => {
  const cases: Partial<OpportunityInputs>[] = [
    {}, { side: "sell" }, { signal: null, h4: null, mtf: null, eventMode: null, funding8hRel: null, oiChg24h: null, btcRegime: null },
    { signal: feat({ close: 200, volRatio20: 50, rsi14: 99 }), oiChg24h: 5, funding8hRel: -1 }, { signal: feat({ close: 1, volRatio20: 0 }), oiChg24h: -5, funding8hRel: 1 },
    { coin: "NOPE", stopFrac: 0 }, { signal: feat({ sma20: NaN }), h4: feat({ hh90: NaN }) },
  ];
  for (const c of cases) {
    const a = score(c), b = score(c);
    assert.deepEqual(a, b, "deterministic");
    assert.ok(a.score >= 0 && a.score <= 100 && Number.isInteger(a.score), `score ${a.score}`);
    for (const k of Object.keys(OPP_CAPS) as (keyof typeof OPP_CAPS)[]) assert.ok(a.components[k] >= 0 && a.components[k] <= OPP_CAPS[k], `${k}=${a.components[k]} within ${OPP_CAPS[k]}`);
    assert.ok(Math.abs(sum(a.components) - a.score) < 0.5 + 1e-9, "score is the rounded component sum");
  }
});

test("monotone per component (others fixed): structure in aligned timeframes, momentum in distance, volume in ratio, OI in change, funding against the trade, R:R in room", () => {
  const comp = (over: Partial<OpportunityInputs>, k: keyof typeof OPP_CAPS) => score(over).components[k];
  // structure: 8 + 4 per aligned timeframe.
  assert.equal(comp({ mtf: MTF_FLAT }, "structure"), 8);
  assert.equal(comp({ mtf: { ...MTF_FLAT, d1: "up" } }, "structure"), 12);
  assert.equal(comp({ mtf: { ...MTF_FLAT, d1: "up", h4: "up" } }, "structure"), 16);
  assert.equal(comp({ mtf: MTF_UP }, "structure"), 20);
  assert.equal(comp({ side: "sell", mtf: MTF_UP }, "structure"), 8, "alignment is directional");
  // momentum: rises with distance above the mean for a long; halved when stretched.
  const m = [97, 98, 99, 100, 101].map((close) => comp({ signal: feat({ close }) }, "momentum"));
  for (let i = 1; i < m.length; i++) assert.ok(m[i] >= m[i - 1], `momentum ${m}`);
  assert.equal(m[0], 0); assert.equal(m[4], 10);
  assert.equal(comp({ signal: feat({ close: 100, rsi14: 75 }) }, "momentum"), 5, "stretched halves it");
  assert.equal(comp({ side: "sell", signal: feat({ close: 100 }) }, "momentum"), 0, "a short above the mean has no momentum");
  // volume.
  const v = [0.5, 1, 2, 3, 6].map((volRatio20) => comp({ signal: feat({ volRatio20 }) }, "volume"));
  for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1]);
  assert.equal(v[1], 0); assert.equal(v[3], 10);
  // OI.
  const o = [-0.1, -0.05, 0, 0.05, 0.1, 0.5].map((oiChg24h) => comp({ oiChg24h }, "oi"));
  for (let i = 1; i < o.length; i++) assert.ok(o[i] >= o[i - 1]);
  assert.equal(o[1], 0); assert.equal(o[4], 10);
  // funding: longs prefer negative; shorts the mirror.
  const f = [0.001, 0.0003, 0, -0.0003, -0.001].map((funding8hRel) => comp({ funding8hRel }, "funding"));
  for (let i = 1; i < f.length; i++) assert.ok(f[i] >= f[i - 1], `funding ${f}`);
  assert.equal(f[0], 0); assert.equal(f[2], 5); assert.equal(f[4], 10);
  assert.equal(comp({ side: "sell", funding8hRel: 0.0003 }, "funding"), 10);
  assert.equal(comp({ side: "sell", funding8hRel: -0.0003 }, "funding"), 0);
  // R:R: more room → more points; a new 90-bar high is open sky.
  const rr = [101, 104, 108, 112].map((hh90) => comp({ h4: feat({ hh90 }) }, "rr"));
  for (let i = 1; i < rr.length; i++) assert.ok(rr[i] >= rr[i - 1], `rr ${rr}`);
  assert.ok(rr[0] < rr[3]);
  assert.equal(comp({ h4: feat({ close: 113, hh90: 112 }) }, "rr"), 10, "through the 90-bar high = full");
  assert.equal(comp({ side: "sell", h4: feat({ close: 100, ll90: 80 }) }, "rr"), 10, "20% of room at a 4% stop = 5R = full");
  assert.equal(comp({ side: "sell", h4: feat({ close: 100, ll90: 96 }) }, "rr"), 3.33, "4% of room at a 4% stop = 1R = a third (components are rounded to 2dp)");
  // liquidity: static.
  assert.equal(comp({ coin: "BTC" }, "liquidity"), 10);
  assert.equal(comp({ coin: "PENGU" }, "liquidity"), 3);
  assert.equal(comp({ coin: "NOPE" }, "liquidity"), 3);
  // macro: agreement.
  assert.equal(comp({ btcRegime: "up" }, "macro"), 5);
  assert.equal(comp({ btcRegime: "down" }, "macro"), 0);
  assert.equal(comp({ side: "sell", btcRegime: "down" }, "macro"), 5);
});

test("catalyst is penalty only: normal 15 / reduced 7 / paused 0; unknown reads as reduced and is named missing", () => {
  assert.equal(score({ eventMode: "normal" }).components.catalyst, 15);
  assert.equal(score({ eventMode: "reduced" }).components.catalyst, 7);
  assert.equal(score({ eventMode: "paused" }).components.catalyst, 0);
  assert.ok(!score({ eventMode: "reduced" }).missing.includes("event"));
  const unknown = score({ eventMode: null });
  assert.equal(unknown.components.catalyst, 7);
  assert.ok(unknown.missing.includes("event"));
  assert.ok(score({ eventMode: "paused" }).score <= 85, "a paused window costs the full 15");
});

test("missing derivatives → 5 each and named; missing regime → 2; missing features → 0 and named", () => {
  const r = score({ funding8hRel: null, oiChg24h: undefined, btcRegime: "unknown", signal: null, h4: null, mtf: null });
  assert.equal(r.components.oi, 5);
  assert.equal(r.components.funding, 5);
  assert.equal(r.components.macro, 2);
  assert.equal(r.components.momentum, 0);
  assert.equal(r.components.volume, 0);
  assert.equal(r.components.rr, 0);
  assert.equal(r.components.structure, 8);
  assert.deepEqual([...r.missing].sort(), ["btcRegime", "funding", "momentum", "mtf", "oi", "rr", "volume"]);
  assert.equal(opportunityBucket(r.score), r.score >= 80 ? "≥80" : r.score >= 60 ? "60–79" : "<60");
  assert.equal(opportunityBucket(null), "unscored");
  assert.equal(opportunityBucket(80), "≥80");
  assert.equal(opportunityBucket(79.6), "60–79");
});

test("the liquidity table covers the whole scan universe; the stamp writes opportunity_score + opportunity_json (both ensureShadowColumns columns)", () => {
  for (const c of SCAN_UNIVERSE) assert.ok(Object.hasOwn(LIQUIDITY_TIER, c), `${c} has a liquidity tier`);
  const r = opportunityScore(BEST);
  const s = stampSql(gatherIntel({ features: {} }), "BTC", { opportunity: r });
  const i = s.columns.indexOf("opportunity_score");
  assert.ok(i > 0);
  assert.equal(s.columns[i + 1], "opportunity_json");
  assert.equal(s.values[i], 100);
  assert.deepEqual(JSON.parse(String(s.values[i + 1])), { components: r.components, missing: [] });
  const created = new Set(INTEL_STAMP_COLUMNS.map((c) => c.split(" ")[0]));
  assert.ok(created.has("opportunity_score") && created.has("opportunity_json"));
  assert.ok(!stampSql(gatherIntel({ features: {} }), "BTC").columns.includes("opportunity_score"), "no score → no column");
});

test("promotionVerdict: thin → gathering; full but t<2 or ≥80 not out-earning → not ranking; all three → PROMOTABLE", () => {
  assert.equal(OPP_PREREGISTERED_AT, "2026-09-15");
  const sl = (key: string, resolved: number, net: number, tStat: number | null) => ({ key, resolved, wins: 0, hitRate: null, net, tStat, days: 1, open: 0 });
  assert.equal(promotionVerdict([]).status, "gathering");
  assert.equal(promotionVerdict([sl("≥80", 29, 900, 3), sl("<80", 100, 0, 0)]).status, "gathering");
  assert.equal(promotionVerdict([sl("≥80", 40, 900, 3), sl("<80", 29, 0, 0)]).status, "gathering");
  const thin = promotionVerdict([sl("≥80", 12, 900, 3), sl("<80", 40, 0, 0)]);
  assert.match(thin.reasons[0], /≥80: 12\/30 resolved · <80: 40\/30 resolved/);
  // Negative: the high bucket loses.
  const neg = promotionVerdict([sl("≥80", 40, -400, -1.5), sl("<80", 60, 300, 1)]);
  assert.equal(neg.status, "not ranking");
  assert.ok(neg.reasons.some((r) => /t\(≥80\) = -1\.50 < 2/.test(r)));
  assert.ok(neg.reasons.some((r) => /does not beat/.test(r)));
  // Significant but not better per trade than the rest.
  const notBetter = promotionVerdict([sl("≥80", 40, 400, 2.5), sl("<80", 40, 800, 3)]);
  assert.equal(notBetter.status, "not ranking");
  assert.deepEqual(notBetter.reasons, ["net/trade ≥80 $10 does not beat <80 $20"]);
  // Better per trade but not significant.
  assert.equal(promotionVerdict([sl("≥80", 40, 800, 1.9), sl("<80", 40, 400, 3)]).status, "not ranking");
  assert.equal(promotionVerdict([sl("≥80", 40, 800, null), sl("<80", 40, 400, 3)]).status, "not ranking");
  // All three.
  const ok = promotionVerdict([sl("≥80", 40, 1200, 2.4), sl("<80", 60, 600, 1)]);
  assert.equal(ok.status, "PROMOTABLE");
  assert.match(ok.reasons[0], /t\(≥80\) = 2\.40 ≥ 2; net\/trade \$30 vs \$10 on 40\/60 resolved/);
});

test("the score never reaches the money path: executor, auto-plans, live-risk and risk-tiers do not import it; the scan scores EVERY fresh directional signal and keeps the card's score as conviction", () => {
  for (const f of ["../src/lib/margin-executor.ts", "../src/lib/margin-auto-plans.ts", "../src/lib/margin-live-risk.ts", "../src/lib/margin-risk-tiers.ts", "../src/app/api/cron/margin-watch/route.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/margin-opportunity-score|margin-opportunity-slices|opportunityScore\(/.test(src), `${f} does not read the score`);
  }
  const scan = readFileSync(new URL("../src/app/api/cron/margin-scan/route.ts", import.meta.url), "utf8");
  const scoreAt = scan.indexOf("const opp = opportunityScore({");
  const refuseAt = scan.indexOf("if (plans.length === 0) {");
  assert.ok(scoreAt > 0 && scoreAt < refuseAt, "scored before the no-plan refusal, so refused signals are scored too");
  assert.ok(/stampSql\(intel, s\.coin, \{ opportunity: opp \}\)/.test(scan));
  assert.ok(/score:\s*conv\.score/.test(scan), "the trade card's score is still the conviction score");
  assert.ok(!/kraken_margin_min_score/.test(scan), "no live gate key in this PR");
});
