import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { OPTIONS_SCORE_RULES, SCORE_CAPS, ivRank, optionsOpportunityScore, scoreInputsFor, type ScoreInputs } from "../src/lib/options-score";
import { OPTIONS_SCORE_LEDGER_RULES, bucketOf, bucketStats, intrinsicAt, promotionVerdict, resolveCandidates, scoreResearchCandidates, type ResolvedCandidate } from "../src/lib/options-score-ledger";
import { buildOptionsObservation, parseOptionsObservation } from "../src/lib/options-evidence-model";
import { liveEnterableKinds, noCandidateNote, screenResearchContracts, type OptionsResearch, type ResearchBar, type ResearchContract } from "../src/lib/options-desk-model";
import { OPTIONS_LIVE_RULES } from "../src/lib/options-live-guardian";
import type { AccountSnapshot } from "../src/lib/options-quote-store";

const NOW = Date.parse("2026-09-15T15:00:00Z");
const AT = new Date(NOW).toISOString();
const best: ScoreInputs = { setup: "20-session breakout", relativeVolume: 2.5, chase: 0.8, earningsClass: "none", earningsAt: "2026-11-20", exDivAt: null, expiry: "2026-10-16",
  ivToRealized: 0.9, ivRank: 20, spreadPct: 2, thetaPerDayPct: 0.8, openInterest: 9000, volume: 3000, payoffAtMoveUsd: 300, plannedLoss: 90, maxProfit: null, marketAligned: true, targetDelta: 0.6 };

test("caps: every component tops out at its cap and the total at 100; the worst inputs floor at 0; the score is a labelled paper ranker", () => {
  const top = optionsOpportunityScore(best);
  assert.equal(top.score, 100); assert.equal(top.label, "paper ranker"); assert.equal(top.liveLine, 80); assert.deepEqual(top.missing, []);
  for (const [name, comp] of Object.entries(top.components)) assert.equal(comp.points, SCORE_CAPS[name as keyof typeof SCORE_CAPS], name);
  assert.equal(Object.values(SCORE_CAPS).reduce((a, b) => a + b, 0), 100);
  const worst = optionsOpportunityScore({ ...best, setup: "No directional setup", relativeVolume: 0.5, chase: 3, earningsClass: "EARNINGS TRADE", earningsAt: "2026-10-01", ivToRealized: 2, ivRank: 90, spreadPct: 12, thetaPerDayPct: 5, openInterest: 100, volume: 10, payoffAtMoveUsd: -10, marketAligned: false, targetDelta: 0.1 });
  assert.equal(worst.components.direction.points, 0); assert.equal(worst.components.catalyst.points, 0); assert.equal(worst.components.pricing.points, 2); assert.equal(worst.components.liquidity.points, 2);
  assert.equal(worst.components.riskReward.points, 0); assert.equal(worst.components.momentum.points, 1); assert.equal(worst.components.market.points, 0); assert.equal(worst.components.ev.points, 0);
  assert.equal(worst.score, 5);
  // Monotone: a better input never lowers the score.
  assert.ok(optionsOpportunityScore({ ...best, spreadPct: 4 }).score <= top.score);
  assert.ok(optionsOpportunityScore({ ...best, setup: "Trend watch" }).score < top.score);
  assert.equal(optionsOpportunityScore({ ...best, setup: "Trend watch" }).components.direction.points, 8);
});

test("catalyst: earnings inside the expiry zeroes it; an event within 3 days of expiry costs 5; unknown earnings scores half and is named missing", () => {
  assert.equal(optionsOpportunityScore({ ...best, earningsAt: "2026-10-16" }).components.catalyst.points, 0, "earnings on expiry day");
  assert.equal(optionsOpportunityScore({ ...best, earningsClass: "EARNINGS TRADE", earningsAt: "2026-10-01" }).components.catalyst.points, 0);
  assert.equal(optionsOpportunityScore({ ...best, earningsAt: "2026-10-18" }).components.catalyst.points, 10, "earnings two days after expiry");
  assert.equal(optionsOpportunityScore({ ...best, earningsAt: "2026-10-20" }).components.catalyst.points, 15, "four days after");
  assert.equal(optionsOpportunityScore({ ...best, exDivAt: "2026-10-14" }).components.catalyst.points, 10, "ex-div two days before expiry");
  const unknown = optionsOpportunityScore({ ...best, earningsClass: "unknown", earningsAt: null });
  assert.equal(unknown.components.catalyst.points, 7); assert.ok(unknown.missing.includes("earnings calendar"));
});

