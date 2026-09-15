import assert from "node:assert/strict";
import test from "node:test";
import {
  FORBIDDEN_PROSE_RE, PROSE_MAX_WORDS, REVIEW_MODEL_CHASE_BP, REVIEW_MODEL_FEE_PCT, REVIEW_MODEL_STOP_SLIP_BP,
  percentileOf, proseAllowed, renderReview, reviewFacts, reviewOneLiner, sizeBand, type ReviewContext, type ReviewFill,
} from "../src/lib/margin-review";
import { MODEL_CHASE_BP, MODEL_STOP_SLIP_BP, MODEL_TAKER_FEE_PCT } from "../src/lib/margin-synthesis";

// C4 — the post-trade review answers the seven questions mechanically. These pin the wording the
// Decisions/ log will carry, the size bands, the slippage flag, the regime flip, and the
// variance-vs-deterioration call. No I/O here: reviewFacts is pure.

const fill = (extra: Partial<ReviewFill> = {}): ReviewFill => ({
  liveTxid: "OABC", source: "swing-pyr", symbol: "ETH/USD", side: "long",
  realEntry: 2540, realVol: 3.645, realEntryAt: "2026-09-11T14:00:00.000Z", realExit: 2556, realExitAt: "2026-09-11T22:00:00.000Z", realNet: 26,
  realEntryFee: 18, realExitFee: 17,
  paperPnl: 30, paperPnlAtLiveSize: 28, paperReason: "trailing stop", paperExit: 2557,
  entrySlipBp: 8, feePctSide: 0.22, stopFillSlipBp: 20,
  exitKind: "stop", mfeR: 1.24, maeR: 0.3, regime: "up",
  ...extra,
});
const ctx = (extra: Partial<ReviewContext> = {}): ReviewContext => ({
  twins: [{ source: "swing-wide", pnl: -36, reason: "trailing stop", open: false }, { source: "swing-lock", pnl: -36, reason: "trailing stop", open: false }, { source: "swing-lev", pnl: 26, reason: "trailing stop", open: false }],
  intendedNotional: 9254, intendedRiskUsd: 370, regimeAtExit: "up",
  sleeveRs: Array.from({ length: 40 }, (_, i) => -1.05 + (i * 3.5) / 39),
  rolling: "stable",
  ...extra,
});

test("the review's model constants are the synthesis's model constants", () => {
  assert.equal(REVIEW_MODEL_CHASE_BP, MODEL_CHASE_BP);
  assert.equal(REVIEW_MODEL_FEE_PCT, MODEL_TAKER_FEE_PCT);
  assert.equal(REVIEW_MODEL_STOP_SLIP_BP, MODEL_STOP_SLIP_BP);
});

test("twin comparison wording: every twin's outcome on the same signal is named, and a surviving wider container is called out", () => {
  const r = reviewFacts(fill(), ctx());
  assert.match(r.stop.text, /same signal in the twins: swing-wide −\$36 \(trailing stop\) · swing-lock −\$36 \(trailing stop\) · swing-lev \+\$26 \(trailing stop\)/);
  assert.equal(r.stop.exitKind, "trailing stop", "a stop exit after a +1R peak is the trail");
  // An initial-stop loss where a twin stayed green → the exit rule, not the entry, made the difference.
  const lost = reviewFacts(fill({ realNet: -380, mfeR: 0.4, maeR: 1.0, paperPnlAtLiveSize: -375, paperReason: "initial stop" }), ctx({ twins: [{ source: "swing-wide", pnl: 120, reason: "trailing stop", open: false }] }));
  assert.equal(lost.stop.exitKind, "initial stop");
  assert.match(lost.stop.text, /a wider container survived this one: the difference is the exit rule, not the entry/);
  // …and where every twin lost too, the move — not the stop width — is named.
  const all = reviewFacts(fill({ realNet: -380, mfeR: 0.4, maeR: 1.0, paperPnlAtLiveSize: -375, paperReason: "initial stop" }), ctx({ twins: [{ source: "swing-wide", pnl: -400, reason: "initial stop", open: false }, { source: "swing-lock", pnl: null, reason: null, open: true }] }));
  assert.match(all.stop.text, /every twin lost too: the move went against the entry, not the stop width/);
  assert.match(all.stop.text, /swing-lock still open/);
});

