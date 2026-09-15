import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/lib/db";
import { DECAY_FULL_MULT, DECAY_MULT_KEY, DECAY_REDUCED_MULT, DECAY_STATE_KEY, applyDecay, decayTransition, type DecayState } from "../src/lib/margin-decay";
import { rollingVerdict, type SleeveRow } from "../src/lib/margin-metrics";
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

test("hysteresis: only `stable` restores, and only a 0.5 this rule wrote (ruleOwned); a hand-set 0.5 is never restored; cooling and insufficient keep 0.5", () => {
  assert.deepEqual(decayTransition("0.5", "stable", true), { next: "1", change: "RESTORED" });
  assert.deepEqual(decayTransition("0.5", "stable", false), { next: "0.5", change: null }, "a hand-set 0.5 is not this rule's to undo");
  assert.deepEqual(decayTransition("0.5", "stable"), { next: "0.5", change: null }, "ownership defaults to false — the caller must prove it");
  assert.deepEqual(decayTransition("0.5", "cooling", true), { next: "0.5", change: null }, "cooling keeps the reduction");
  assert.deepEqual(decayTransition("0.5", "insufficient", true), { next: "0.5", change: null });
  assert.deepEqual(decayTransition("1", "stable", true), { next: "1", change: null });
  assert.deepEqual(decayTransition(null, "stable", true), { next: null, change: null });
  assert.deepEqual(decayTransition("0.25", "stable", true), { next: "0.25", change: null }, "a hand-set 0.25 is not this rule's to undo");
  assert.deepEqual(decayTransition("garbage", "stable", true), { next: "garbage", change: null }, "an unreadable value stays visible (the executor refuses on it) rather than being silently repaired");
  assert.deepEqual(decayTransition("1", "cooling", true), { next: "1", change: null });
});

// ---- applyDecay against a stubbed config store: the release on a sleeve switch, the
// suppressed write when a demotion is about to fire, and ownership of the restore ----

const restores: (() => void)[] = [];
function stub(object: object, key: string, value: unknown) {
  const previous = Reflect.get(object, key);
  Reflect.set(object, key, value);
  restores.push(() => { Reflect.set(object, key, previous); });
}
function restore() { while (restores.length) restores.pop()!(); }
function fakeConfig(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  stub(prisma.agentConfig, "findUnique", async ({ where }: { where: { key: string } }) => (store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null));
  stub(prisma.agentConfig, "upsert", async ({ where, update }: { where: { key: string }; update: { value: string } }) => { store.set(where.key, update.value); return { key: where.key, value: update.value }; });
  return store;
}
const T0 = Date.parse("2026-09-01T00:00:00Z");
const rowsOf = (pnls: number[]): SleeveRow[] => pnls.map((pnl, i) => ({
  id: i + 1, source: "swing-pyr", side: "buy", time: new Date(T0 + i * 6 * 3600_000).toISOString(), resolvedAt: new Date(T0 + i * 6 * 3600_000 + 4 * 3600_000).toISOString(),
  entry: 100, exit: 100 + pnl / 25, pnl, livePnl: pnl, fees: 5, notional: 2500, riskUsd: 100, peak: 101, trough: null, oneR: 4, reason: null, conviction: "high",
}));
const decaying = rollingVerdict(rowsOf([...Array.from({ length: 60 }, (_, i) => 50 + (i % 2 ? 10 : -10)), ...Array.from({ length: 30 }, (_, i) => -40 + (i % 2 ? 10 : -10))]));
const stableRead = rollingVerdict(rowsOf(Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -100 : 90))));
const prevState = (o: Partial<DecayState>): DecayState => ({ source: "swing-pyr", state: "DECAYING", at: "2026-09-19T08:00:00.000Z", welchT: -2.4, last30Net: -400, lastExpectancy: -13, priorExpectancy: 50, reducedAt: "2026-09-19T08:00:00.000Z", note: "n", ...o });

