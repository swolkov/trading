import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, entryRefusal, parseAlert, type AlertPayload, type DeskContext } from "../src/lib/futures-desk-rules";
import { CLUSTER_OF, clusterOf, clusterRisk, dailyLossRemaining, ddTier, deskContextOf, openRisk, parseRiskState, riskStateOf, type OpenRow } from "../src/lib/futures-desk-risk";

const es = (): AlertPayload => { const p = parseAlert({ desk: "futures", edge: "index_daily_mr", symbol: "ES", action: "entry", side: "long", price: 6500, stop: 6440, bar: "2026-09-14T21:00:00Z" }); if (!p.ok) throw new Error(p.reason); return p.alert; };
const ym = (): AlertPayload => ({ ...es(), root: "YM" });
const okCtx: DeskContext = {
  enabled: true, openRoots: [], entriesToday: 0, dayPnlUsd: 0, equityUsd: 50_000, equityHighUsd: 50_000, guardianFreshMs: 60_000,
  openRiskUsd: 0, sameClusterSameSideRiskUsd: 0, dailyLossRemainingUsd: 750, ddMult: 1, newRiskUsd: 250,
};
const book: OpenRow[] = [{ root: "ES", side: "long", risk_usd: 250 }, { root: "NQ", side: "long", risk_usd: 250 }, { root: "GC", side: "long", risk_usd: 250 }];

test("drawdown tiers: −2.99 → 0/×1, −3 → 1/×0.75, −5 → 2/×0.5, −7 → 3/×0.25, −10 → 4/halted; no high → tier 0", () => {
  assert.deepEqual([ddTier(48_505, 50_000).tier, ddTier(48_505, 50_000).mult], [0, 1]);
  assert.deepEqual([ddTier(48_500, 50_000).tier, ddTier(48_500, 50_000).mult], [1, 0.75]);
  assert.deepEqual([ddTier(47_500, 50_000).tier, ddTier(47_500, 50_000).mult], [2, 0.5]);
  assert.deepEqual([ddTier(46_500, 50_000).tier, ddTier(46_500, 50_000).mult], [3, 0.25]);
  const halt = ddTier(45_000, 50_000);
  assert.equal(halt.tier, 4); assert.equal(halt.mult, 0); assert.match(halt.label, /halt/);
  assert.equal(ddTier(45_000, 0).tier, 0); assert.equal(ddTier(NaN, 50_000).mult, 1);
  assert.ok(Math.abs(ddTier(48_500, 50_000).ddPct + 3) < 1e-9);
});

test("daily loss remaining counts realized AND open risk against the $750 budget", () => {
  assert.equal(dailyLossRemaining(49_380, 50_000, 250, DEFAULT_LIMITS), -120);   // 750 − 620 − 250
  assert.equal(dailyLossRemaining(49_380, 50_000, 0, DEFAULT_LIMITS), 130);
  assert.equal(dailyLossRemaining(50_000, 50_000, 0, DEFAULT_LIMITS), 750);
});

test("open risk sums the book; cluster risk slices it by cluster × side", () => {
  assert.equal(openRisk(book), 750);
  assert.equal(clusterRisk(book, "index", "long"), 500);
  assert.equal(clusterRisk(book, "metals", "long"), 250);
  assert.equal(clusterRisk(book, "index", "short"), 0);
  assert.equal(clusterOf("RTY"), "index"); assert.equal(clusterOf("CL"), null); assert.equal(CLUSTER_OF.HG, "metals");
});