test("missing: IV-rank is listed until the archive holds 30 days, and the pricing component is capped at 11 without it; every other missing input names itself", () => {
  const noRank = optionsOpportunityScore({ ...best, ivRank: null });
  assert.ok(noRank.missing.includes(`IV-rank (needs ≥${OPTIONS_SCORE_RULES.ivRankMinDays} archive days)`));
  assert.equal(noRank.components.pricing.points, 11); assert.equal(noRank.score, 96);
  const blind = optionsOpportunityScore({ ...best, ivToRealized: null, ivRank: null, spreadPct: null, thetaPerDayPct: null, openInterest: null, volume: null, payoffAtMoveUsd: null, relativeVolume: null, marketAligned: null, targetDelta: null });
  assert.deepEqual(blind.missing, ["IV/RV", "IV-rank (needs ≥30 archive days)", "spread %", "theta/day", "open interest / volume", "expected move", "relative volume", "market alignment", "EV inputs"]);
  assert.equal(blind.score, 20 + 15 + 4 + 4 + 0 + 4 + 2 + 0);
  // ivRank from the archive: 29 distinct days → null with the count; 30 → a percentile of the per-day median IV.
  const obs = (day: number, iv: number) => ({ capturedAt: `2026-08-${String(day).padStart(2, "0")}T15:00:00Z`, quotes: [{ symbol: "SOFI", iv }, { symbol: "SOFI", iv: iv + 0.02 }, { symbol: "AAPL", iv: 0.2 }] });
  const twentyNine = Array.from({ length: 29 }, (_, i) => obs(i + 1, 0.3 + i * 0.01));
  assert.deepEqual(ivRank("SOFI", 0.5, twentyNine), { rank: null, days: 29 });
  const thirty = [...twentyNine, obs(30, 0.59), obs(30, 0.59)];   // two runs on one day count once
  const r = ivRank("SOFI", 0.45, thirty);
  assert.equal(r.days, 30); assert.equal(r.rank, Math.round((0.45 - 0.31) / (0.60 - 0.31) * 100));
  assert.equal(ivRank("AAPL", 0.2, thirty).rank, 50, "flat history → 50");
  assert.equal(ivRank("NVDA", 0.4, thirty).days, 0);
});

// A SOFI-style fixture: a breakout name and a Trend-watch name, one call each, and bars that run past the settlement session.
function fixture(): OptionsResearch {
  const bars = (breakout: boolean): ResearchBar[] => Array.from({ length: 201 }, (_, i) => {
    const day = new Date(NOW - (201 - i) * 86_400_000).toISOString().slice(0, 10);
    if (i === 200) return { day, open: 11.5, high: 12.2, low: 11.4, close: breakout ? 12.1 : 11.5, volume: 2_000_000 };
    if (i >= 180) return { day, open: 11, high: 12.0, low: 10.2, close: 11, volume: 1_000_000 };
    return { day, open: 10.5, high: 10.8, low: 10.2, close: 10.5, volume: 1_000_000 };
  });
  const base = { multiplier: 100, bidSize: 20, askSize: 20, at: AT, volume: 3000, openInterest: 8000, selloutAt: null, expiry: "2026-10-16", iv: 0.4, theta: -0.02 };
  const contracts: ResearchContract[] = [
    { ...base, id: "sc", symbol: "SOFI", type: "call", strike: 12, bid: 0.80, ask: 0.85, delta: 0.55 },
    { ...base, id: "sc13", symbol: "SOFI", type: "call", strike: 13, bid: 0.37, ask: 0.40, delta: 0.35 },
    { ...base, id: "sp", symbol: "SOFI", type: "put", strike: 12, bid: 0.65, ask: 0.70, delta: -0.45 },
    { ...base, id: "wc", symbol: "WTCH", type: "call", strike: 12, bid: 0.50, ask: 0.55, delta: 0.45 },
    { ...base, id: "wp", symbol: "WTCH", type: "put", strike: 12, bid: 0.80, ask: 0.85, delta: -0.55 },
  ];
  const event = { earningsAt: null, earningsTiming: null, calendarThrough: "2026-11-15", exDivAt: null, dividendAmount: null, at: AT };
  return { capturedAt: AT, source: "Robinhood MCP", bars: { SOFI: bars(true), WTCH: bars(false) }, contracts, scans: [], errors: [], events: { SOFI: event, WTCH: event } };
}
const account: AccountSnapshot = { accountNumber: "685528705", type: "limited_margin", optionLevel: "option_level_3", cash: 1500, buyingPower: 1500, optionsValue: 0, totalValue: 1500, at: AT };