test("size vs intent: ±10% / ±30% bands from the card's notional", () => {
  assert.equal(sizeBand(10_000, 10_500).band, "within ±10%");
  assert.equal(sizeBand(10_000, 9_000).band, "within ±10%");
  assert.equal(sizeBand(10_000, 8_500).band, "off by 10–30%");
  assert.equal(sizeBand(10_000, 12_500).band, "off by 10–30%");
  assert.equal(sizeBand(10_000, 6_000).band, "off by >30%");
  assert.equal(sizeBand(null, 6_000).band, "unknown");
  assert.equal(sizeBand(0, 6_000).band, "unknown");
  const r = reviewFacts(fill({ realEntry: 2540, realVol: 2.0 }), ctx({ intendedNotional: 9254 }));   // $5,080 filled vs $9,254 intended
  assert.equal(r.size.band, "off by >30%");
  assert.match(r.size.text, /off by >30% — card intended \$9254, filled \$5080 \(55%\)/);
  assert.match(reviewFacts(fill(), ctx({ intendedNotional: null })).size.text, /no card notional to compare/);
});

test("slippage flag: entry slip beyond 2× the chase, or a stop fill beyond 2× the modelled slip", () => {
  const clean = reviewFacts(fill(), ctx());
  assert.deepEqual(clean.slippage.flags, []);
  assert.equal(clean.execution.ok, true);
  const slipped = reviewFacts(fill({ entrySlipBp: 25 }), ctx());
  assert.equal(slipped.slippage.flags.length, 1);
  assert.match(slipped.slippage.flags[0], /entry slippage 25bp > 2× the 10bp chase/);
  assert.equal(slipped.execution.ok, false);
  assert.match(slipped.execution.text, /\(>2× — FLAG\)/);
  const stopSlip = reviewFacts(fill({ stopFillSlipBp: 150 }), ctx());
  assert.match(stopSlip.slippage.flags[0], /stop filled 150bp past the ledgered level \(model 70bp\)/);
  const fee = reviewFacts(fill({ feePctSide: 0.31 }), ctx());
  assert.equal(fee.execution.ok, false);
  assert.match(fee.execution.text, /fee 0\.310%\/side vs 0\.25% \(FLAG\)/);
});

test("regime at entry vs exit: a flip is named; unknowns never read as a flip", () => {
  assert.equal(reviewFacts(fill(), ctx()).regime.flipped, false);
  const flipped = reviewFacts(fill({ regime: "up" }), ctx({ regimeAtExit: "down" }));
  assert.equal(flipped.regime.flipped, true);
  assert.match(flipped.regime.text, /BTC regime FLIPPED up → down while the trade was open/);
  assert.equal(reviewFacts(fill({ regime: "unknown" }), ctx({ regimeAtExit: "down" })).regime.flipped, false);
  assert.equal(reviewFacts(fill({ regime: "up" }), ctx({ regimeAtExit: null })).regime.flipped, false);
  assert.match(reviewFacts(fill({ regime: null }), ctx({ regimeAtExit: null })).regime.text, /BTC regime unknown at entry, unknown at exit/);
});

test("variance vs deterioration: the R percentile places the trade; the rolling read decides the word", () => {
  const inside = reviewFacts(fill({ realNet: 26 }), ctx());   // 26/370 = +0.07R, mid-distribution
  assert.equal(inside.variance.verdict, "variance");
  assert.ok(inside.variance.rMultiple != null && Math.abs(inside.variance.rMultiple - 26 / 370) < 1e-9);
  assert.match(inside.variance.text, /inside the distribution, variance/);
  const tail = reviewFacts(fill({ realNet: -420 }), ctx());   // −1.14R, below every paper R
  assert.equal(tail.variance.verdict, "variance");
  assert.match(tail.variance.text, /tail outcome \(0th percentile of 40\)/);
  const decaying = reviewFacts(fill({ realNet: -420 }), ctx({ rolling: "DECAYING" }));
  assert.equal(decaying.variance.verdict, "deterioration");
  assert.match(decaying.variance.text, /rolling-30 read is DECAYING/);
  const cooling = reviewFacts(fill(), ctx({ rolling: "cooling" }));
  assert.equal(cooling.variance.verdict, "watch");
  const thin = reviewFacts(fill(), ctx({ sleeveRs: [0.5, -1, 0.2] }));
  assert.equal(thin.variance.verdict, "insufficient");
  assert.match(thin.variance.text, /3\/30 resolved paper trades/);
  const noRisk = reviewFacts(fill(), ctx({ intendedRiskUsd: null }));
  assert.equal(noRisk.variance.verdict, "insufficient");
  assert.equal(percentileOf(0.5, [0, 1, 2, 3]), 0.25);
  assert.equal(percentileOf(0.5, []), null);
});

