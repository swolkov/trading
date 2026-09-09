import assert from "node:assert/strict";
import test from "node:test";
import { pairMatchesSymbol } from "../src/lib/kraken-pairs";
import {
  DEFAULT_MAX_LEVERAGE,
  EXEC_LOCK_TTL_MS,
  LEV_CAP_AT_5K,
  LEV_CAP_AT_10K,
  LEV_CAP_AT_20K,
  convictionMultiplier,
  effectiveMaxLeverage,
  execLockHeldSince,
  failClosedOnEmptyPositions,
  DAILY_LOSS_CAP_FLOOR_USD,
  dailyLossCapUsd,
  entryKeepsMarginLevel,
  leverageCapForEquity,
  leverageThatFitsStop,
  LIVE_CONTAINERS,
  liveRiskFraction,
  liveRiskPct,
  MAX_LIVE_POSITIONS,
  MIN_ENTRY_MARGIN_LEVEL,
  pairHasExposure,
  parseLiveRiskBasePct,
  projectedMarginLevel,
} from "../src/lib/margin-live-risk";

test("conviction: high 2x, low 0.5x, null/med/garbage 1x never high", () => {
  assert.equal(convictionMultiplier("high"), 2);
  assert.equal(convictionMultiplier("low"), 0.5);
  assert.equal(convictionMultiplier("med"), 1);
  assert.equal(convictionMultiplier(null), 1);
  assert.equal(convictionMultiplier(undefined), 1);
  assert.equal(convictionMultiplier("HIGH"), 1);
  assert.equal(convictionMultiplier("maybe"), 1);
});

test("live risk defaults 3%, high conviction 6% ceiling, unset key uses 3", () => {
  assert.equal(parseLiveRiskBasePct(undefined), 3);
  assert.equal(parseLiveRiskBasePct(NaN), 3);
  assert.equal(parseLiveRiskBasePct(0), 3);
  assert.equal(parseLiveRiskBasePct(0.5), 0.5);
  assert.equal(parseLiveRiskBasePct(9), 6);
  assert.equal(liveRiskPct(3, "med"), 3);
  assert.equal(liveRiskPct(3, "high"), 6);
  assert.equal(liveRiskPct(3, "low"), 1.5);
  assert.equal(liveRiskPct(3, null), 3);
  assert.equal(liveRiskFraction(3, "high"), 0.06);
  assert.equal(liveRiskFraction(3, "low"), 0.015);
});

test("empty OpenPositions while margin in use fails closed (degraded Kraken read)", () => {
  assert.equal(failClosedOnEmptyPositions(0, 120), true);
  assert.equal(failClosedOnEmptyPositions(0, null), true);
  assert.equal(failClosedOnEmptyPositions(0, undefined), true);
  assert.equal(failClosedOnEmptyPositions(0, 0), false);
  assert.equal(failClosedOnEmptyPositions(1, 120), false);
});

test("anti-stack is either-direction: opposing exposure on the pair is a netting risk", () => {
  const longBtc = ["XXBTZUSD"];
  assert.equal(pairHasExposure("BTC/USD", longBtc, [], pairMatchesSymbol), true);
  assert.equal(pairHasExposure("ETH/USD", longBtc, [], pairMatchesSymbol), false);
  assert.equal(pairHasExposure("BTC/USD", [], ["XBTUSD"], pairMatchesSymbol), true);
  assert.equal(pairHasExposure("SOL/USD", [], [], pairMatchesSymbol), false);
});

test("exec lock TTL outlives the 300s webhook maxDuration", () => {
  assert.ok(EXEC_LOCK_TTL_MS > 300_000);
  assert.equal(execLockHeldSince(""), null);
  assert.equal(execLockHeldSince("2026-09-04T12:00:00.000Z#abc123"), "2026-09-04T12:00:00.000Z");
  assert.equal(execLockHeldSince("2026-09-04T12:00:00.000Z"), "2026-09-04T12:00:00.000Z");
  assert.equal(execLockHeldSince("not-a-date#x"), null);
});

test("paper fraction path equals executor percent path (no silent drift)", () => {
  // Paper stores 3% as 0.03; the executor parses the config key as 3. Same helper both ways.
  assert.equal(liveRiskFraction(0.03 * 100, "high"), 0.06);
  assert.equal(liveRiskFraction(0.03 * 100, "low"), 0.015);
  assert.equal(liveRiskFraction(0.03 * 100, null), 0.03);
  assert.equal(liveRiskFraction(9, "high"), 0.06); // ceiling on the base, then on the product
});