test("the scoring universe is breakouts AND trend-watch names: includeWatch builds-but-refuses watch structures stamped 'no breakout', appended after the breakouts; the live screen without it is unchanged", () => {
  const data = fixture();
  const live = screenResearchContracts(data, 150, 1500, NOW);
  assert.deepEqual(live.map((c) => [c.symbol, c.kind, c.strikes.join("/"), c.refusedBy]), [["SOFI", "call_debit", "12/13", null], ["SOFI", "long_call", "12", null]]);   // the 13 call's theta eats its payoff
  const all = screenResearchContracts(data, 150, 1500, NOW, { includeWatch: true });
  assert.deepEqual(all.map((c) => [c.symbol, c.setup, c.refusedBy]), [["SOFI", "20-session breakout", null], ["SOFI", "20-session breakout", null], ["WTCH", "Trend watch", "no breakout"]]);
  assert.deepEqual(all.filter((c) => !c.refusedBy), live, "every breakout row, in order, is byte-identical either way");
  assert.equal(noCandidateNote(data, 150, NOW), noCandidateNote({ ...data, bars: { ...data.bars } }, 150, NOW));
  const noBreak = { ...data, bars: { WTCH: data.bars.WTCH } };
  assert.match(noCandidateNote(noBreak, 150, NOW), /^no entry: no 20-session breakout or breakdown among the 1 researched names/);
  assert.equal(all[0].signalDay, data.bars.SOFI.at(-1)!.day); assert.equal(all[0].relativeVolume, 2);
  const { rows, scores } = scoreResearchCandidates(data, 150, 1500, NOW);
  assert.equal(rows.length, 3); assert.ok(rows[0].score > rows[2].score, "the breakout outscores the watch name");
  assert.equal(rows[2].refusedBy, "no breakout"); assert.ok(rows[0].missing.includes("IV-rank (needs ≥30 archive days)"));
  assert.equal(scores.get(rows[0].key)!.components.direction.points, 20); assert.equal(scores.get(rows[2].key)!.components.direction.points, 8);
  const inputs = scoreInputsFor(all[1], data.contracts, 25);
  assert.deepEqual([inputs.openInterest, inputs.volume, inputs.targetDelta, inputs.ivRank, inputs.thetaPerDayPct], [8000, 3000, 0.55, 25, 2.35]);   // 0.02 / 0.85
  // The observation carries the scored rows (tolerant: a record without them still parses; a malformed row is dropped, not the record).
  const obs = buildOptionsObservation(data, 150, account, NOW, { ivRanks: { SOFI: 25 } });
  assert.equal(obs.candidates!.length, 3); assert.equal(obs.symbols.find((s) => s.symbol === "WTCH")!.researchCandidates, 0, "the existing per-symbol count stays breakout-only");
  const parsed = parseOptionsObservation(JSON.stringify(obs))!;
  assert.equal(parsed.candidates!.length, 3);
  const legacy = parseOptionsObservation(JSON.stringify({ ...obs, candidates: undefined }))!;
  assert.equal(legacy.candidates, undefined);
  const dirty = parseOptionsObservation(JSON.stringify({ ...obs, candidates: [obs.candidates![0], { junk: true }] }))!;
  assert.equal(dirty.candidates!.length, 1);
});