test("behaved as paper: same sign and within max($25, 20%) of paper-at-live-size", () => {
  assert.equal(reviewFacts(fill({ realNet: 26, paperPnlAtLiveSize: 28 }), ctx()).behaved.ok, true);
  assert.equal(reviewFacts(fill({ realNet: 26, paperPnlAtLiveSize: -10 }), ctx()).behaved.ok, false, "opposite sign");
  assert.equal(reviewFacts(fill({ realNet: 300, paperPnlAtLiveSize: 500 }), ctx()).behaved.ok, false, "$200 short of paper on a $500 trade");
  assert.equal(reviewFacts(fill({ realNet: 420, paperPnlAtLiveSize: 500 }), ctx()).behaved.ok, true, "within 20%");
  const open = reviewFacts(fill({ paperPnlAtLiveSize: null }), ctx());
  assert.equal(open.behaved.ok, null);
  assert.match(open.behaved.text, /not resolved yet/);
});

test("the rendered review has the header, the YAML, the seven numbered answers, and NO parameter-change verbs without prose", () => {
  const r = reviewFacts(fill(), ctx());
  const md = renderReview(r, null, "skipped — no API key");
  assert.match(md, /^### Post-trade review — ETH\/USD long \(swing-pyr\) — OABC\n```yaml\n/);
  for (const key of ["txid:", "closed_at:", "behaved_as_paper: yes", "execution_ok: true", 'exit_kind: "trailing stop"', "mae_r: 0.30", 'size_band: "within ±10%"', "regime_flipped: false", 'verdict: "variance"', "twins: ["]) assert.ok(md.includes(key), key);
  for (let i = 1; i <= 7; i++) assert.match(md, new RegExp(`\\n${i}\\. \\*\\*`));
  assert.match(md, /_\(prose skipped — no API key\)_/);
  assert.doesNotMatch(md, FORBIDDEN_PROSE_RE, "the mechanical facts never propose a parameter change");
  // The one-liner that goes into the YAML rationale of logDecision.
  const line = reviewOneLiner(r);
  assert.match(line, /^ETH\/USD long \(swing-pyr\) closed \+\$26: behaved as paper yes · execution ok · trailing stop · size within ±10% · slippage none · regime held · variance$/);
  assert.doesNotMatch(line, FORBIDDEN_PROSE_RE);
  // With prose, the paragraph is quoted.
  assert.match(renderReview(r, "Variance. The trail banked a small green.", "sonnet"), /\n> Variance\. The trail banked a small green\.\n/);
});

test("prose rules: the forbidden verbs and the word budget", () => {
  assert.equal(proseAllowed("Variance. Fees took 58% of gross; the 2R trail sat at breakeven at a +1.24R peak by design."), true);
  assert.equal(proseAllowed("Deterioration. You should widen the stop to 6%."), false);
  assert.equal(proseAllowed("Consider whether to TIGHTEN the trail."), false);
  assert.equal(proseAllowed("Raise the risk to 10%."), false);
  assert.equal(proseAllowed("lower the hold"), false);
  assert.equal(proseAllowed("A future sleeve could test a wider stop."), true, "naming a future, separately registered test is allowed");
  assert.equal(proseAllowed(""), false);
  assert.equal(proseAllowed(null), false);
  assert.equal(proseAllowed(Array.from({ length: PROSE_MAX_WORDS + 1 }, () => "word").join(" ")), false);
  assert.equal(proseAllowed(Array.from({ length: PROSE_MAX_WORDS }, () => "word").join(" ")), true);
});