test("leverage cap grows with equity; risk % is a different knob", () => {
  assert.equal(leverageCapForEquity(5_000), LEV_CAP_AT_5K);
  assert.equal(leverageCapForEquity(9_999), LEV_CAP_AT_5K);
  assert.equal(leverageCapForEquity(10_000), LEV_CAP_AT_10K);
  assert.equal(leverageCapForEquity(19_999), LEV_CAP_AT_10K);
  assert.equal(leverageCapForEquity(20_000), LEV_CAP_AT_20K);
  assert.equal(leverageCapForEquity(50_000), LEV_CAP_AT_20K);
  // Missing/garbage equity fails closed to the $5k rung, never "treat as large".
  assert.equal(leverageCapForEquity(0), LEV_CAP_AT_5K);
  assert.equal(leverageCapForEquity(-1), LEV_CAP_AT_5K);
  assert.equal(leverageCapForEquity(NaN), LEV_CAP_AT_5K);
  assert.equal(DEFAULT_MAX_LEVERAGE, 5);
});

test("operator ceiling cannot be exceeded by the ladder; ladder cannot be exceeded by the ceiling", () => {
  // Sep 9 2026: the $5k rung was raised 2× → 5× (Spencer's decision). Leverage does not
  // change dollar risk — notional is risk × equity ÷ stop either way — it changes the
  // MARGIN a position posts, which is what decides how many slots fit.
  assert.equal(effectiveMaxLeverage(5, 5_000), 5);
  assert.equal(effectiveMaxLeverage(DEFAULT_MAX_LEVERAGE, 5_000), 5);
  assert.equal(effectiveMaxLeverage(5, 10_000), 5);
  assert.equal(effectiveMaxLeverage(5, 20_000), 5);
  // Operator who wants to stay at 2× forever still can.
  assert.equal(effectiveMaxLeverage(2, 50_000), 2);
  // cfg < 2 means entries disabled — returned as-is so the executor can refuse.
  assert.equal(effectiveMaxLeverage(1, 50_000), 1);
});

// ---- Sep 5 2026: live mirrors paper's container ----
import { LIVE_MAX_HOLD_H, LIVE_STOP_DEFAULT_PCT, liveNotional, managedStopTarget, stopNeedsRatchet } from "../src/lib/margin-live-risk";

test("live container constants equal paper's selective sleeve (3% stop, 48h)", () => {
  assert.equal(LIVE_STOP_DEFAULT_PCT, 3);
  assert.equal(LIVE_MAX_HOLD_H, 48);
});

test("liveNotional is paper's positionNotional on real equity: risk ÷ stop, capped at leverage × equity", () => {
  // $5,300 equity, 3% risk, 3% stop → $5,300 (1×); high conviction 6% → $10,600 = 2× cap.
  assert.equal(Math.round(liveNotional(5300, 0.03, 0.03, 2)), 5300);
  assert.equal(Math.round(liveNotional(5300, 0.06, 0.03, 2)), 10_600);
  // Tighter stop buys a bigger position for the same dollar risk, until the leverage cap binds.
  assert.equal(Math.round(liveNotional(5300, 0.03, 0.015, 2)), 10_600);
  assert.equal(Math.round(liveNotional(5300, 0.03, 0.015, 3)), 10_600);   // 3× cap = $15,900; risk cap $10,600 binds
  // Growth: double the equity, double the dollars at the same 3%.
  assert.equal(Math.round(liveNotional(10_600, 0.03, 0.03, 3)), 10_600);
  // The optional per-trade ceiling still works when set; 0 means none.
  assert.equal(liveNotional(5300, 0.03, 0.03, 2, 100), 200);
  assert.equal(liveNotional(0, 0.03, 0.03, 2), 0);
  assert.equal(liveNotional(5300, 0.03, 0, 2), 0);
});

