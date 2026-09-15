import assert from "node:assert/strict";
import test from "node:test";
import {
  DD_TIERS,
  DEFAULT_DD_HALT_PCT,
  LIQ_BUFFER_MULT,
  LIQ_STOP_ALLOWANCE,
  SETUP_GRADE_PCT,
  drawdownTier,
  liqBufferMultiple,
  liqBufferOk,
  liveRiskPctChain,
  losersToday,
  parseDecayMultiplier,
  revengePauseHit,
  setupGradeFor,
  tieredRiskPct,
} from "../src/lib/margin-risk-tiers";
import { LIVE_CONTAINERS, LIVE_RISK_CEILING_PCT, STOP_CUSHION_FRACTION, clampLiveStopFrac, leverageThatFitsStop, liveRiskPct } from "../src/lib/margin-live-risk";

// ---- drawdown tiers ----

test("tier boundaries: 4.99 → tier 0 ×1, 5 → ×0.5, 10 → ×0.25, halt at the breaker, unknown on garbage", () => {
  assert.deepEqual(DD_TIERS, [{ ddPct: 5, mult: 0.5 }, { ddPct: 10, mult: 0.25 }]);
  const at = (ddPct: number) => drawdownTier(10_000, 10_000 * (1 - ddPct / 100));
  assert.deepEqual(at(0), { dd: 0, tier: 0, mult: 1 });
  assert.equal(at(4.99).tier, 0); assert.equal(at(4.99).mult, 1);
  assert.equal(at(5).tier, 1); assert.equal(at(5).mult, 0.5);
  assert.equal(at(9.99).tier, 1);
  assert.equal(at(10).tier, 2); assert.equal(at(10).mult, 0.25);
  assert.equal(at(14.99).tier, 2);
  assert.equal(at(15).tier, "halt"); assert.equal(at(15).mult, 0);
  assert.equal(drawdownTier(10_000, 8_000, 25).tier, 2, "the halt line is the breaker's own setting");
  assert.equal(drawdownTier(10_000, 7_400, 25).tier, "halt");
  // Equity above a stale peak is tier 0, never an error.
  assert.equal(drawdownTier(10_000, 10_500).tier, 0);
  for (const [peak, equity] of [[NaN, 5000], [0, 5000], [-1, 5000], [Infinity, 5000], [5000, NaN], [5000, 0], [5000, Infinity]] as const) {
    const t = drawdownTier(peak, equity);
    assert.equal(t.tier, "unknown", `${peak}/${equity}`);
    assert.equal(t.mult, 0, "unknown sizes nothing");
  }
  assert.equal(DEFAULT_DD_HALT_PCT, 15);
});

test("THE LOSS SEQUENCE: an 8% A+ loss at each tier's multiplier reads 8.00 / 3.68 / 1.77 / 1.73 and halts at ≤15.2%", () => {
  const peak = 10_000;
  let equity = peak;
  const losses: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = drawdownTier(peak, equity);
    if (t.tier === "halt") break;
    const riskPct = tieredRiskPct(4, "high", t.mult);   // the A+ rung × the tier
    const loss = equity * riskPct / 100;
    losses.push(loss / peak * 100);
    equity -= loss;
  }
  assert.deepEqual(losses.map((l) => l.toFixed(2)), ["8.00", "3.68", "1.77", "1.73"]);
  const finalDd = (peak - equity) / peak * 100;
  assert.ok(finalDd >= 15 && finalDd <= 15.2, `halted at ${finalDd.toFixed(2)}%`);
  assert.equal(drawdownTier(peak, equity).tier, "halt");
});

test("overshoot: a loss taken at −14.99% lands no deeper than −17.1% (≤2.1 past the wire)", () => {
  const peak = 10_000;
  const equity = peak * (1 - 0.1499);
  const t = drawdownTier(peak, equity);
  assert.equal(t.tier, 2);
  const loss = equity * tieredRiskPct(4, "high", t.mult) / 100;
  const dd = (peak - (equity - loss)) / peak * 100;
  assert.ok(dd - 15 <= 2.1, `overshoot ${(dd - 15).toFixed(2)}`);
});

// ---- the chain ----

