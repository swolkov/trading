import assert from "node:assert/strict";
import test from "node:test";
import { REFUSAL_RE, refusalNote } from "../src/lib/margin-risk-tiers";
import { classifyRefusal } from "../src/lib/margin-capacity";

// The executor's new refusal strings are built by refusalNote and matched by REFUSAL_RE —
// one place, so the capacity ledger's classifier, the Slack lines and these tests can never
// disagree with the executor about what a refusal says.

test("every refusal builder produces a string its own regex matches", () => {
  const cases: [keyof typeof REFUSAL_RE, string][] = [
    ["ddUnknown", refusalNote.ddUnknown(null, 4611)],
    ["ddUnknown", refusalNote.ddUnknown("0", 4611)],
    ["ddHalt", refusalNote.ddHalt(15.3, 5140, 15)],
    ["revenge", refusalNote.revenge(2, 2)],
    ["decay", refusalNote.decay("0.2")],
    ["liqBuffer", refusalNote.liqBuffer(0.04, 12)],
    ["chainZero", refusalNote.chainZero(0.25, 0, 1)],
    ["eventWindow", refusalNote.eventWindow("FOMC rate decision at 18:00Z (in 15 min) — tier 1 within ±30 min")],
    ["eventUnreadable", refusalNote.eventUnreadable("connect ECONNREFUSED")],
    ["cluster", refusalNote.cluster(800, 800, 15, 10_000)],
    ["clusterCapInvalid", refusalNote.clusterCapInvalid("abc")],
    ["anomaly", refusalNote.anomaly("OABC: leverage 20 vs authorised 9")],
    ["anomalyUnreadable", refusalNote.anomalyUnreadable("boom")],
  ];
  for (const [k, note] of cases) assert.match(note, REFUSAL_RE[k], k);
  // The exact words, pinned.
  assert.equal(refusalNote.revenge(2, 2), "entry refused: 2 losing trades today — no revenge trades (max 2)");
  assert.equal(refusalNote.chainZero(0.25, 0, 1), "entry refused: risk chain sized to 0 (dd ×0.25, event ×0, decay ×1) — failing closed");
  assert.equal(refusalNote.ddUnknown(null, 4611), "entry refused: drawdown tier unknown — failing closed (kraken_margin_equity_peak=missing, equity $4611)");
  assert.equal(refusalNote.ddHalt(15.3, 5140, 15), "entry refused: drawdown 15.3% from peak $5140 is at/over the 15% halt — the breaker owns this, not a new entry");
  assert.equal(refusalNote.decay("0.2"), 'entry refused: kraken_margin_decay_multiplier "0.2" is outside 0.25–1 — failing closed');
  assert.match(refusalNote.liqBuffer(0.04, 12), /^entry refused: liquidation buffer 1\.25× the stop is under 1\.67× \(stop 4\.00% at 12×\)/);
  assert.equal(refusalNote.eventWindow("x"), "entry refused: event window — x");
});

test("the capacity ledger files each new refusal under its own kind, never 'other'", () => {
  assert.equal(classifyRefusal(null, refusalNote.eventWindow("FOMC rate decision at 18:00Z")), "event");
  assert.equal(classifyRefusal(null, refusalNote.revenge(2, 2)), "revenge");
  assert.equal(classifyRefusal(null, refusalNote.ddUnknown(null, 5000)), "drawdown");
  assert.equal(classifyRefusal(null, refusalNote.ddHalt(15.3, 5140, 15)), "drawdown");
  assert.equal(classifyRefusal(null, refusalNote.cluster(800, 800, 15, 10_000)), "cluster");
  // Not yet named kinds stay "other" — visibly, rather than mis-filed.
  assert.equal(classifyRefusal(null, refusalNote.decay("0.2")), "other");
  assert.equal(classifyRefusal(null, refusalNote.chainZero(1, 0.5, 0.5)), "other");
  assert.equal(classifyRefusal(null, refusalNote.eventUnreadable("x")), "other");
  // The old kinds are untouched.
  assert.equal(classifyRefusal(null, "entry refused: would leave margin level at 111% (floor 150%)"), "margin");
  assert.equal(classifyRefusal("OTXID", refusalNote.revenge(2, 2)), "taken", "a live txid always means taken");
});