test("managedStopTarget reproduces paper's exit: breakeven at +1R, then trail 1R, never looser", () => {
  const entry = 100, oneR = 3, initial = 97;
  assert.equal(managedStopTarget("long", entry, 102.9, initial, oneR), 97, "below +1R: unchanged");
  assert.equal(managedStopTarget("long", entry, 103, initial, oneR), 100, "at +1R: breakeven");
  assert.equal(managedStopTarget("long", entry, 106, initial, oneR), 103, "at +2R: trails 1R behind the peak");
  assert.equal(managedStopTarget("long", entry, 106, 104, oneR), 104, "never loosens an already-higher stop");
  // Short mirrored.
  assert.equal(managedStopTarget("short", entry, 97.5, 103, oneR), 103);
  assert.equal(managedStopTarget("short", entry, 97, 103, oneR), 100);
  assert.equal(managedStopTarget("short", entry, 94, 103, oneR), 97);
  // Garbage fails safe (returns the current stop).
  assert.equal(managedStopTarget("long", 0, 106, initial, oneR), initial);
  assert.equal(managedStopTarget("long", entry, NaN, initial, oneR), initial);
});

test("stopNeedsRatchet only moves a resting order for a real improvement (≥0.05% of price)", () => {
  assert.equal(stopNeedsRatchet("long", 97, 100, 105), true);
  assert.equal(stopNeedsRatchet("long", 100, 100.01, 105), false);   // 0.01% — not worth an order
  assert.equal(stopNeedsRatchet("long", 100, 99, 105), false);       // looser is never a ratchet
  assert.equal(stopNeedsRatchet("short", 103, 100, 95), true);
  assert.equal(stopNeedsRatchet("short", 100, 101, 95), false);
  assert.equal(stopNeedsRatchet("long", 97, 100, 0), false);
});

import { clampLiveStopFrac, fifoWouldHitManual, groupPositionsByOrder, roundedStopIsSafe } from "../src/lib/margin-live-risk";

test("clampLiveStopFrac: the 3% default survives every ladder rung; wide configs are held inside liquidation", () => {
  assert.equal(clampLiveStopFrac(3, 2), 0.03);
  assert.equal(clampLiveStopFrac(3, 3), 0.03);
  assert.equal(clampLiveStopFrac(3, 5), 0.03);
  assert.ok(Math.abs(clampLiveStopFrac(20, 2) - 0.18) < 1e-12);    // 0.6 × 0.6/2
  assert.ok(Math.abs(clampLiveStopFrac(20, 5) - 0.072) < 1e-12);   // 0.6 × 0.6/5
  assert.equal(clampLiveStopFrac(0.01, 2), 0.001);                 // floor
  assert.equal(clampLiveStopFrac(NaN, 2), 0.03);                   // unreadable → default
});

test("roundedStopIsSafe checks the ROUNDED trigger against price (Codex's 100.01 / 103 case)", () => {
  // target 102.9997 rounds to 103.00 = market → unsafe
  assert.equal(roundedStopIsSafe("long", 102.9997, 103, 2).ok, false);
  assert.deepEqual(roundedStopIsSafe("long", 102.9, 103, 2), { ok: true, priceStr: "102.90" });
  assert.equal(roundedStopIsSafe("short", 97.0003, 97, 2).ok, false);
  assert.equal(roundedStopIsSafe("short", 97.1, 97, 2).ok, true);
  assert.equal(roundedStopIsSafe("long", 100, 0, 2).ok, false);
  assert.equal(roundedStopIsSafe("long", 100, 100.04, 2).ok, false);  // 0.04% — inside the threshold
});

test("groupPositionsByOrder merges tranches of one order: summed volume, weighted entry, oldest age", () => {
  const g = groupPositionsByOrder([
    { id: "T1", ordertxid: "O1", pair: "XBTUSD:BTNL", side: "long", vol: 1, entryPrice: 100, openedAt: "2026-09-05T10:00:00Z", leverage: 2 },
    { id: "T2", ordertxid: "O1", pair: "XBTUSD:BTNL", side: "long", vol: 3, entryPrice: 104, openedAt: "2026-09-05T10:18:00Z", leverage: 2 },
    { id: "T3", ordertxid: "O2", pair: "XETHZUSD", side: "short", vol: 5, entryPrice: 50, openedAt: "2026-09-05T11:00:00Z", leverage: 3 },
  ]);
  assert.equal(g.length, 2);
  const o1 = g.find((x) => x.ordertxid === "O1")!;
  assert.equal(o1.vol, 4);
  assert.equal(o1.entryPrice, 103);
  assert.equal(o1.openedAt, "2026-09-05T10:00:00Z");
  assert.equal(o1.newestOpenedAt, "2026-09-05T10:18:00Z");
  assert.deepEqual(o1.ids, ["T1", "T2"]);
});