test("credit spreads never enter the ledger: two puts below the close build a put credit for research (debit math would settle it with the sign inverted), and it is filtered out of every scored row", () => {
  const data = fixture();
  const base = { multiplier: 100, bidSize: 20, askSize: 20, at: AT, volume: 3000, openInterest: 8000, selloutAt: null, expiry: "2026-10-16", iv: 0.4, theta: -0.02, symbol: "SOFI" };
  data.contracts.push({ ...base, id: "p11", type: "put", strike: 11, bid: 0.40, ask: 0.42, delta: -0.25 }, { ...base, id: "p10", type: "put", strike: 10, bid: 0.10, ask: 0.12, delta: -0.12 });
  const raw = screenResearchContracts(data, 150, 1500, NOW, { includeWatch: true });
  const credit = raw.find((c) => c.kind === "put_credit")!;
  assert.ok(credit, "the screen still builds the credit for research display"); assert.ok(credit.strikes[0] < credit.strikes[1] && credit.strikes[1] < 12.1, "long put below the short put, both below the close");
  assert.equal(intrinsicAt(credit.kind, credit.strikes, 13) - credit.limit < 0, true, "debit math would call a worthless-expiring credit a loss — the sign is wrong for a credit");
  assert.deepEqual(liveEnterableKinds(raw).map((c) => c.kind), raw.filter((c) => (OPTIONS_LIVE_RULES.entryKinds as string[]).includes(c.kind)).map((c) => c.kind));
  assert.ok(liveEnterableKinds(raw).length < raw.length);
  const { rows } = scoreResearchCandidates(data, 150, 1500, NOW);
  assert.ok(rows.length >= 3 && rows.every((r) => !r.kind.endsWith("_credit")), `no credit row in ${rows.map((r) => r.kind)}`);
  const obs = buildOptionsObservation(data, 150, account, NOW);
  assert.ok(obs.candidates!.every((r) => !r.kind.endsWith("_credit")));
});

