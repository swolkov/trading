import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LIMITS, FEE_PER_SIDE_MICRO, FEE_PER_SIDE_MINI, STAGE_MAX_CONTRACTS, budgetFor, cmeOpen, dedupeKey, deskVerdict, entryRefusal, etDayKey, etShortDate, feePerSide, gradeFor,
  limitsFromConfig, maxDrawdown, parseAlert, profitFactor, rollDue, rollPreview, roundToTick, sizeEntry, stageReadiness, tStatOf, tradePnlUsd, usd,
  type AlertPayload, type DeskContext, type SizeOpts,
} from "../src/lib/futures-desk-rules";

const good = { secret: "x", desk: "futures", edge: "index_daily_mr", symbol: "ES", action: "entry", side: "long", price: 6500, stop: 6440, bar: "2026-09-14T21:00:00Z", tf: "1D" };
const okCtx: DeskContext = {
  enabled: true, openRoots: [], entriesToday: 0, dayPnlUsd: 0, equityUsd: 50_000, equityHighUsd: 50_000, guardianFreshMs: 60_000,
  openRiskUsd: 0, sameClusterSameSideRiskUsd: 0, dailyLossRemainingUsd: 750, ddMult: 1, newRiskUsd: 250,
};
const opts: SizeOpts = { grade: "normal", stage: "A", budgetMult: 1 };
function alertOf(over: Record<string, unknown>): AlertPayload { const p = parseAlert({ ...good, ...over }); if (!p.ok) throw new Error(p.reason); return p.alert; }

test("parseAlert accepts the documented shape and normalises the bar", () => {
  const p = parseAlert(good);
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.equal(p.alert.root, "ES");
  assert.equal(p.alert.bar, "2026-09-14T21:00:00.000Z");
  assert.equal(p.alert.stop, 6440);
});

test("parseAlert accepts TradingView's {{time}} as epoch milliseconds and as a numeric string", () => {
  const a = parseAlert({ ...good, bar: 1789420800000 });
  const b = parseAlert({ ...good, bar: "1789420800000" });
  assert.equal(a.ok && a.alert.bar, new Date(1789420800000).toISOString());
  assert.equal(b.ok && b.alert.bar, new Date(1789420800000).toISOString());
});

test("parseAlert refuses unknown edges, wrong markets, missing stops and stops on the wrong side", () => {
  assert.equal(parseAlert({ ...good, edge: "gold_rsi" }).ok, false);
  assert.equal(parseAlert({ ...good, symbol: "CL" }).ok, false);
  assert.equal(parseAlert({ ...good, stop: undefined }).ok, false);
  assert.equal(parseAlert({ ...good, stop: 6600 }).ok, false);
  assert.equal(parseAlert({ ...good, side: "short" }).ok, false);
  assert.equal(parseAlert({ ...good, desk: "crypto" }).ok, false);
  assert.equal(parseAlert({ ...good, action: "buy" }).ok, false);
});

test("an exit needs no stop; the same bar dedupes; a different bar does not", () => {
  const x = parseAlert({ ...good, action: "exit", stop: undefined });
  assert.equal(x.ok, true);
  const a = parseAlert(good), b = parseAlert({ ...good, price: 6501 }), c = parseAlert({ ...good, bar: "2026-09-15T21:00:00Z" });
  assert.ok(a.ok && b.ok && c.ok);
  if (a.ok && b.ok && c.ok) {
    assert.equal(dedupeKey(a.alert), dedupeKey(b.alert));
    assert.notEqual(dedupeKey(a.alert), dedupeKey(c.alert));
  }
});

test("the ladder: Normal $250 / Strong $375 / A+ $500 of the $50k basis", () => {
  assert.equal(budgetFor("normal", DEFAULT_LIMITS), 250);
  assert.equal(budgetFor("strong", DEFAULT_LIMITS), 375);
  assert.equal(budgetFor("aplus", DEFAULT_LIMITS), 500);
  assert.equal(usd(1000), "$1,000"); assert.equal(usd(301.7, 2), "$301.70"); assert.equal(usd(-620), "$620");
});