test("fifoWouldHitManual: only an OLDER manual position on the same pair and side blocks a bot close", () => {
  const same = (a: string, b: string) => a.replace(/:.*$/, "") === b.replace(/:.*$/, "");
  const bot = { pair: "XBTUSD:BTNL", side: "long", openedAt: "2026-09-05T12:00:00Z", ours: true };
  const olderManual = { pair: "XBTUSD", side: "long", openedAt: "2026-09-05T09:00:00Z", ours: false };
  const newerManual = { pair: "XBTUSD", side: "long", openedAt: "2026-09-05T13:00:00Z", ours: false };
  const manualShort = { pair: "XBTUSD", side: "short", openedAt: "2026-09-05T09:00:00Z", ours: false };
  const otherPair = { pair: "XETHZUSD", side: "long", openedAt: "2026-09-05T09:00:00Z", ours: false };
  const isOurs = (p: { pair: string; side: string; openedAt: string; ours?: boolean }) => !!p.ours;
  assert.equal(fifoWouldHitManual(bot, [bot, olderManual], isOurs, same), true);
  assert.equal(fifoWouldHitManual(bot, [bot, newerManual], isOurs, same), false);
  assert.equal(fifoWouldHitManual(bot, [bot, manualShort], isOurs, same), false);
  assert.equal(fifoWouldHitManual(bot, [bot, otherPair], isOurs, same), false);
  assert.equal(fifoWouldHitManual(bot, [bot], isOurs, same), false);
  // Fails closed: equal or unparseable timestamps block.
  const sameTime = { ...olderManual, openedAt: bot.openedAt };
  assert.equal(fifoWouldHitManual(bot, [bot, sameTime], isOurs, same), true);
  assert.equal(fifoWouldHitManual({ ...bot, openedAt: "" }, [bot, newerManual], isOurs, same), true);
});

import { isSourceArmed, tvSource } from "../src/lib/margin-live-risk";

test("source arming: nothing is armed by default; only named sources trade live", () => {
  assert.equal(isSourceArmed("", "manual"), false);
  assert.equal(isSourceArmed(null, "selective"), false);
  assert.equal(isSourceArmed("selective", "selective"), true);
  assert.equal(isSourceArmed("selective, tv:esbueno", "tv:esbueno"), true);
  assert.equal(isSourceArmed("selective", "manual"), false);
  assert.equal(isSourceArmed("SELECTIVE", "selective"), true);
  assert.equal(isSourceArmed("selective", undefined), false);   // undefined = manual
});

test("tvSource: a TradingView strategy name becomes a tv: sleeve, garbage becomes nothing", () => {
  assert.equal(tvSource("Esbueno_Breakout"), "tv:esbueno_breakout");
  assert.equal(tvSource(""), null);
  assert.equal(tvSource(undefined), null);
  assert.equal(tvSource("bad name"), null);
  assert.equal(tvSource("x".repeat(40)), null);
  assert.equal(tvSource("-lead"), null);
});

test("liveNotional fits the order to free margin: a 6% trade on a $5,185 account at 2× asks for the whole account and gets 90% of it", async () => {
  const { liveNotional, MARGIN_HEADROOM } = await import("../src/lib/margin-live-risk");
  const eq = 5185;
  assert.equal(liveNotional(eq, 0.06, 0.03, 2), eq * 2, "unclamped: exactly the leverage cap");
  const fitted = liveNotional(eq, 0.06, 0.03, 2, 0, eq);          // free margin = the whole account
  assert.ok(Math.abs(fitted - eq * MARGIN_HEADROOM * 2) < 1e-6);
  assert.ok(Math.abs(liveNotional(eq, 0.03, 0.03, 2, 0, eq) - eq) < 1e-6, "a 3% trade is untouched (needs half the margin)");
  assert.equal(liveNotional(eq, 0.03, 0.03, 2, 0, 0), 0, "no free margin → nothing sent");
  assert.ok(Math.abs(liveNotional(eq, 0.03, 0.03, 2, 0, null) - eq) < 1e-6, "unknown free margin → unchanged (caller decides)");
});

