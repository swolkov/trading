import assert from "node:assert/strict";
import test from "node:test";
import { DECAY_FULL_MULT, DECAY_MULT_KEY, DECAY_REDUCED_MULT, DECAY_STATE_KEY, decayTransition } from "../src/lib/margin-decay";
import { demotionVerdict, divergenceSummary } from "../src/lib/margin-synthesis";
import { renderWeeklyMemo } from "../src/lib/margin-weekly";
import { REFUSAL_RE, parseDecayMultiplier } from "../src/lib/margin-risk-tiers";

// REDUCE before demote. The transition is pure and pinned here; the I/O around it writes the
// one key the executor's multiplier chain already reads.

test("the keys and values the executor reads: 0.5 and 1 both parse; 0.5 is inside the chain's 0.25–1 window", () => {
  assert.equal(DECAY_MULT_KEY, "kraken_margin_decay_multiplier");
  assert.equal(DECAY_STATE_KEY, "kraken_margin_decay_state");
  assert.equal(parseDecayMultiplier(DECAY_REDUCED_MULT), 0.5);
  assert.equal(parseDecayMultiplier(DECAY_FULL_MULT), 1);
  assert.ok(REFUSAL_RE.decay.test('entry refused: kraken_margin_decay_multiplier "0" is outside 0.25–1 — failing closed'));
});

test("DECAYING writes 0.5 once: from 1, from missing, from a hand-set 0.7 — and not again when already 0.5", () => {
  assert.deepEqual(decayTransition("1", "DECAYING"), { next: "0.5", change: "REDUCED" });
  assert.deepEqual(decayTransition(null, "DECAYING"), { next: "0.5", change: "REDUCED" });
  assert.deepEqual(decayTransition("", "DECAYING"), { next: "0.5", change: "REDUCED" });
  assert.deepEqual(decayTransition("0.7", "DECAYING"), { next: "0.5", change: "REDUCED" });
  assert.deepEqual(decayTransition("0.5", "DECAYING"), { next: "0.5", change: null }, "already reduced — no second page");
  assert.deepEqual(decayTransition("0.50", "DECAYING"), { next: "0.5", change: null });
  assert.deepEqual(decayTransition("garbage", "DECAYING"), { next: "0.5", change: "REDUCED" }, "an unreadable value is replaced by the safe one on a DECAYING read");
});

test("hysteresis: only `stable` restores, and only from the 0.5 this rule wrote; cooling and insufficient keep 0.5", () => {
  assert.deepEqual(decayTransition("0.5", "stable"), { next: "1", change: "RESTORED" });
  assert.deepEqual(decayTransition("0.5", "cooling"), { next: "0.5", change: null }, "cooling keeps the reduction");
  assert.deepEqual(decayTransition("0.5", "insufficient"), { next: "0.5", change: null });
  assert.deepEqual(decayTransition("1", "stable"), { next: "1", change: null });
  assert.deepEqual(decayTransition(null, "stable"), { next: null, change: null });
  assert.deepEqual(decayTransition("0.25", "stable"), { next: "0.25", change: null }, "a hand-set 0.25 is not this rule's to undo");
  assert.deepEqual(decayTransition("garbage", "stable"), { next: "garbage", change: null }, "an unreadable value stays visible (the executor refuses on it) rather than being silently repaired");
  assert.deepEqual(decayTransition("1", "cooling"), { next: "1", change: null });
});

test("third demotion rule: DECAYING and last-30 net ≤ 0 → demote; DECAYING but still paying → keep (REDUCE only); the older cases are unchanged", () => {
  const tracking = { closed: 3, verdict: "live tracking paper so far (3/20 closed trades reconciled)" };
  const paying = { resolved: 40, net: 2100 };
  assert.match(
    demotionVerdict(paying, tracking, { state: "DECAYING", welchT: -2.6, lastNet: -420, window: 30 }) ?? "",
    /the rolling-30 record has decayed \(Welch t=-2\.60\) and is not paying: last 30 net −\$420 \(rule: DECAYING and ≤ \$0\)/,
  );
  assert.match(demotionVerdict(paying, tracking, { state: "DECAYING", welchT: -2.1, lastNet: 0 }) ?? "", /last 30 net \$0/);
  assert.equal(demotionVerdict(paying, tracking, { state: "DECAYING", welchT: -2.3, lastNet: 15 }), null, "decaying but the window is still positive → REDUCE, not demote");
  assert.equal(demotionVerdict(paying, tracking, { state: "cooling", welchT: -1.2, lastNet: -900 }), null, "cooling never demotes");
  assert.equal(demotionVerdict(paying, tracking, { state: "stable", welchT: 0.3, lastNet: -900 }), null);
  assert.equal(demotionVerdict(paying, tracking, null), null);
  assert.equal(demotionVerdict(paying, tracking), null);
  // Rule 1 still wins first, with the same words.
  assert.match(demotionVerdict({ resolved: 30, net: 0 }, tracking, { state: "DECAYING", welchT: -3, lastNet: -50 }) ?? "", /^the forward-only paper record is not paying/);
});

test("the Monday memo says when live risk is reduced, when the multiplier is unreadable, and stays quiet at 1×", () => {
  const base = { at: "2026-09-21T13:00:00.000Z", live: { armed: true, sources: ["swing-pyr"], equity: 4700, equityPeak: 5140 }, stage3: null, demoted: null, fills: [], div: divergenceSummary([]), strategies: [], candidate: null, capacity: null };
  const reduced = renderWeeklyMemo({ ...base, decay: { multiplier: "0.5", state: { source: "swing-pyr", state: "DECAYING", at: "2026-09-21T12:55:00.000Z", welchT: -2.4, last30Net: 120, lastExpectancy: 4, priorExpectancy: 95, reducedAt: "2026-09-19T08:05:00.000Z", note: "last 30: $4/trade vs $95/trade before (Welch t=-2.40 ≤ -2)" } } });
  assert.match(reduced, /⚠️ Risk multiplier: \*\*0\.5× since 2026-09-19 08:05 UTC\*\* \(decaying: last 30: \$4\/trade vs \$95\/trade before/);
  const bad = renderWeeklyMemo({ ...base, decay: { multiplier: "0", state: null } });
  assert.match(bad, /⛔ Risk multiplier: \*\*unreadable\*\* \(kraken_margin_decay_multiplier="0"\)/);
  const full = renderWeeklyMemo({ ...base, decay: { multiplier: null, state: { source: "swing-pyr", state: "stable", at: "2026-09-21T12:55:00.000Z", welchT: 0.4, last30Net: 900, lastExpectancy: 30, priorExpectancy: 28, note: "last 30: $30/trade vs $28/trade before (Welch t=0.40)" } } });
  assert.match(full, /- Risk multiplier: 1× · rolling stable · read 2026-09-21 12:55 UTC/);
  assert.doesNotMatch(full, /⚠️ Risk multiplier/);
  const none = renderWeeklyMemo(base);
  assert.doesNotMatch(none, /Risk multiplier/);
});