test("sizing: MES with a 60-point stop ($301.70) is REFUSED at Normal/A with the exact reason, never stretched", () => {
  const s = sizeEntry(alertOf({}), DEFAULT_LIMITS, opts);
  assert.equal(s.ok, false);
  assert.equal(s.micro, "MES");
  assert.match(s.reason, /\$301\.70 against a \$250/);
  assert.equal(s.reason, "one MES risks $301.70 against a $250 budget (normal · stage A) — refused, never stretched");
  assert.equal(s.contracts, 0);
});

test("sizing: A+ ($500) fits one MES at 60 points; MNQ 300-pt ($601.70) is refused even at A+", () => {
  const s = sizeEntry(alertOf({}), DEFAULT_LIMITS, { ...opts, grade: "aplus" });
  assert.equal(s.ok, true); assert.equal(s.contracts, 1); assert.equal(s.grade, "aplus"); assert.equal(s.unit, "micro"); assert.equal(s.stage, "A");
  assert.equal(s.pointValue, 5);   // MES
  assert.ok(s.riskUsd <= s.riskBudgetUsd);
  const nq = sizeEntry(alertOf({ symbol: "NQ", price: 24000, stop: 23700 }), DEFAULT_LIMITS, { ...opts, grade: "aplus" });
  assert.equal(nq.ok, false); assert.match(nq.reason, /\$601\.70 against a \$500/);
});

test("sizing: the stage cap binds — MYM 200-pt ($101.70) → A: 1 (capped), B: 2; C caps at 5; tight stop at A → 1", () => {
  const ym = alertOf({ symbol: "YM", price: 46000, stop: 45800 });
  const a = sizeEntry(ym, DEFAULT_LIMITS, opts);
  assert.equal(a.contracts, 1); assert.equal(a.reason, "capped at 1 contracts (stage A)");
  assert.equal(sizeEntry(ym, DEFAULT_LIMITS, { ...opts, stage: "B" }).contracts, 2);
  const c = sizeEntry(alertOf({ symbol: "YM", price: 46000, stop: 45950 }), DEFAULT_LIMITS, { ...opts, stage: "C" });   // $26.70 → raw 9
  assert.equal(c.contracts, 5); assert.match(c.reason, /capped at 5/);
  const tight = sizeEntry(alertOf({ price: 6500, stop: 6499 }), DEFAULT_LIMITS, opts);
  assert.equal(tight.contracts, STAGE_MAX_CONTRACTS.A);
});

test("sizing: stage D trades one MINI and only when armed", () => {
  const es = alertOf({ price: 6500, stop: 6496 });   // 4 pts × $50 + $1.70 = $201.70
  const off = sizeEntry(es, DEFAULT_LIMITS, { grade: "aplus", stage: "D", budgetMult: 1 });
  assert.equal(off.ok, false); assert.match(off.reason, /not armed/);
  const on = sizeEntry(es, DEFAULT_LIMITS, { grade: "aplus", stage: "D", budgetMult: 1, stageDArmed: true });
  assert.equal(on.ok, true); assert.equal(on.contracts, 1); assert.equal(on.unit, "mini"); assert.equal(on.micro, "ES");
  assert.equal(on.pointValue, 50);   // the MINI's point value goes to the ledger, never the micro's
  assert.ok(Math.abs(on.riskPerContractUsd - (4 * 50 + 2 * FEE_PER_SIDE_MINI)) < 1e-9);
  assert.equal(feePerSide("ES", "ES"), FEE_PER_SIDE_MINI); assert.equal(feePerSide("MES", "ES"), FEE_PER_SIDE_MICRO); assert.equal(feePerSide("MGC", "GC"), FEE_PER_SIDE_MICRO);
});