test("a sleeve switch releases a reduction the rule wrote for the previous sleeve, and the new sleeve's record decides from there", async () => {
  assert.equal(decaying.state, "DECAYING"); assert.equal(stableRead.state, "stable");
  const store = fakeConfig({ kraken_margin_decay_multiplier: "0.5", kraken_margin_arm_log: "[]" });
  try {
    const run = await applyDecay({ source: "swing-pyr", rolling: stableRead, current: "0.5", prev: prevState({ source: "swing-lev" }) });
    assert.equal(run.released, true);
    assert.equal(run.change, null, "the new sleeve is stable — no further transition");
    assert.equal(store.get("kraken_margin_decay_multiplier"), "1");
    assert.match(store.get("kraken_margin_arm_log") ?? "", /sleeve changed \(swing-lev → swing-pyr\) — decay reduction released/);
    const st = JSON.parse(store.get("kraken_margin_decay_state") ?? "{}") as DecayState;
    assert.equal(st.source, "swing-pyr"); assert.equal(st.reducedAt, undefined);
    // …and if the new sleeve is itself DECAYING, it is reduced on its own record in the same tick.
    const store2 = fakeConfig({ kraken_margin_decay_multiplier: "0.5", kraken_margin_arm_log: "[]" });
    const run2 = await applyDecay({ source: "swing-pyr", rolling: decaying, current: "0.5", prev: prevState({ source: "swing-lev" }) });
    assert.equal(run2.released, true); assert.equal(run2.change, "REDUCED");
    assert.equal(store2.get("kraken_margin_decay_multiplier"), "0.5");
    assert.ok(JSON.parse(store2.get("kraken_margin_decay_state")!).reducedAt);
  } finally { restore(); }
});

test("suppressReduce (a demotion is firing this tick) skips the 0.5 write and records no reducedAt", async () => {
  const store = fakeConfig({ kraken_margin_decay_multiplier: "1", kraken_margin_arm_log: "[]" });
  try {
    const run = await applyDecay({ source: "swing-pyr", rolling: decaying, current: "1", prev: null }, { suppressReduce: true });
    assert.equal(run.change, null); assert.equal(run.multiplier, "1");
    assert.equal(store.get("kraken_margin_decay_multiplier"), "1");
    assert.doesNotMatch(store.get("kraken_margin_arm_log") ?? "", /REDUCED/);
    const st = JSON.parse(store.get("kraken_margin_decay_state") ?? "{}") as DecayState;
    assert.equal(st.state, "DECAYING"); assert.equal(st.reducedAt, undefined);
    const run2 = await applyDecay({ source: "swing-pyr", rolling: decaying, current: "1", prev: null });
    assert.equal(run2.change, "REDUCED"); assert.equal(store.get("kraken_margin_decay_multiplier"), "0.5");
    assert.match(store.get("kraken_margin_arm_log") ?? "", /REDUCED to 0\.5× risk: swing-pyr is DECAYING/);
  } finally { restore(); }
});

test("restore needs the rule's own reducedAt: a hand-set 0.5 stays; a rule-owned 0.5 restores on stable and carries reducedAt through cooling", async () => {
  const store = fakeConfig({ kraken_margin_decay_multiplier: "0.5", kraken_margin_arm_log: "[]" });
  try {
    const hand = await applyDecay({ source: "swing-pyr", rolling: stableRead, current: "0.5", prev: prevState({ reducedAt: undefined, state: "stable" }) });
    assert.equal(hand.change, null); assert.equal(store.get("kraken_margin_decay_multiplier"), "0.5");
    const owned = await applyDecay({ source: "swing-pyr", rolling: stableRead, current: "0.5", prev: prevState({}) });
    assert.equal(owned.change, "RESTORED"); assert.equal(store.get("kraken_margin_decay_multiplier"), "1");
    assert.match(store.get("kraken_margin_arm_log") ?? "", /RESTORED to 1× risk: swing-pyr's rolling read is stable again/);
    const cooling = { ...decaying, state: "cooling" as const };
    const store3 = fakeConfig({ kraken_margin_decay_multiplier: "0.5", kraken_margin_arm_log: "[]" });
    const kept = await applyDecay({ source: "swing-pyr", rolling: cooling, current: "0.5", prev: prevState({}) });
    assert.equal(kept.change, null); assert.equal(store3.get("kraken_margin_decay_multiplier"), "0.5");
    assert.equal(JSON.parse(store3.get("kraken_margin_decay_state")!).reducedAt, "2026-09-19T08:00:00.000Z", "ownership survives a cooling tick");
  } finally { restore(); }
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
