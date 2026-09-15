import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { clusterEntryAllowed, exposureSummary, positionRiskUsd, type ExposurePosition } from "../src/lib/margin-exposure";
import { REFUSAL_RE, refusalNote } from "../src/lib/margin-risk-tiers";
import { classifyRefusal } from "../src/lib/margin-capacity";
import { LIQ_CUSHION } from "../src/lib/margin-live-risk";

const EQ = 10_000;
// A bot A+ position: $20k at 9× on a 4% stop = $800 risk = 8% of $10k.
const aPlus = (over: Partial<ExposurePosition> = {}): ExposurePosition => ({ pair: "XETHZUSD", side: "long", vol: 5, entryPrice: 4000, leverage: 9, ours: true, stopFrac: 0.04, ...over });
// A Strong one: $10k, 4% stop = $400 = 4%.
const strong = (over: Partial<ExposurePosition> = {}): ExposurePosition => ({ pair: "SOLUSD", side: "long", vol: 50, entryPrice: 200, leverage: 9, ours: true, stopFrac: 0.04, ...over });

test("long / short / gross / net notional, and the all-stops risk from ledgered stops", () => {
  const s = exposureSummary([aPlus(), strong({ side: "short" })], EQ, 15, 0);
  assert.equal(s.positions, 2);
  assert.equal(s.longNotional, 20_000); assert.equal(s.shortNotional, 10_000);
  assert.equal(s.grossNotional, 30_000); assert.equal(s.netNotional, 10_000);
  assert.equal(s.grossToEquity, 3);
  assert.equal(s.riskIfAllStopsHitUsd, 800 + 400);
  assert.equal(s.riskIfAllStopsHitPct, 12);
  assert.equal(s.unledgered, 0);
  assert.equal(s.breakerHeadroomPct, 15);
  assert.equal(s.clusterOk, true, "12% of equity at risk fits inside the 15% headroom");
  const empty = exposureSummary([], EQ, 15, 0);
  assert.equal(empty.riskIfAllStopsHitUsd, 0); assert.equal(empty.clusterOk, true); assert.equal(empty.grossToEquity, 0);
});

test("a position without a ledgered stop — manual, adopted, or a lost ledger entry — counts at the full 0.6/leverage cushion (fail closed)", () => {
  const manual = aPlus({ ours: false, stopFrac: null, leverage: 5 });
  const r = positionRiskUsd(manual);
  assert.equal(r.atCushion, true);
  assert.equal(r.usd, 20_000 * (LIQ_CUSHION / 5), "$20k × 12% = $2,400 — the whole cushion, not a guessed stop");
  const s = exposureSummary([manual], EQ, 15, 0);
  assert.equal(s.unledgered, 1);
  assert.equal(s.riskIfAllStopsHitPct, 24);
  assert.equal(s.clusterOk, false, "a $20k manual 5× position can lose 24% — past the breaker on its own");
  // A bot position whose ledger entry lost its stop is treated the same way: ours is not enough.
  assert.equal(positionRiskUsd(aPlus({ stopFrac: null })).atCushion, true);
  // A known resting stop level wins over the fraction: a stop at breakeven risks nothing; one at +1R nothing either.
  assert.equal(positionRiskUsd(aPlus({ stopPrice: 4000 })).usd, 0);
  assert.equal(positionRiskUsd(aPlus({ stopPrice: 4160 })).usd, 0);
  assert.equal(positionRiskUsd(aPlus({ stopPrice: 3900 })).usd, 100 * 5, "5 ETH × $100 to the resting stop");
  assert.equal(positionRiskUsd(aPlus({ side: "short", entryPrice: 4000, stopPrice: 4100 })).usd, 100 * 5);
});

test("1 / 2 / 3 slots: a second A+ beside a first is refused (8 + 8 > 15); A+ beside Strong is allowed (8 + 4); one slot is inert", () => {
  const cap = 15;   // breaker headroom, no drawdown
  // One slot, flat book: an A+ entry is 8 of 15.
  const flat = exposureSummary([], EQ, cap, 0);
  assert.equal(clusterEntryAllowed(flat, 800, EQ, cap).ok, true);
  // Two slots: A+ open, second A+ wanted → 16 > 15 refused; Strong wanted → 12 allowed.
  const oneAPlus = exposureSummary([aPlus()], EQ, cap, 0);
  const secondAPlus = clusterEntryAllowed(oneAPlus, 800, EQ, cap);
  assert.equal(secondAPlus.ok, false);
  assert.equal(secondAPlus.totalPct, 16);
  assert.equal(clusterEntryAllowed(oneAPlus, 400, EQ, cap).ok, true);
  // Three slots: A+ + Strong open (12%), a Normal (2%) fits (14), another Strong (4%) does not (16).
  const two = exposureSummary([aPlus(), strong()], EQ, cap, 0);
  assert.equal(clusterEntryAllowed(two, 200, EQ, cap).ok, true);
  assert.equal(clusterEntryAllowed(two, 400, EQ, cap).ok, false);
  // Exactly at the cap is allowed; a hair over is not.
  assert.equal(clusterEntryAllowed(oneAPlus, 700, EQ, cap).ok, true);
  assert.equal(clusterEntryAllowed(oneAPlus, 700.01, EQ, cap).ok, false);
});