test("sizing: the drawdown multiplier shrinks the budget", () => {
  const ym = sizeEntry(alertOf({ symbol: "YM", price: 46000, stop: 45800 }), DEFAULT_LIMITS, { ...opts, budgetMult: 0.5 });   // $125 budget, $101.70 per contract
  assert.equal(ym.ok, true); assert.equal(ym.contracts, 1); assert.equal(ym.riskBudgetUsd, 125);
  const es = sizeEntry(alertOf({ price: 6500, stop: 6480 }), DEFAULT_LIMITS, { ...opts, budgetMult: 0.25 });                // $62.50 budget, $101.70 per contract
  assert.equal(es.ok, false); assert.match(es.reason, /\$101\.70 against a \$62\.50 budget/);   // a fractional budget shows its cents
});

test("gradeFor: locked at Normal until the score is promoted; then ≥90 A+, ≥80 Strong", () => {
  const a = alertOf({ score: "95" });
  assert.equal(a.score, 95);
  assert.equal(gradeFor(a, false), "normal");
  assert.equal(gradeFor(a, true), "aplus");
  assert.equal(gradeFor(alertOf({ score: 85 }), true), "strong");
  assert.equal(gradeFor(alertOf({ score: 79 }), true), "normal");
  const none = alertOf({});
  assert.equal(none.score, undefined);
  assert.equal(gradeFor(none, true), "normal");
});

test("stageReadiness: 30 resolved at the stage, net > 0, PF ≥ 1.2, max drawdown ≤ 3% of basis — every failing reason reported", () => {
  const row = (pnl: number, stage = "A") => ({ status: "closed", pnl_usd: pnl, stage });
  const win30 = Array.from({ length: 30 }, () => row(50));
  assert.equal(stageReadiness(win30, "A", DEFAULT_LIMITS).ok, true);
  const r29 = stageReadiness(win30.slice(0, 29), "A", DEFAULT_LIMITS);
  assert.equal(r29.ok, false); assert.match(r29.reasons[0], /only 29 of 30 resolved at stage A/);
  const other = stageReadiness([...win30.slice(0, 29), row(50, "B")], "A", DEFAULT_LIMITS);
  assert.equal(other.resolved, 29);   // another stage's row does not count
  const neg = stageReadiness([...Array.from({ length: 29 }, () => row(50)), row(-2000)], "A", DEFAULT_LIMITS);
  assert.ok(neg.reasons.some((x) => /net is −\$550 — must be positive/.test(x)));
  assert.ok(neg.reasons.some((x) => /max drawdown \$2,000 exceeds 3% of basis \(\$1,500\)/.test(x)));
  const pf = stageReadiness([...Array.from({ length: 15 }, () => row(110)), ...Array.from({ length: 15 }, () => row(-100))], "A", DEFAULT_LIMITS);
  assert.equal(pf.ok, false); assert.ok(pf.reasons.some((x) => /profit factor 1\.10 is below 1\.2/.test(x)));
  const dip = stageReadiness([...Array.from({ length: 20 }, () => row(100)), row(-1600), ...Array.from({ length: 9 }, () => row(100))], "A", DEFAULT_LIMITS);
  assert.equal(dip.ok, false); assert.ok(dip.reasons.some((x) => /max drawdown \$1,600/.test(x)));
  assert.equal(profitFactor([10, 20]), Infinity); assert.equal(profitFactor([]), 0); assert.equal(profitFactor([-5]), 0);
  assert.equal(maxDrawdown([100, -50, -80, 200]), 130);
});

test("roundToTick lands on the contract grid", () => {
  assert.equal(roundToTick(6440.13, 0.25), 6440.25);
  assert.equal(roundToTick(2431.07, 0.1), 2431.1);
  assert.equal(roundToTick(4.55017, 0.0005), 4.55);
});

