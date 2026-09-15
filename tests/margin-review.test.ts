import assert from "node:assert/strict";
import test from "node:test";
import {
  FORBIDDEN_PROSE_RE, PROSE_MAX_WORDS, REVIEW_MODEL_CHASE_BP, REVIEW_MODEL_FEE_PCT, REVIEW_MODEL_STOP_SLIP_BP,
  percentileOf, proseAllowed, renderReview, reviewFacts, reviewOneLiner, sizeBand, type ReviewContext, type ReviewFill,
} from "../src/lib/margin-review";
import { MODEL_CHASE_BP, MODEL_STOP_SLIP_BP, MODEL_TAKER_FEE_PCT } from "../src/lib/margin-synthesis";
import { REVIEW_DONE_KEY, REVIEW_MAX_PER_RUN, REVIEW_TWIN_SOURCES, planReviews, runPostTradeReviews } from "../src/lib/margin-review";
import { prisma } from "../src/lib/db";

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
  assert.match(all.stop.text, /every twin lost too: price went against the entry, not the stop width/);
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
  assert.equal(proseAllowed("Use a wider stop next time."), false, "an adjective-form proposal is still a parameter change");
  assert.equal(proseAllowed("Consider whether to move the trail closer."), false);
  assert.equal(proseAllowed("Set the hold to ten days."), false);
  assert.equal(proseAllowed("Reduce risk until the read is stable."), false);
  assert.equal(proseAllowed("A future sleeve could test the retest entry."), true, "naming a future, separately registered test is allowed");
  assert.equal(proseAllowed("The 2R trail sat at breakeven by design; fees were 58% of gross."), true);
  assert.equal(proseAllowed(""), false);
  assert.equal(proseAllowed(null), false);
  assert.equal(proseAllowed(Array.from({ length: PROSE_MAX_WORDS + 1 }, () => "word").join(" ")), false);
  assert.equal(proseAllowed(Array.from({ length: PROSE_MAX_WORDS }, () => "word").join(" ")), true);
});

test("the review compares against every swing twin, the Sep 15 ones included", () => {
  for (const s of ["swing-wide", "swing-lock", "swing-pyr", "swing-partial", "swing-atr", "swing-mtf", "swing-retest"]) assert.ok(REVIEW_TWIN_SOURCES.includes(s as never), s);
});

test("planReviews: the first run seeds every already-closed txid without reviewing; later runs take the oldest 5 not yet done", () => {
  const closed = (id: string, exitAt: string) => fill({ liveTxid: id, realExitAt: exitAt });
  const fills = [closed("O7", "2026-09-17T00:00:00Z"), closed("O3", "2026-09-13T00:00:00Z"), closed("O1", "2026-09-11T00:00:00Z"), closed("O5", "2026-09-15T00:00:00Z"), closed("O6", "2026-09-16T00:00:00Z"), closed("O2", "2026-09-12T00:00:00Z"), closed("O4", "2026-09-14T00:00:00Z"),
    fill({ liveTxid: "OPEN", realExitAt: null, realNet: null }), fill({ liveTxid: "ORT", source: "roundtrip" })];
  const first = planReviews(fills, null);
  assert.deepEqual(first.todo, [], "no reviews on the first run");
  assert.deepEqual([...first.seed].sort(), ["O1", "O2", "O3", "O4", "O5", "O6", "O7"], "every closed trip is seeded as done; open and round-trip fills are not");
  const later = planReviews(fills, new Set(["O1"]));
  assert.equal(REVIEW_MAX_PER_RUN, 5);
  assert.deepEqual(later.todo.map((f) => f.liveTxid), ["O2", "O3", "O4", "O5", "O6"], "oldest first, capped at 5, O1 already done");
  assert.deepEqual(later.seed, []);
  assert.deepEqual(planReviews(fills, new Set(["O1", "O2", "O3", "O4", "O5", "O6", "O7"])).todo, []);
});

// ---- the I/O contract, with prisma and the vault stubbed --------------------------------------
const restores: (() => void)[] = [];
function stub(object: object, key: string, value: unknown) { const prev = Reflect.get(object, key); Reflect.set(object, key, value); restores.push(() => Reflect.set(object, key, prev)); }
function restore() { while (restores.length) restores.pop()!(); }