test("resolution: settles at the 10th session after the signal, or at expiry − 7 days when that comes first, as intrinsic − debit − fee; one row per structure per settlement window (first scoring wins, a re-score after settlement starts a new row); unreached rows stay pending", () => {
  const data = fixture();
  const { rows } = scoreResearchCandidates(data, 150, 1500, NOW);
  const sofi = rows.find((r) => r.kind === "long_call" && r.strikes[0] === 12)!;   // the 12 call at 0.85
  const signalDay = data.bars.SOFI.at(-1)!.day;
  const later = (n: number, close: number): ResearchBar[] => Array.from({ length: n }, (_, i) => ({ day: new Date(Date.parse(`${signalDay}T00:00:00Z`) + (i + 1) * 86_400_000).toISOString().slice(0, 10), open: close, high: close, low: close, close, volume: 1 }));
  const obsA = { screenedAt: AT, candidates: [sofi] }, obsB = { screenedAt: new Date(NOW + 3_600_000).toISOString(), candidates: [{ ...sofi, debit: 0.99 }] };
  // A Trend-watch name re-screened the NEXT day is the same structure inside the same settlement window: one row, the first scoring's.
  const obsC = { screenedAt: new Date(NOW + 86_400_000).toISOString(), candidates: [{ ...sofi, debit: 0.70, signalDay: later(1, 12)[0].day }] };
  const overlap = resolveCandidates([obsA, obsB, obsC], { SOFI: [...data.bars.SOFI, ...later(10, 13)] });
  assert.equal(overlap.resolved.length, 1); assert.equal(overlap.resolved[0].debit, 0.85); assert.equal(overlap.pending.length, 0);
  // Re-scored AFTER that row settled (day 12, a fresh signal) → a new row in a new window, pending until its own bars arrive.
  const obsD = { screenedAt: new Date(NOW + 12 * 86_400_000).toISOString(), candidates: [{ ...sofi, debit: 0.70, signalDay: later(12, 12)[11].day }] };
  const rescored = resolveCandidates([obsA, obsD], { SOFI: [...data.bars.SOFI, ...later(12, 13)] });
  assert.equal(rescored.resolved.length, 1); assert.equal(rescored.pending.length, 1); assert.equal(rescored.pending[0].debit, 0.70);
  // Nine sessions after the signal → pending, with the latest settlement day named.
  const nine = resolveCandidates([obsA, obsB], { SOFI: [...data.bars.SOFI, ...later(9, 13)] });
  assert.equal(nine.resolved.length, 0); assert.equal(nine.pending.length, 1); assert.equal(nine.pending[0].settlesBy, "2026-10-09");
  // Ten sessions → settled on the tenth at intrinsic (13 − 12 = 1.00) − 0.85 debit = $15 − $1 fee = $14. The second run's re-score of the same row is ignored.
  const ten = resolveCandidates([obsB, obsA], { SOFI: [...data.bars.SOFI, ...later(10, 13)] });
  assert.equal(ten.resolved.length, 1); assert.equal(ten.resolved[0].settledOn, later(10, 13)[9].day); assert.equal(ten.resolved[0].pnlUsd, 14); assert.equal(ten.resolved[0].debit, 0.85);
  assert.equal(ten.resolved[0].note, "settlement proxy, no fills, no slippage"); assert.equal(ten.resolved[0].bucket, bucketOf(sofi.score));
  // Expiry − 7 days first: an Oct 1 expiry (cutoff Sep 24) with bars past the cutoff settles on the last session on/before Sep 24, at a loss when the stock sits at 12.
  const soon = { ...sofi, expiry: "2026-10-01" };
  const bars = [...data.bars.SOFI, ...later(12, 12)];   // Sep 15 → Sep 27
  const early = resolveCandidates([{ screenedAt: AT, candidates: [soon] }], { SOFI: bars });
  assert.equal(early.resolved[0].settledOn, "2026-09-24"); assert.equal(early.resolved[0].pnlUsd, -86);   // 0 intrinsic − 0.85 → −$85 − $1
  assert.equal(intrinsicAt("put_debit", [12, 11], 10), 1); assert.equal(intrinsicAt("long_put", [12], 13), 0); assert.equal(intrinsicAt("call_debit", [12, 13], 15), 1);
  assert.equal(resolveCandidates([{ screenedAt: AT }], {}).resolved.length, 0, "a legacy observation without candidates is fine");
});

test("promotion gate: refuses at n=29 in any bucket, refuses when the top mean does not beat the bottom or Welch t < 2, passes only on the full rule", () => {
  const row = (score: number, pnl: number, i: number): ResolvedCandidate => ({ key: `k${score}:${i}`, symbol: "X", kind: "long_call", expiry: "2026-10-16", strikes: [10], direction: "bullish", setup: "20-session breakout", signalDay: "2026-09-01", spot: 10, debit: 1, feeReserve: 1, plannedLoss: 101, score, missing: [], refusedBy: null, deltaBand: "prompt", dteBucket: "30-45", version: "v", screenedAt: AT, bucket: bucketOf(score), settledOn: "2026-09-15", settleClose: 10, pnlUsd: pnl, note: "settlement proxy, no fills, no slippage" });
  const fill = (score: number, n: number, mean: number, spread: number) => Array.from({ length: n }, (_, i) => row(score, mean + (i % 2 ? spread : -spread), i));
  const green = [...fill(85, 30, 40, 20), ...fill(75, 30, 10, 20), ...fill(50, 30, -20, 20)];
  const v = promotionVerdict(bucketStats(green));
  assert.equal(v.green, true); assert.deepEqual(v.reasons, []); assert.ok(v.welchT! >= 2); assert.equal(v.registeredAt, OPTIONS_SCORE_LEDGER_RULES.registeredAt);
  assert.match(v.rule, /one row per structure per settlement window \(first scoring wins\) · debit structures only, credit spreads not measured yet/);
  const short = promotionVerdict(bucketStats([...fill(85, 29, 40, 20), ...fill(75, 30, 10, 20), ...fill(50, 30, -20, 20)]));
  assert.equal(short.green, false); assert.deepEqual(short.reasons, ["≥80: 29 of 30 resolved"]);
  const middleShort = promotionVerdict(bucketStats([...fill(85, 30, 40, 20), ...fill(75, 29, 10, 20), ...fill(50, 30, -20, 20)]));
  assert.deepEqual(middleShort.reasons, ["70–79: 29 of 30 resolved"]);
  const backwards = promotionVerdict(bucketStats([...fill(85, 30, -20, 20), ...fill(75, 30, 10, 20), ...fill(50, 30, 40, 20)]));
  assert.equal(backwards.green, false); assert.match(backwards.reasons[0], /≥80 mean \$-20 does not beat <70 mean \$40/);
  const noisy = promotionVerdict(bucketStats([...fill(85, 30, 12, 200), ...fill(75, 30, 10, 200), ...fill(50, 30, 8, 200)]));
  assert.equal(noisy.green, false); assert.match(noisy.reasons[0], /Welch t .* < 2/);
  const stats = bucketStats(green);
  assert.deepEqual(stats.map((b) => [b.name, b.n, b.mean]), [["≥80", 30, 40], ["70–79", 30, 10], ["<70", 30, -20]]);
  assert.deepEqual([bucketOf(80), bucketOf(79.9), bucketOf(70), bucketOf(69), bucketOf(100), bucketOf(0)], ["≥80", "70–79", "70–79", "<70", "≥80", "<70"]);
});