test("an empty positions read while the guardian is managing a book is UNCONFIRMED, not flat", async () => {
  const { emptyReadIsUnconfirmed } = await import("../src/lib/margin-live-risk");
  assert.equal(emptyReadIsUnconfirmed(0, 1), true, "guardian had RENDER, Kraken said nothing → unconfirmed");
  assert.equal(emptyReadIsUnconfirmed(0, 0), false, "nothing managed, nothing open → flat");
  assert.equal(emptyReadIsUnconfirmed(1, 1), false, "a real read is a real read");
  assert.equal(emptyReadIsUnconfirmed(2, 0), false);
});

// ── Sep 9 2026: three slots at 5× ──────────────────────────────────────────────────────
test("MAX_LIVE_POSITIONS is the one ceiling; the executor clamp matches the arm switch", () => {
  assert.equal(MAX_LIVE_POSITIONS, 3);
  // The executor's gate is Math.min(MAX_LIVE_POSITIONS, Math.max(1, cfg)). A direct write
  // of a silly number to kraken_margin_max_positions must not open a fourth position.
  const gate = (cfg: number) => Math.min(MAX_LIVE_POSITIONS, Math.max(1, cfg));
  assert.equal(gate(30), 3);
  assert.equal(gate(3), 3);
  assert.equal(gate(0), 1);
  assert.equal(gate(-5), 1);
});

// Fills slots one at a time exactly as the executor does — each entry sized against the
// free margin the previous ones left behind, and refused outright if it would breach the
// margin-level floor. Returns what the book actually ends up holding.
function fillSlots(eq: number, risk: number, stop: number, lev: number, slots: number, floor = MIN_ENTRY_MARGIN_LEVEL) {
  let margin = 0; const sizes: number[] = [];
  for (let i = 0; i < slots; i++) {
    const n = liveNotional(eq, risk, stop, lev, 0, eq - margin);
    if (!(n > 0) || !entryKeepsMarginLevel(eq, margin, n, lev, floor)) break;
    sizes.push(n); margin += n / lev;
  }
  return { sizes, margin, marginLevel: margin > 0 ? (eq / margin) * 100 : Infinity };
}

test("5× carries three full-size slots at 3% risk; 2× runs out at two", () => {
  const eq = 4_636, stop = 0.04, risk = 0.03;   // 3% per high-conviction trade (base 1.5%)
  const want = (risk * eq) / stop;
  // 2× — two slots fit, but the third is clipped to a fraction by free margin, so the
  // sleeve's record does not transfer to it. That is the ceiling the 2× rung imposed.
  const two = fillSlots(eq, risk, stop, 2, 3, 0);
  assert.ok(Math.abs(two.sizes[1] - want) < 1, "2x: the second slot is still full size");
  assert.ok(two.sizes[2] < want * 0.7, `2x: the third slot is clipped to $${two.sizes[2].toFixed(0)} of $${want.toFixed(0)}`);
  // 5× — three slots, every one at full size, and the book sits well clear of the floor.
  const five = fillSlots(eq, risk, stop, 5, 3, 0);
  assert.equal(five.sizes.length, 3);
  for (const s of five.sizes) assert.ok(Math.abs(s - want) < 1, `5x slot filled ${s.toFixed(0)}, wanted ${want.toFixed(0)}`);
  assert.ok(five.marginLevel > 200, `5x margin level ${five.marginLevel.toFixed(0)}% should clear 200%`);
  // Posting LESS margin for the same notional leaves a HIGHER account margin level.
  assert.ok(five.marginLevel > two.marginLevel);
});

test("the margin-level floor, not the slot count, decides how many positions fit", () => {
  const eq = 4_636, stop = 0.04, lev = 5;
  // 3% per trade: all three slots clear the 150% floor.
  assert.equal(fillSlots(eq, 0.03, stop, lev, 3).sizes.length, 3);
  // 6% per trade (base 3%): the third entry would leave the book at ~111%, a 6% adverse
  // move from a margin call — so it is refused and the desk runs two. Same config, and
  // nobody had to keep the slot count in step with the risk setting by hand.
  const hot = fillSlots(eq, 0.06, stop, lev, 3);
  assert.equal(hot.sizes.length, 2, "6% per trade only supports two slots at this equity");
  assert.ok(hot.marginLevel >= MIN_ENTRY_MARGIN_LEVEL, `left the book at ${hot.marginLevel.toFixed(0)}%`);
  // Without the floor the third entry lands and the account sits ~111%.
  const unguarded = fillSlots(eq, 0.06, stop, lev, 3, 0);
  assert.equal(unguarded.sizes.length, 3);
  assert.ok(unguarded.marginLevel < 120, `unguarded book sits at ${unguarded.marginLevel.toFixed(0)}%`);
});

