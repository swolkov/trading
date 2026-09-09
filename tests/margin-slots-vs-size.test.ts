import test from "node:test";
import assert from "node:assert/strict";
import { baseRiskForSlots, replaySlots, type CapacitySetup } from "../src/lib/margin-capacity";
import { DEFAULT_ARM_SOURCE, liveContainerFor, LIVE_CONTAINERS } from "../src/lib/margin-live-risk";
import { RETIRED_AUTO_SOURCES } from "../src/lib/margin-auto-plans";

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
