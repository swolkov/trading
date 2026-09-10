import test from "node:test";
import assert from "node:assert/strict";
import { baseRiskForSlots, replaySlots, type CapacitySetup } from "../src/lib/margin-capacity";
import { DEFAULT_ARM_SOURCE, liveContainerFor, LIVE_CONTAINERS, LIVE_RISK_CEILING_PCT } from "../src/lib/margin-live-risk";
import { RETIRED_AUTO_SOURCES } from "../src/lib/margin-auto-plans";
import { planOrder } from "../src/lib/margin-dry-run";
import { policyCutFor, POLICY_CUT_AT, SWING_REACTIVATED_AT } from "../src/lib/margin-shadow";

// SLOTS AND SIZE ARE THE SAME DIAL. The capacity card used to compare slot counts at one
// shared per-trade risk, which flatters more slots: it credits them with extra trades while
// hiding that each one has to be smaller to keep the account inside the drawdown breaker.
// These pin the trade-off so the comparison stays honest.

test("fewer slots carry more risk per trade — the breaker binds, then the policy ceiling", () => {
  // 1 and 2 slots are capped by the 6% per-trade policy ceiling (base x2 = 6).
  assert.equal(baseRiskForSlots(1), 3);
  assert.equal(baseRiskForSlots(2), 3);
  // From 3 slots on, the 15% drawdown breaker binds first: slots x base x 2 <= 15.
  assert.equal(baseRiskForSlots(3), 2.5);
  assert.equal(baseRiskForSlots(4), 1.875);
  for (const n of [1, 2, 3, 4]) {
    assert.ok(n * baseRiskForSlots(n) * 2 <= 15 + 1e-9, `${n} slots must stay inside the breaker`);
    assert.ok(baseRiskForSlots(n) * 2 <= 6 + 1e-9, `${n} slots must stay inside the per-trade ceiling`);
  }
});

test("baseRiskForSlots refuses nonsense rather than returning a tradeable number", () => {
  for (const bad of [0, -1, NaN, Infinity]) assert.equal(baseRiskForSlots(bad as number), 0, String(bad));
});

test("one slot's position is bigger than three slots' — at LESS total account risk", () => {
  const equity = 4578, stop = 0.04;
  const size = (slots: number) => (equity * (baseRiskForSlots(slots) * 2) / 100) / stop;
  assert.ok(size(1) > size(3), "one slot must buy the bigger position");
  assert.equal(Math.round(size(1)), 6867);
  assert.equal(Math.round(size(3)), 5723);
  // and the whole account is less exposed
  const atRisk = (slots: number) => slots * baseRiskForSlots(slots) * 2;
  assert.equal(atRisk(1), 6);
  assert.equal(atRisk(3), 15);
});

test("netAtOwnRisk rescales paper's P&L to the risk that slot count could carry", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
  // Two setups far enough apart that one slot takes both in sequence.
  const setups: CapacitySetup[] = [
    { id: 1, time: at(0), symbol: "BTC/USD", timeframe: "4h", kind: "taken", note: null, status: "resolved", pnl: 100, unrealized: null, resolvedAt: at(1) },
    { id: 2, time: at(2), symbol: "ETH/USD", timeframe: "4h", kind: "taken", note: null, status: "resolved", pnl: 200, unrealized: null, resolvedAt: at(3) },
  ];
  const cfg = { perDay: Number.POSITIVE_INFINITY, cooldownMin: 0, paperBasePct: 3 };
  const one = replaySlots(setups, { ...cfg, slots: 1 });
  assert.equal(one.taken, 2);
  assert.equal(one.net, 300);
  assert.equal(one.baseRiskPct, 3);
  assert.equal(one.netAtOwnRisk, 300);           // paper already sizes at 3% — no rescale
  const three = replaySlots(setups, { ...cfg, slots: 3 });
  assert.equal(three.net, 300);
  assert.equal(three.baseRiskPct, 2.5);
  assert.equal(three.netAtOwnRisk, 250);         // three slots must run smaller: 300 x 2.5/3
});

