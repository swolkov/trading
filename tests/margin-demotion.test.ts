import assert from "node:assert/strict";
import test from "node:test";
import { DEMOTION_MIN_CLOSED_LIVE, DEMOTION_MIN_RESOLVED, demotionVerdict } from "../src/lib/margin-synthesis";

// The kill criteria that fire by themselves (pre-registered Sep 7 2026). They must fire on
// exactly the two conditions and stay silent on everything else — a false demotion costs a
// human re-arm; a missed one costs real money.

const tracking = { closed: 3, verdict: "live tracking paper so far (3/20 closed trades reconciled)" };
const diverges = (closed: number) => ({ closed, verdict: "LIVE DIVERGES FROM PAPER — entry slippage 40bp vs 10bp modelled. Stop and recalibrate the paper model before scaling." });

test("forward record not paying at 30+ resolved → demote; fewer trades or positive net → keep", () => {
  assert.equal(demotionVerdict({ resolved: 29, net: -500 }, tracking), null, "sample too small");
  assert.match(demotionVerdict({ resolved: 30, net: 0 }, tracking) ?? "", /forward-only paper record is not paying: 30 resolved, net \$0/);
  assert.match(demotionVerdict({ resolved: 41, net: -812 }, tracking) ?? "", /net −\$812/);
  assert.equal(demotionVerdict({ resolved: 60, net: 1 }, tracking), null, "positive net keeps running");
  assert.equal(demotionVerdict(null, tracking), null, "no forward slice yet → nothing to judge");
  assert.equal(DEMOTION_MIN_RESOLVED, 30);
});

test("live diverging from paper demotes only after enough closed live trades", () => {
  assert.equal(demotionVerdict({ resolved: 15, net: 2349 }, diverges(4)), null, "4 closed is too early to call divergence");
  assert.match(demotionVerdict({ resolved: 15, net: 2349 }, diverges(5)) ?? "", /live diverges from paper after 5 closed live trades/);
  assert.equal(demotionVerdict({ resolved: 15, net: 2349 }, { closed: 25, verdict: "live matches paper on 20+ trades — stage 3 reconciliation passed" }), null);
  assert.equal(DEMOTION_MIN_CLOSED_LIVE, 5);
});

test("today's desk (Sep 7 2026) is not demoted", () => {
  assert.equal(demotionVerdict({ resolved: 15, net: 2349 }, { closed: 2, verdict: "live tracking paper so far (2/20 closed trades reconciled)" }), null);
});