test("projectedMarginLevel matches Kraken's equity ÷ margin, and the floor can be disabled", () => {
  // $6,955 notional at 5× posts $1,391 on a flat $4,636 account → 333%.
  assert.equal(Math.round(projectedMarginLevel(4_636, 0, 6_955, 5)), 333);
  // With $2,782 already posted it lands at 111%.
  assert.equal(Math.round(projectedMarginLevel(4_636, 2_782, 6_955, 5)), 111);
  assert.equal(entryKeepsMarginLevel(4_636, 2_782, 6_955, 5, 150), false);
  assert.equal(entryKeepsMarginLevel(4_636, 2_782, 6_955, 5, 0), true, "floor 0 disables the check");
  // Unreadable equity never waves an entry through.
  assert.equal(entryKeepsMarginLevel(0, 0, 1_000, 5, 150), false);
});

test("the daily loss cap scales with the account instead of freezing at arming day", () => {
  // Two full high-conviction losses. base 3% → 6% per trade → 12% of equity in a day.
  assert.equal(dailyLossCapUsd(4_636, 3), 556);
  // The account doubles and the cap follows — the frozen $556 would have stopped protecting.
  assert.equal(dailyLossCapUsd(9_272, 3), 1_113);
  // Lower the risk setting and the cap drops with it, no second knob to remember.
  assert.equal(dailyLossCapUsd(4_636, 1.5), 278);
  // Floor, so a tiny account still has a real cap.
  assert.equal(dailyLossCapUsd(500, 1.5), DAILY_LOSS_CAP_FLOOR_USD);
  // A deliberate operator override still wins.
  assert.equal(dailyLossCapUsd(4_636, 3, 100), 100);
  // Unreadable equity falls back to the floor, never to "no cap".
  assert.equal(dailyLossCapUsd(0, 3), DAILY_LOSS_CAP_FLOOR_USD);
  assert.equal(dailyLossCapUsd(NaN, 3), DAILY_LOSS_CAP_FLOOR_USD);
});

test("every live container's stop survives the leverage it will actually run at", () => {
  // The regression this exists for: raising the ladder to 5× shrank tsmom's 8% stop to
  // 7.2% via clampLiveStopFrac, so live would have run a container paper never scored.
  for (const [source, c] of Object.entries(LIVE_CONTAINERS)) {
    const lev = leverageThatFitsStop(c.stopPct, LEV_CAP_AT_20K);
    const applied = clampLiveStopFrac(c.stopPct, lev) * 100;
    assert.ok(Math.abs(applied - c.stopPct) < 1e-9, `${source}: ${c.stopPct}% stop became ${applied.toFixed(2)}% at ${lev}×`);
    assert.ok(lev >= 2, `${source}: leverage floored at Kraken's margin minimum`);
  }
  // The specific numbers, so a future ladder change has to look at them.
  assert.equal(leverageThatFitsStop(4, 5), 5, "swing-lev's 4% stop is fine at 5×");
  assert.equal(leverageThatFitsStop(8, 5), 4, "tsmom's 8% stop drops leverage to 4×");
  assert.equal(leverageThatFitsStop(3, 20), 12, "a 3% stop tolerates up to 12×");
  assert.equal(leverageThatFitsStop(4, 3), 3, "never RAISES leverage above what it was given");
});

test("the pair's own US-retail maximum still caps leverage below the ladder", () => {
  // ALGO/XLM are 2× venues; PENGU/NEAR/RENDER 3×. A 5× plan must not exceed them.
  const applied = (pairMax: number, planLev: number) => Math.min(5, pairMax, Math.max(2, planLev));
  assert.equal(applied(2, 5), 2);
  assert.equal(applied(3, 5), 3);
  assert.equal(applied(5, 5), 5);
  assert.equal(applied(20, 5), 5);       // ladder still binds on BTC
  assert.equal(applied(5, 1), 2);        // a spot plan (lev 1) floors at Kraken's margin minimum
});