function stubWorld(doneRaw: string | null, opts: { failOn?: string } = {}) {
  const cfg: Record<string, string> = {}; if (doneRaw != null) cfg[REVIEW_DONE_KEY] = doneRaw;
  const persisted: string[][] = []; const vaultWrites: string[] = [];
  stub(prisma.agentConfig, "findUnique", async ({ where }: { where: { key: string } }) => (cfg[where.key] != null ? { key: where.key, value: cfg[where.key] } : null));
  stub(prisma.agentConfig, "upsert", async ({ where, update }: { where: { key: string }; update: { value: string } }) => { cfg[where.key] = update.value; if (where.key === REVIEW_DONE_KEY) persisted.push(JSON.parse(update.value)); return null; });
  stub(prisma, "$queryRawUnsafe", async () => []);
  stub(prisma, "$executeRawUnsafe", async () => 0);
  stub(prisma.vaultDocument, "findUnique", async () => null);
  stub(prisma.vaultDocument, "upsert", async ({ where, create }: { where: { path: string }; create: { content: string } }) => {
    if (opts.failOn && create.content.includes(opts.failOn)) throw new Error("vault down");
    vaultWrites.push(`${where.path}: ${create.content}`); return null;
  });
  stub(globalThis, "fetch", async () => { throw new Error("no kraken in tests"); });
  return { cfg, persisted, vaultWrites };
}
const closedFill = (id: string, exitAt: string) => fill({ liveTxid: id, realExitAt: exitAt, realEntryAt: exitAt });

test("first run: every already-closed round trip is seeded into margin_review_done and NOTHING is reviewed", async () => {
  const w = stubWorld(null);
  try {
    const r = await runPostTradeReviews([closedFill("O1", "2026-09-11T00:00:00.000Z"), closedFill("O2", "2026-09-12T00:00:00.000Z")], { withProse: false });
    assert.deepEqual(r.reviewed, []); assert.equal(r.seeded, 2);
    assert.deepEqual(JSON.parse(w.cfg[REVIEW_DONE_KEY]).sort(), ["O1", "O2"]);
    assert.deepEqual(w.vaultWrites, [], "no Decisions/ entry for the backlog");
  } finally { restore(); }
});

test("later runs review the oldest 5 not done and persist the done-set after EACH fill — a failure mid-loop keeps the earlier ones done", async () => {
  const w = stubWorld("[]", { failOn: "O3" });
  const fills = ["O1", "O2", "O3", "O4", "O5", "O6", "O7"].map((id, i) => closedFill(id, `2026-09-1${i + 1}T00:00:00.000Z`));
  try {
    const r = await runPostTradeReviews(fills, { withProse: false });
    assert.deepEqual(r.reviewed, ["O1", "O2", "O4", "O5"], "5 attempted (O1..O5), O3 failed, O6/O7 wait for the next run");
    assert.equal(r.errors.length, 1); assert.match(r.errors[0], /^O3: /);
    assert.deepEqual(w.persisted, [["O1"], ["O1", "O2"], ["O1", "O2", "O4"], ["O1", "O2", "O4", "O5"]], "one persist per reviewed fill, in order");
    assert.ok(w.vaultWrites.some((v) => /^Decisions\/\d{4}-\d{2}-\d{2}\.md: [\s\S]*### D\w+\n```yaml\n[\s\S]*rationale: "ETH\/USD long \(swing-pyr\) closed/.test(v)), "logDecision wrote the one-liner");
    assert.ok(w.vaultWrites.some((v) => /### Post-trade review — ETH\/USD long \(swing-pyr\) — O1/.test(v)), "the full block follows");
    // The next run picks up O3, O6, O7 only.
    restore();
    const w2 = stubWorld(JSON.stringify(["O1", "O2", "O4", "O5"]));
    const r2 = await runPostTradeReviews(fills, { withProse: false });
    assert.deepEqual(r2.reviewed, ["O3", "O6", "O7"]);
    assert.deepEqual(w2.persisted[w2.persisted.length - 1].sort(), ["O1", "O2", "O3", "O4", "O5", "O6", "O7"]);
  } finally { restore(); }
});
