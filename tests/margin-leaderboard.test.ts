import assert from "node:assert/strict";
import test from "node:test";
import { PROMOTION_MIN_PF, promotionVerdict, type PromotionInput } from "../src/lib/margin-leaderboard";
import { LIVE_RESCALE_SQL, RECORD_SQL } from "../src/lib/margin-shadow";
import { liveContainerFor } from "../src/lib/margin-live-risk";

// The explicit live gate. Eight named gates in a fixed order; `ready` needs every one of them;
// the stage names the first thing that is missing. Each case flips ONE gate on an otherwise
// green sleeve, so a regression in any single rule shows up by name.

const green: PromotionInput = {
  source: "swing-pyr", forwardResolved: 34, liveNet: 1840, tStat: 2.31, days: 11,
  maxDDPct: 0.082, breakerPct: 15, profitFactor: 1.9, rolling: "stable", hasContainer: true,
};

test("every gate green → PROMOTE-READY, ready, no failures, eight gates in order", () => {
  const v = promotionVerdict(green);
  assert.equal(v.ready, true);
  assert.equal(v.stage, "PROMOTE-READY");
  assert.deepEqual(v.failed, []);
  assert.equal(v.note, "Real edge — gate open");
  assert.deepEqual(v.gates.map((g) => g.name), [
    "Forward resolved trades", "Net at live sizing", "Confidence (t)", "Distinct days",
    "Max drawdown (live series)", "Profit factor", "Rolling record", "Live container",
  ]);
  assert.ok(v.gates.every((g) => g.ok));
  assert.equal(v.gates[4].value, "8.2%"); assert.equal(v.gates[4].target, "≤ 15% (the breaker)");
  assert.equal(v.gates[5].value, "1.90"); assert.equal(v.gates[5].target, "≥ 1.2");
});

test("each gate, flipped alone, closes the gate and is named in `failed`", () => {
  const cases: [Partial<PromotionInput>, string, string][] = [
    [{ forwardResolved: 29 }, "Forward resolved trades", "gathering"],
    [{ liveNet: 0 }, "Net at live sizing", "not paying"],
    [{ liveNet: -12 }, "Net at live sizing", "not paying"],
    [{ tStat: 1.99 }, "Confidence (t)", "promising"],
    [{ tStat: null }, "Confidence (t)", "promising"],
    [{ days: 6 }, "Distinct days", "promising"],
    [{ maxDDPct: 0.151 }, "Max drawdown (live series)", "promising"],
    [{ maxDDPct: null }, "Max drawdown (live series)", "promising"],
    [{ profitFactor: 1.19 }, "Profit factor", "promising"],
    [{ profitFactor: null }, "Profit factor", "promising"],
    [{ rolling: "DECAYING" }, "Rolling record", "REDUCE"],
    [{ hasContainer: false }, "Live container", "PAPER-ONLY"],
  ];
  for (const [patch, name, stage] of cases) {
    const v = promotionVerdict({ ...green, ...patch });
    assert.equal(v.ready, false, `${name} should close the gate`);
    assert.deepEqual(v.failed, [name]);
    assert.equal(v.stage, stage, name);
    assert.equal(v.gates.filter((g) => g.ok).length, 7);
  }
  assert.equal(promotionVerdict({ ...green, maxDDPct: 0.15 }).ready, true, "exactly at the breaker still passes (≤)");
  assert.equal(promotionVerdict({ ...green, profitFactor: PROMOTION_MIN_PF }).ready, true, "exactly 1.2 passes (≥)");
  assert.equal(promotionVerdict({ ...green, profitFactor: Infinity }).gates[5].value, "∞");
  assert.equal(promotionVerdict({ ...green, rolling: "cooling" }).ready, true, "cooling is not a gate — only DECAYING blocks");
  assert.equal(promotionVerdict({ ...green, rolling: "insufficient" }).ready, true);
});

test("PAPER-ONLY beats PROMOTE-READY without a container — and says what it needs", () => {
  const v = promotionVerdict({ ...green, source: "swing-lock", hasContainer: false });
  assert.equal(v.ready, false);
  assert.equal(v.stage, "PAPER-ONLY");
  assert.equal(v.note, "PAPER-ONLY — needs a guardian-mirrored container");
  assert.equal(liveContainerFor("swing-lock"), null, "swing-lock really has no container");
  assert.ok(liveContainerFor("swing-pyr") != null);
});

test("DECAYING blocks even a REAL-EDGE record, and outranks the softer shortfalls in the stage", () => {
  const v = promotionVerdict({ ...green, rolling: "DECAYING" });
  assert.equal(v.ready, false); assert.equal(v.stage, "REDUCE");
  assert.match(v.note, /REDUCE — the rolling-30 record is decaying/);
  // Decay is judged after sample and net (a sleeve that is not paying is "not paying", not REDUCE)
  assert.equal(promotionVerdict({ ...green, rolling: "DECAYING", liveNet: -50 }).stage, "not paying");
  // …but before the t / days / PF shortfalls and before the container question.
  assert.equal(promotionVerdict({ ...green, rolling: "DECAYING", tStat: 1.2 }).stage, "REDUCE");
  assert.equal(promotionVerdict({ ...green, rolling: "DECAYING", hasContainer: false }).stage, "REDUCE");
});

test("the stage ladder and the 'N of 8 green' note", () => {
  assert.equal(promotionVerdict({ ...green, forwardResolved: 0, liveNet: 0, tStat: null, days: 0, maxDDPct: null, profitFactor: null, rolling: "insufficient" }).stage, "gathering");
  const v = promotionVerdict({ ...green, tStat: 1.5, days: 4 });
  assert.equal(v.stage, "promising");
  assert.equal(v.note, "6 of 8 green");
  const r = promotionVerdict({ ...green, retired: true });
  assert.equal(r.ready, false); assert.equal(r.stage, "retired");
});

test("LIVE_RESCALE_SQL is the one paper→live factor, bound to $1 (live base) and $2 (paper base)", () => {
  assert.match(LIVE_RESCALE_SQL, /^\(LEAST\(6\.0, \$1::float \* CASE conviction WHEN 'high' THEN 2\.0 WHEN 'low' THEN 0\.5 ELSE 1\.0 END\)/);
  assert.match(LIVE_RESCALE_SQL, /\/ LEAST\(6\.0, \$2::float \* CASE conviction WHEN 'high' THEN 2\.0 WHEN 'low' THEN 0\.5 ELSE 1\.0 END\)\)$/);
  assert.match(RECORD_SQL, /sim_version='v2'/);
});