test("entryRefusal: the container refuses in the right order", () => {
  const p = parseAlert(good); assert.ok(p.ok); if (!p.ok) return;
  const a: AlertPayload = p.alert;
  assert.equal(entryRefusal(a, okCtx, DEFAULT_LIMITS), null);
  assert.match(entryRefusal(a, { ...okCtx, enabled: false }, DEFAULT_LIMITS)!, /disabled/);
  assert.match(entryRefusal(a, { ...okCtx, guardianFreshMs: null }, DEFAULT_LIMITS)!, /guardian/);
  assert.match(entryRefusal(a, { ...okCtx, openRoots: ["ES"] }, DEFAULT_LIMITS)!, /already holding/);
  assert.match(entryRefusal(a, { ...okCtx, openRoots: ["NQ", "YM", "GC", "SI", "HG", "RTY"] }, DEFAULT_LIMITS)!, /positions already open/);
  assert.match(entryRefusal(a, { ...okCtx, entriesToday: 4 }, DEFAULT_LIMITS)!, /entries already today/);
  assert.match(entryRefusal(a, { ...okCtx, dayPnlUsd: -3000 }, DEFAULT_LIMITS)!, /paused/);
  assert.match(entryRefusal(a, { ...okCtx, equityUsd: 39_000 }, DEFAULT_LIMITS)!, /halted/);
  assert.match(entryRefusal(a, { ...okCtx, openRiskUsd: 750 }, DEFAULT_LIMITS)!, /use up the 2% cap/);
  assert.equal(entryRefusal(a, { ...okCtx, openRiskUsd: 500 }, DEFAULT_LIMITS), null);   // three $250 positions fit; the fourth does not
  assert.match(entryRefusal(a, { ...okCtx, sameClusterSameSideRiskUsd: 500 }, DEFAULT_LIMITS)!, /cluster cap/);
  assert.match(entryRefusal(a, { ...okCtx, dailyLossRemainingUsd: 200 }, DEFAULT_LIMITS)!, /daily loss limit reached/);
  assert.equal(entryRefusal(a, { ...okCtx, dailyLossRemainingUsd: 250 }, DEFAULT_LIMITS), null);   // exactly enough is enough
});

test("CME hours: closed Saturday, closed in the 17:00–18:00 ET break, open Sunday evening", () => {
  assert.equal(cmeOpen(new Date("2026-09-12T15:00:00Z")), false);         // Saturday
  assert.equal(cmeOpen(new Date("2026-09-14T21:30:00Z")), false);         // Monday 17:30 ET
  assert.equal(cmeOpen(new Date("2026-09-14T22:05:00Z")), true);          // Monday 18:05 ET
  assert.equal(cmeOpen(new Date("2026-09-13T23:00:00Z")), true);          // Sunday 19:00 ET
  assert.equal(cmeOpen(new Date("2026-09-18T21:30:00Z")), false);         // Friday 17:30 ET
  assert.equal(etDayKey(new Date("2026-09-14T03:00:00Z")), "2026-09-13"); // 23:00 ET the day before
});

test("P&L uses the row's point value and charges both sides at the unit's fee", () => {
  assert.equal(tradePnlUsd("long", 6500, 6520, 2, 5), 20 * 5 * 2 - 4 * 0.85);
  assert.equal(tradePnlUsd("short", 6500, 6520, 1, 5), -100 - 1.7);
  assert.equal(tradePnlUsd("long", 6500, 6504, 1, 50, FEE_PER_SIDE_MINI), 200 - 2 * FEE_PER_SIDE_MINI);   // one ES mini, 4 points
});