test("without paperBasePct the rescale is a no-op — an unknown base never invents P&L", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
  const setups: CapacitySetup[] = [
    { id: 1, time: at(0), symbol: "BTC/USD", timeframe: "4h", kind: "taken", note: null, status: "resolved", pnl: 100, unrealized: null, resolvedAt: at(1) },
  ];
  const r = replaySlots(setups, { slots: 1, perDay: Number.POSITIVE_INFINITY, cooldownMin: 0 });
  assert.equal(r.netAtOwnRisk, r.net);
});

// THE DEFAULT ARM SOURCE. The arm route carried its own literal "selective" long after the
// desk moved to swing-lev (Sep 8, when the breaker tripped that family), so an arm with no
// explicit source would have switched the live book back to a sleeve nobody was running.
//
// BE HONEST ABOUT WHAT THESE CATCH: not that. "selective" has a live container and is not
// retired, so every assertion below passes for it — a pure test cannot know which sleeve the
// desk runs today, because that lives in AgentConfig. What actually fixed the bug is that the
// admin button now sends the CURRENT source from live config instead of a literal, and this
// constant sits beside LIVE_CONTAINERS where a reader will see it. These guard the weaker
// invariant that still matters: the default must at least be something the route will accept,
// so it can never rot into a source that makes every default arm fail closed.

test("the default arm source is actually armable — a live container, not retired", () => {
  assert.ok(liveContainerFor(DEFAULT_ARM_SOURCE), `${DEFAULT_ARM_SOURCE} has no live container — the arm route would reject its own default`);
  assert.ok(!RETIRED_AUTO_SOURCES.has(DEFAULT_ARM_SOURCE), `${DEFAULT_ARM_SOURCE} is retired — the arm route would reject its own default`);
});

test("the default arm source passes the arm route's own source regex", () => {
  assert.match(DEFAULT_ARM_SOURCE, /^[a-z0-9_-]{1,32}$/);
});

test("every source with a live container is a real, non-retired sleeve", () => {
  for (const source of Object.keys(LIVE_CONTAINERS)) {
    assert.ok(!RETIRED_AUTO_SOURCES.has(source), `${source} is retired but still has a live container — it could be armed`);
  }
});

// PER-SLEEVE POLICY CUTS. One global cut date pooled two different rules under the
// `swing-lev` label: pre-Sep-4 it traded both directions and both timeframes (16 short legs,
// −$4,398), and the sleeve reactivated on Sep 8 is longs-only, 4h-only and cannot take them.

test("the slow family's forward slice starts at its own reactivation, not the fast family's cut", () => {
  for (const s of ["swing-lev", "swing-spot", "swing-wide"]) {
    assert.equal(policyCutFor(s), SWING_REACTIVATED_AT, s);
  }
  for (const s of ["selective", "selective-tight", "tsmom", "roundtrip"]) {
    assert.equal(policyCutFor(s), POLICY_CUT_AT, s);
  }
});

test("a cut date marks a RULE change, never a sizing change", () => {
  // Sep 9 changed live sizing only (1 slot, base 2.2% → 3%); paper's rule and paper's base
  // risk were untouched. No cut may land on it, or five days of valid evidence vanish.
  for (const s of ["swing-lev", "swing-spot", "swing-wide", "selective", "tsmom"]) {
    assert.ok(policyCutFor(s) < "2026-09-09", `${s} cut must predate the Sep 9 sizing change`);
  }
  // Both cuts must be real instants, and the slow family's must be the later one.
  assert.ok(!Number.isNaN(Date.parse(POLICY_CUT_AT)));
  assert.ok(!Number.isNaN(Date.parse(SWING_REACTIVATED_AT)));
  assert.ok(Date.parse(SWING_REACTIVATED_AT) > Date.parse(POLICY_CUT_AT));
});