test("the score never reaches the live entry gate: the runner's decision path, the policy, the executor, the ladder and the screen do not import it; structurally, pickCandidate holds no score or card reference and the cards are built only after the core has answered and the thesis is stashed", () => {
  for (const file of ["scripts/robinhood/live-desk.ts", "src/lib/options-live-policy.ts", "src/lib/options-live-executor.ts", "src/lib/options-risk-ladder.ts", "src/lib/options-desk-model.ts", "src/lib/options-live-guardian.ts"]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/options-score/.test(src), `${file} must not import the score`);
    assert.ok(!/optionsOpportunityScore/.test(src), `${file} must not call the score`);
  }
  const runner = readFileSync(new URL("../scripts/robinhood/live-desk.ts", import.meta.url), "utf8");
  // The decision function, sliced to its own body: from its signature to the next top-level function.
  const start = runner.indexOf("async function pickCandidate(");
  const rest = runner.slice(start + 1), nextTop = rest.search(/\n(async )?function /);
  const body = runner.slice(start, start + 1 + nextTop);
  assert.ok(start > 0 && nextTop > 0 && body.length > 2000, "pickCandidate located");
  const code = body.replace(/\/\/[^\n]*/g, "");   // identifiers, not comments
  assert.ok(!/\bscore\b/i.test(code), "no score inside pickCandidate");
  assert.ok(!/[cC]ards?\b/.test(code), "no card inside pickCandidate");
  assert.match(body, /gradeFor\(\{ \.\.\.c, spreadPct \}, ctx\.promoted\)/, "the runner passes no score to gradeFor — A+ stays unreachable until a later PR feeds it");
  // In the entry tick, every card reference comes AFTER the core's answer and after the candidate stash; the builder is the throw-safe one.
  const execAt = runner.indexOf("res = await executeOptionsIntent(pick.intent, entryDeps)");
  const stashAt = runner.indexOf("candidate: { ...pick.candidate }");
  const cardsAt = runner.indexOf("safeEntryTickCards(");
  const persistAt = runner.indexOf("persistEntryDecision(cards");
  assert.ok(execAt > 0 && stashAt > execAt && cardsAt > stashAt && persistAt > cardsAt, `order: exec ${execAt} < stash ${stashAt} < cards ${cardsAt} < persist ${persistAt}`);
  assert.equal(runner.split("safeEntryTickCards(").length, 2, "one card build per tick");
  assert.ok(!/\bentryTickCards\(/.test(runner), "the runner never calls the raw builder");
  assert.equal(runner.indexOf("safeEntryTickCards("), runner.lastIndexOf("safeEntryTickCards("));
});