test("limitsFromConfig clamps every override so a bad key can only shrink risk", () => {
  assert.deepEqual(limitsFromConfig({}), DEFAULT_LIMITS);
  const hi = limitsFromConfig({ basis: "250000", risk: "3", strong: "9", aplus: "6", stage: "Z" });
  assert.equal(hi.sizingBasisUsd, 50_000); assert.equal(hi.riskPct, 1); assert.equal(hi.riskPctStrong, 1); assert.equal(hi.riskPctAplus, 1); assert.equal(hi.stage, "A");
  const lo = limitsFromConfig({ basis: "10", risk: "0.01", stage: "B" });
  assert.equal(lo.sizingBasisUsd, 1_000); assert.equal(lo.riskPct, 0.25); assert.equal(lo.stage, "B");
  const junk = limitsFromConfig({ basis: "abc", risk: null, strong: "", aplus: "NaN", stage: null });
  assert.deepEqual(junk, DEFAULT_LIMITS);
  assert.equal(limitsFromConfig({ basis: "25000", risk: "0.75" }).sizingBasisUsd, 25_000);
});

test("verdict wording matches the other desks", () => {
  assert.match(deskVerdict(0, 0, null, 0), /NO DATA/);
  assert.match(deskVerdict(12, 500, 2.5, 20), /TOO EARLY/);
  assert.match(deskVerdict(31, -5, 2.5, 20), /NO EDGE/);
  assert.match(deskVerdict(31, 500, 2.5, 20), /REAL EDGE/);
  assert.match(deskVerdict(31, 500, 1.2, 20), /PROMISING/);
  assert.equal(tStatOf([1, 1, 1]), null);
  assert.ok((tStatOf([1, 2, 3, 4]) ?? 0) > 3);
});

// ---- rolls (E9) ----------------------------------------------------------------------------------
test("rollDue: Sep 18 09:30 ET expiry, 3-day guard → not due Sep 15 noon ET, due Sep 16 noon ET; metals use 21", () => {
  const exp = "2026-09-18T13:30:00Z";
  assert.equal(rollDue(exp, Date.parse("2026-09-15T16:00:00Z"), 3), false);   // 2d 21.5h away
  assert.equal(rollDue(exp, Date.parse("2026-09-16T16:00:00Z"), 3), true);    // 1d 21.5h < 2d
  assert.equal(rollDue("2026-10-30T13:30:00Z", Date.parse("2026-10-09T16:00:00Z"), 21), false);
  assert.equal(rollDue("2026-10-30T13:30:00Z", Date.parse("2026-10-11T16:00:00Z"), 21), true);
  assert.equal(rollDue(null, Date.now(), 3), false);
  assert.equal(rollDue("not a date", Date.now(), 3), false);
});

test("rollPreview lists only months within 5 days, with the roll date; metals 30 days out are absent", () => {
  const guard = (micro: string) => (micro === "MGC" ? 21 : 3);
  const open = [
    { id: 12, contract: "MESU6", micro: "MES" },
    { id: 13, contract: "MGCZ6", micro: "MGC" },
    { id: 14, contract: "MNQU6", micro: "MNQ" },
  ];
  const now = new Date("2026-09-14T16:00:00Z");
  const plans = rollPreview(open, { 12: "2026-09-18T13:30:00Z", 13: "2026-10-30T13:30:00Z", 14: null }, now, guard);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 12);
  assert.equal(plans[0].rollOn, "2026-09-16T13:30:00.000Z");        // expiry − 2 days
  assert.ok(Math.abs(plans[0].daysToExpiry - 3.896) < 0.01);
  assert.ok(Math.abs(plans[0].daysUntilRoll - 1.896) < 0.01);
  assert.equal(etShortDate(plans[0].rollOn), "Sep 16");
  // The day before: inside one day of the roll.
  const dayBefore = rollPreview(open, { 12: "2026-09-18T13:30:00Z" }, new Date("2026-09-15T16:00:00Z"), guard);
  assert.ok(dayBefore[0].daysUntilRoll <= 1);
  // Overdue (CME was closed when it came due) reads negative, still listed.
  const overdue = rollPreview(open, { 12: "2026-09-18T13:30:00Z" }, new Date("2026-09-17T16:00:00Z"), guard);
  assert.ok(overdue[0].daysUntilRoll < 0);
});