test("the chain: base 4 high = 8; event ×0.5 = 4; decay ×0.5 and event ×0.5 = 2; ceiling applied last", () => {
  const chain = (ddMult: number, eventMult: number, decayMult: number, basePct = 4, conviction: string | null = "high") =>
    liveRiskPctChain({ basePct, conviction, ddMult, eventMult, decayMult });
  assert.equal(chain(1, 1, 1), 8);
  assert.equal(chain(1, 0.5, 1), 4);
  assert.equal(chain(1, 0.5, 0.5), 2);
  assert.equal(chain(0.5, 1, 1), 4);
  assert.equal(chain(0.25, 1, 1), 2);
  assert.equal(chain(0.25, 0.5, 0.25), 0.25);
  assert.equal(chain(0, 1, 1), 0, "a halt/unknown tier sizes nothing");
  assert.equal(chain(1, 0, 1), 0, "a paused event window sizes nothing");
  // The multipliers reduce the CLAMPED ladder value: a fat-fingered base of 6 asks for 12%,
  // clamps to 8, and a reduced window halves THAT to 4 — never 6.
  assert.equal(chain(1, 0.5, 1, 6), 4);
  assert.equal(chain(1, 1, 1, 100), 8);
  // A multiplier can only reduce: >1 is 1, negative/NaN is 0 (fail closed).
  assert.equal(chain(1.5, 1, 1), 8);
  assert.equal(chain(1, 2, 1), 8);
  assert.equal(chain(-1, 1, 1), 0);
  assert.equal(chain(1, NaN, 1), 0);
  assert.equal(chain(1, 1, Infinity), 0);
  // Never above the ceiling on any combination.
  for (const base of [1, 3, 4, 6, 8, 50]) for (const conv of ["low", "med", "high", null]) for (const m of [0, 0.25, 0.5, 1, 3]) {
    assert.ok(chain(m, m, m, base, conv) <= LIVE_RISK_CEILING_PCT);
  }
  // tieredRiskPct is the chain with event and decay at 1.
  assert.equal(tieredRiskPct(4, "high", 0.5), chain(0.5, 1, 1));
  assert.equal(tieredRiskPct(4, "med", 1), 4);
  assert.equal(tieredRiskPct(4, "low", 1), 2);
});

test("setup grades are labels on the existing ladder: Normal 2 / Strong 4 / A+ 8 = liveRiskPct(4, tier)", () => {
  assert.deepEqual(SETUP_GRADE_PCT, { Normal: 2, Strong: 4, "A+": 8 });
  assert.equal(setupGradeFor("low"), "Normal");
  assert.equal(setupGradeFor("med"), "Strong");
  assert.equal(setupGradeFor("high"), "A+");
  assert.equal(setupGradeFor(null), "Normal", "unverified is never A+");
  assert.equal(setupGradeFor("HIGH"), "Normal");
  for (const tier of ["low", "med", "high"] as const) {
    assert.equal(SETUP_GRADE_PCT[setupGradeFor(tier)], liveRiskPct(4, tier), tier);
  }
});

// ---- revenge pause ----

test("losersToday counts losing round trips closed since day start; undated trips count (fail closed)", () => {
  const day = Date.parse("2026-09-15T00:00:00Z");
  const trips = [
    { closedAt: "2026-09-15T03:00:00Z", netPnl: -50 },
    { closedAt: "2026-09-15T04:00:00Z", netPnl: 20 },
    { closedAt: "2026-09-14T23:59:59Z", netPnl: -80 },   // yesterday
    { closedAt: "2026-09-15T00:00:00Z", netPnl: -1 },    // exactly midnight counts
    { closedAt: "garbage", netPnl: -5 },
    { closedAt: "2026-09-15T05:00:00Z", netPnl: 0 },     // scratch is not a loss
  ];
  assert.equal(losersToday(trips, day), 3);
  assert.equal(losersToday([], day), 0);
});

test("revengePauseHit: 1 of 2 trades on; 2 of 2 refuses; an explicit 0 or an unreadable limit refuses everything", () => {
  assert.equal(revengePauseHit(0, 2), false);
  assert.equal(revengePauseHit(1, 2), false);
  assert.equal(revengePauseHit(2, 2), true);
  assert.equal(revengePauseHit(3, 2), true);
  assert.equal(revengePauseHit(0, 0), true, "0 is a real zero, as the daily cap's 0 is");
  assert.equal(revengePauseHit(0, NaN), true);
  assert.equal(revengePauseHit(0, -1), true);
  assert.equal(revengePauseHit(NaN, 2), true);
});