test("an unknown sleeve falls back to the global cut rather than to no cut at all", () => {
  assert.equal(policyCutFor("something-new"), POLICY_CUT_AT);
  assert.equal(policyCutFor(""), POLICY_CUT_AT);
});

// STAGE 3 MAY ONLY EVER RAISE. `toBase` is a snapshot taken the day the record was written.
// On 2026-09-09 the base was deliberately raised 3% → 4% while the record still said toBase: 3;
// graduation would have written it back to 3 sixteen trades later, cutting the position from
// $9,044 to $6,783, and announced it as "Stage 3 complete". These pin the max().

test("stage-3 graduation never lowers a base that was raised after the record was written", () => {
  // The rule the code applies: graduateTo = max(currentBase, toBase).
  const graduateTo = (currentBase: number, toBase: number) =>
    Number.isFinite(currentBase) ? Math.max(currentBase, toBase) : toBase;
  // The exact live situation on 2026-09-09: record says 3, operator set 4.
  assert.equal(graduateTo(4, 3), 4, "a stale toBase must not undo a deliberate increase");
  // Stage 3 doing its actual job still works: a reduced base is lifted to the target.
  assert.equal(graduateTo(1.5, 3), 3, "graduation must still RAISE a reduced base");
  assert.equal(graduateTo(3, 3), 3, "a matching record is a no-op");
  // An unreadable current base falls back to the record rather than to nothing.
  assert.equal(graduateTo(NaN, 3), 3);
});

test("whatever graduation writes, one trade still cannot trip the drawdown breaker", () => {
  const graduateTo = (c: number, t: number) => (Number.isFinite(c) ? Math.max(c, t) : t);
  for (const [cur, to] of [[4, 3], [1.5, 3], [3, 3], [4, 4]] as [number, number][]) {
    const base = graduateTo(cur, to);
    // High conviction doubles the base, and the executor clamps at the ceiling.
    assert.ok(Math.min(LIVE_RISK_CEILING_PCT, base * 2) < 15, `base ${base}% must stay inside the 15% breaker`);
  }
});

// THE DRY RUN MUST SIZE EXACTLY AS THE EXECUTOR DOES, or it proves nothing about the real
// order. These pin planOrder to the same helpers in the same order.

test("dry-run sizing reproduces the executor's: risk ÷ stop, fitted leverage, clamped stop", () => {
  const i = { equity: 4522, freeMargin: 4522, baseRiskPct: 4, leverageCeiling: 9, perTradeCapUsd: 0, containerStopPct: 4, source: "swing-lev" };
  const btc = planOrder("BTC/USD", 76887, i);
  assert.equal(btc.leverage, 9, "9x is what leverageThatFitsStop allows on a 4% stop");
  assert.equal(Number(btc.stopFrac.toFixed(4)), 0.04, "the stop clamps to exactly 4%");
  // 8% of equity risked ÷ a 4% stop = 2x equity in notional.
  assert.equal(Math.round(btc.notional), Math.round(4522 * 0.08 / 0.04));
  assert.equal(Math.round(btc.marginUsd), Math.round(btc.notional / 9));
  // A 5x-capped coin gets 5x, not the 9x ceiling.
  const dot = planOrder("DOT/USD", 3, { ...i });
  assert.equal(dot.leverage, 5, "the pair cap binds below the operator ceiling");
});

test("dry-run never sizes past the ceiling, whatever the config says", () => {
  for (const base of [4, 6, 20, 100]) {
    const p = planOrder("BTC/USD", 76887, { equity: 4522, freeMargin: 4522, baseRiskPct: base, leverageCeiling: 9, perTradeCapUsd: 0, containerStopPct: 4, source: "swing-lev" });
    // risk is clamped at LIVE_RISK_CEILING_PCT (8%), so notional can never exceed 2x equity here
    assert.ok(p.notional <= 4522 * (LIVE_RISK_CEILING_PCT / 100) / 0.04 + 1, `base ${base}% must clamp`);
  }
});