test("refusal strings, exactly", () => {
  assert.equal(entryRefusal(es(), { ...okCtx, openRiskUsd: 750, newRiskUsd: 250 }, DEFAULT_LIMITS), "open risk $750 + $250 would use up the 2% cap ($1,000)");
  // ES $250 + NQ $250 already long → a YM third would take the index cluster past the $500 (A+) cap.
  const two = [book[0], book[1]];
  const ctx = deskContextOf({ enabled: true, state: { equity: 50_000, equityHigh: 50_000, dayKey: "2026-09-15", dayStartEquity: 50_000, balance: 50_000, dayStartBalance: 50_000, guardianAt: "2026-09-15T15:59:00Z" }, open: two, entriesToday: 2, limits: DEFAULT_LIMITS, alert: { root: "YM", side: "long" }, newRiskUsd: 250, now: new Date("2026-09-15T16:00:00Z"), dayKey: "2026-09-15" });
  assert.ok(!("refusal" in ctx));
  if ("refusal" in ctx) return;
  assert.equal(ctx.sameClusterSameSideRiskUsd, 500); assert.equal(ctx.openRiskUsd, 500); assert.equal(ctx.dailyLossRemainingUsd, 250);
  assert.equal(entryRefusal(ym(), ctx, DEFAULT_LIMITS), "index longs already risk $500 — adding $250 exceeds the $500 cluster cap");
  // ES + NQ only: the second index long is allowed.
  const one = deskContextOf({ enabled: true, state: { equity: 50_000, equityHigh: 50_000, dayKey: "2026-09-15", dayStartEquity: 50_000, balance: 50_000, dayStartBalance: 50_000, guardianAt: "2026-09-15T15:59:00Z" }, open: [book[0]], entriesToday: 1, limits: DEFAULT_LIMITS, alert: { root: "NQ", side: "long" }, newRiskUsd: 250, now: new Date("2026-09-15T16:00:00Z"), dayKey: "2026-09-15" });
  if ("refusal" in one) throw new Error(one.refusal);
  assert.equal(entryRefusal({ ...es(), root: "NQ" }, one, DEFAULT_LIMITS), null);
  assert.equal(entryRefusal(es(), { ...okCtx, dailyLossRemainingUsd: -120, openRiskUsd: 250 }, DEFAULT_LIMITS), "daily loss limit reached: −$620 realized and $250 open risk against $750");
  assert.equal(entryRefusal(es(), { ...okCtx, equityUsd: 45_000, equityHighUsd: 50_000 }, DEFAULT_LIMITS), "equity is 10% off its high — desk halted pending review");
});

test("riskStateOf carries the four cluster keys; parseRiskState round-trips and refuses junk", () => {
  const rs = riskStateOf({ equity: 48_400, equityHigh: 50_000, balance: 49_500, dayStartBalance: 50_000, open: book, limits: DEFAULT_LIMITS, now: new Date("2026-09-15T16:00:00Z") });
  assert.equal(rs.tier, 1); assert.equal(rs.mult, 0.75); assert.equal(rs.openRisk, 750);
  assert.deepEqual(rs.clusterRisk, { index_long: 500, index_short: 0, metals_long: 250, metals_short: 0 });
  assert.equal(rs.dailyLossRemaining, 750 - 500 - 750);
  assert.equal(rs.at, "2026-09-15T16:00:00.000Z");
  assert.deepEqual(parseRiskState(JSON.stringify(rs)), rs);
  for (const raw of [null, undefined, "", "{", "[]", "null", JSON.stringify({ ...rs, openRisk: "750" }), JSON.stringify({ ...rs, clusterRisk: {} }), JSON.stringify({ ...rs, dd: NaN })]) assert.equal(parseRiskState(raw), null);
});

test("deskContextOf fails closed on entries until the guardian has stamped the balances", () => {
  const base = { enabled: true, open: [] as OpenRow[], entriesToday: 0, limits: DEFAULT_LIMITS, alert: { root: "ES", side: "long" as const }, newRiskUsd: 250, now: new Date("2026-09-15T16:00:00Z"), dayKey: "2026-09-15" };
  const r = deskContextOf({ ...base, state: { equity: 50_000, equityHigh: 50_000, guardianAt: "2026-09-15T15:59:00Z" } });
  assert.ok("refusal" in r && /waiting for the guardian/.test(r.refusal));
  const ok = deskContextOf({ ...base, state: { equity: 50_000, equityHigh: 50_000, guardianAt: "2026-09-15T15:59:00Z", balance: 49_900, dayStartBalance: 50_000, dayKey: "2026-09-15", dayStartEquity: 50_000 } });
  if ("refusal" in ok) throw new Error(ok.refusal);
  assert.equal(ok.dailyLossRemainingUsd, 650); assert.equal(ok.ddMult, 1); assert.equal(ok.guardianFreshMs, 60_000);
  // A disabled reason on the state reads as disabled; a tier-2 drawdown carries ×0.5.
  const dd = deskContextOf({ ...base, state: { equity: 47_000, equityHigh: 50_000, guardianAt: "2026-09-15T15:59:00Z", balance: 47_000, dayStartBalance: 47_000, disabledReason: "x" } });
  if ("refusal" in dd) throw new Error(dd.refusal);
  assert.equal(dd.enabled, false); assert.equal(dd.ddMult, 0.5);
});