// ---- liquidation buffer ----

test("LIQ_BUFFER_MULT is 1/0.6 and the allowance is exactly 0.36", () => {
  assert.equal(LIQ_BUFFER_MULT, 1 / STOP_CUSHION_FRACTION);
  assert.equal(LIQ_STOP_ALLOWANCE, 0.36, "0.6 ÷ (1/0.6) must be exactly 0.36 or every 3% sleeve drops a rung");
});

test("leverageThatFitsStop is unchanged by the rewrite: identical to floor(0.36/stop) for stops 1–20% × leverage 2–20", () => {
  const legacy = (stopPct: number, leverage: number) => Math.max(2, Math.min(leverage, Math.floor(0.36 / (stopPct / 100))));
  for (let s = 1; s <= 20; s++) for (let lev = 2; lev <= 20; lev++) {
    assert.equal(leverageThatFitsStop(s, lev), legacy(s, lev), `stop ${s}% lev ${lev}`);
  }
  for (let s = 5; s <= 200; s++) {   // 0.5% … 20% in 0.1 steps — the float ties live here
    const stop = s / 10;
    assert.equal(leverageThatFitsStop(stop, 20), legacy(stop, 20), `stop ${stop}%`);
  }
  // The specific rungs the desk runs on.
  assert.equal(leverageThatFitsStop(3, 20), 12);
  assert.equal(leverageThatFitsStop(4, 20), 9);
  assert.equal(leverageThatFitsStop(8, 20), 4);
  assert.equal(leverageThatFitsStop(6, 20), 6);
  assert.equal(leverageThatFitsStop(12, 20), 3);
});

test("liqBufferOk holds at every live container's stop with its fitted leverage, and fails one rung higher", () => {
  for (const [source, c] of Object.entries(LIVE_CONTAINERS)) {
    const lev = leverageThatFitsStop(c.stopPct, 20);
    const stopFrac = clampLiveStopFrac(c.stopPct, lev);
    assert.ok(liqBufferOk(stopFrac, lev), `${source}: ${c.stopPct}% at ${lev}× (${liqBufferMultiple(stopFrac, lev).toFixed(3)}×)`);
    assert.ok(liqBufferMultiple(stopFrac, lev) >= LIQ_BUFFER_MULT * (1 - 1e-9), source);
    assert.equal(liqBufferOk(stopFrac, lev + 1), false, `${source}: one rung higher breaks the buffer`);
  }
  // The FAST container is an exact floating-point tie (0.6/12 vs (1/0.6)×0.03) — must pass.
  assert.ok(liqBufferOk(0.03, 12));
  assert.equal(liqBufferOk(0.03, 13), false);
  assert.equal(liqBufferOk(0.04, 10), false);
  assert.equal(liqBufferOk(0.08, 5), false);
  assert.ok(liqBufferOk(0.04, 2), "low leverage is always inside the buffer");
  // A wider multiple is stricter; a tighter one looser.
  assert.equal(liqBufferOk(0.04, 9, 2), false);
  assert.ok(liqBufferOk(0.04, 9, 1.5));
  for (const [s, l] of [[NaN, 9], [0, 9], [0.04, NaN], [0.04, 0], [0.04, -2]] as const) assert.equal(liqBufferOk(s, l), false, `${s}/${l}`);
  assert.equal(liqBufferOk(0.04, 9, NaN), false);
});

// ---- decay multiplier parse ----

test("parseDecayMultiplier: missing = 1; strict; outside 0.25–1 is null (the executor refuses)", () => {
  assert.equal(parseDecayMultiplier(null), 1);
  assert.equal(parseDecayMultiplier(undefined), 1);
  assert.equal(parseDecayMultiplier(""), 1);
  assert.equal(parseDecayMultiplier("  "), 1);
  assert.equal(parseDecayMultiplier("1"), 1);
  assert.equal(parseDecayMultiplier("0.5"), 0.5);
  assert.equal(parseDecayMultiplier("0.25"), 0.25);
  assert.equal(parseDecayMultiplier("0.2"), null);
  assert.equal(parseDecayMultiplier("1.1"), null);
  assert.equal(parseDecayMultiplier("0"), null);
  assert.equal(parseDecayMultiplier("x"), null);
  assert.equal(parseDecayMultiplier("0.5abc"), null, "Number(), not parseFloat — no silent prefix parse");
});