test("headroom shrinks with the drawdown already taken: at −5% the cap is 10, at −12% it is 3, unreadable = 0", () => {
  assert.equal(exposureSummary([], EQ, 15, 5).breakerHeadroomPct, 10);
  assert.equal(exposureSummary([], EQ, 15, 12).breakerHeadroomPct, 3);
  assert.equal(exposureSummary([], EQ, 15, -3).breakerHeadroomPct, 15, "equity above the peak: full headroom, never more");
  assert.equal(exposureSummary([], EQ, 15, NaN).breakerHeadroomPct, 0);
  assert.equal(exposureSummary([], EQ, NaN, 0).breakerHeadroomPct, 0);
  // At −5% an open A+ (8%) already exceeds the 10% headroom for a second Strong; a Normal (2%) fits exactly.
  const s = exposureSummary([aPlus()], EQ, 15, 5);
  assert.equal(s.clusterOk, true, "8 ≤ 10");
  assert.equal(clusterEntryAllowed(s, 400, EQ, s.breakerHeadroomPct).ok, false);
  assert.equal(clusterEntryAllowed(s, 200, EQ, s.breakerHeadroomPct).ok, true);
  // An operator cap overrides the headroom either way.
  assert.equal(clusterEntryAllowed(s, 400, EQ, 20).ok, true);
  assert.equal(clusterEntryAllowed(s, 100, EQ, 8.5).ok, false);
});

test("non-finite inputs never allow an entry", () => {
  const s = exposureSummary([aPlus()], EQ, 15, 0);
  assert.equal(clusterEntryAllowed(s, NaN, EQ, 15).ok, false);
  assert.equal(clusterEntryAllowed(s, 100, 0, 15).ok, false);
  assert.equal(clusterEntryAllowed(s, 100, Infinity, 15).ok, false);
  assert.equal(clusterEntryAllowed(s, 100, EQ, NaN).ok, false);
  assert.equal(clusterEntryAllowed({ riskIfAllStopsHitUsd: NaN }, 100, EQ, 15).ok, false);
  assert.equal(clusterEntryAllowed(s, -1, EQ, 15).ok, false, "negative new risk is a bug, not a free pass");
});

test("the refusal string is built in one place, matched by REFUSAL_RE and filed as 'cluster' by the capacity ledger", () => {
  const note = refusalNote.cluster(800, 800, 15, 10_000);
  assert.equal(note, "entry refused: all-stops risk $800 + $800 would exceed the cluster cap 15.0% of equity ($10000) — every open stop hit at once must stay inside the breaker's headroom");
  assert.match(note, REFUSAL_RE.cluster);
  assert.equal(classifyRefusal(null, note), "cluster");
  assert.match(refusalNote.clusterCapInvalid("abc"), REFUSAL_RE.clusterCapInvalid);
  assert.equal(classifyRefusal("OTXID", note), "taken");
});

test("the executor's cluster gate sits after the liquidation buffer and before the minimum-order check, reads the cap strictly, and goes through refuse()", () => {
  const exec = readFileSync(new URL("../src/lib/margin-executor.ts", import.meta.url), "utf8");
  const entry = exec.split("// ---- ENTRY PATH ----")[1] ?? "";
  const liq = entry.indexOf("refusalNote.liqBuffer(stopPct, leverage)");
  const cluster = entry.indexOf("clusterEntryAllowed(exposure, notional * riskDist, equity, capPct)");
  const minOrder = entry.indexOf("below Kraken minimum");
  assert.ok(liq > 0 && cluster > liq && minOrder > cluster, "gate order: liq buffer → cluster → min order");
  assert.ok(/cfgStrict\("kraken_margin_cluster_risk_cap_pct"\)/.test(entry), "the cap is a STRICT read");
  assert.ok(/return refuse\(refusalNote\.cluster\(/.test(entry), "the refusal persists a card");
  assert.ok(/Math\.max\(0, ddHaltPct - Math\.max\(0, ddTier\.dd\)\)/.test(entry), "default cap = breaker headroom");
});
