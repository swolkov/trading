import assert from "node:assert/strict";
import test from "node:test";
import { OPTIONS_BRIEF_RULES, buildOptionsBrief, deriveOptionsAction, edgeDistancePct, renderOptionsBrief, volRegimeOf, type BriefContext } from "../src/lib/options-brief";
import { OPTIONS_BRIEF_MAX_POSTS_PER_DAY, slackDecision } from "../src/lib/options-brief-store";
import type { OptionsResearch, ResearchBar, ResearchContract } from "../src/lib/options-desk-model";

const NOW = Date.parse("2026-09-15T15:00:00Z");
const AT = new Date(NOW).toISOString();
// SOFI breaks out to 12.10 over 10.20–12.00; WTCH trends at 11.85 under a 12.00 edge (1.27% away); FARR trends at 11.00 (9.1% away).
// SPY sits above its 20-day and +0.4% on the day. Each name has an ATM call and put on Oct 16.
function research(opts: { spyBelowAndDown?: boolean; sofiEarnings?: string | null } = {}): OptionsResearch {
  const bars = (close: number): ResearchBar[] => Array.from({ length: 201 }, (_, i) => {
    const day = new Date(NOW - (201 - i) * 86_400_000).toISOString().slice(0, 10);
    if (i === 200) return { day, open: 11.5, high: Math.max(12.2, close), low: 11.4, close, volume: 2_000_000 };
    if (i === 199) return { day, open: 11, high: 12.0, low: 10.2, close: 11.9, volume: 1_000_000 };   // a modest signal-day move (+1.7%), not a chase
    if (i >= 180) return { day, open: 11, high: 12.0, low: 10.2, close: 11, volume: 1_000_000 };
    return { day, open: 10.5, high: 10.8, low: 10.2, close: 10.5, volume: 1_000_000 };
  });
  const spy: ResearchBar[] = Array.from({ length: 60 }, (_, i) => { const day = new Date(NOW - (60 - i) * 86_400_000).toISOString().slice(0, 10); const close = i === 59 ? (opts.spyBelowAndDown ? 630 : 662) : i === 58 ? (opts.spyBelowAndDown ? 645 : 659.4) : 655; return { day, open: close, high: close, low: close, close, volume: 1 }; });
  const base = { multiplier: 100, bidSize: 20, askSize: 20, at: AT, volume: 3000, openInterest: 8000, selloutAt: null, expiry: "2026-10-16", iv: 0.4, theta: -0.02 };
  const pair = (symbol: string, id: string): ResearchContract[] => [
    { ...base, id: `${id}c`, symbol, type: "call", strike: 12, bid: 0.80, ask: 0.85, delta: 0.55 },
    { ...base, id: `${id}p`, symbol, type: "put", strike: 12, bid: 0.65, ask: 0.70, delta: -0.45 },
  ];
  const event = (earningsAt: string | null) => ({ earningsAt, earningsTiming: null, calendarThrough: "2026-11-15", exDivAt: null, dividendAmount: null, at: AT });
  return { capturedAt: AT, source: "Robinhood MCP", bars: { SOFI: bars(12.1), WTCH: bars(11.85), FARR: bars(11.0), SPY: spy }, contracts: [...pair("SOFI", "s"), ...pair("WTCH", "w"), ...pair("FARR", "f")], scans: [], errors: [],
    events: { SOFI: event(opts.sofiEarnings === undefined ? "2026-11-20" : opts.sofiEarnings), WTCH: event("2026-11-20"), FARR: event("2026-11-20"), SPY: event(null) } };
}
const ctx = (over: Partial<BriefContext> = {}): BriefContext => ({ research: research(), equity: 1500, buyingPower: 1500, accountAt: AT, ceiling: 150, feeReserveUsd: 2, promoted: false, armed: true, verified: true, vetoOn: true, owned: [], equityHigh: 1500, vix: 17.5, now: NOW, ...over });

test("the brief's six headers appear in order; the account, market and best-trade lines carry the stamped numbers", () => {
  const b = buildOptionsBrief(ctx());
  const text = renderOptionsBrief(b);
  const positions = OPTIONS_BRIEF_RULES.sectionOrder.map((h) => text.indexOf(`\n${h}\n`));
  assert.ok(positions.every((p) => p >= 0), `every header present: ${positions}`);
  assert.deepEqual([...positions].sort((a, c) => a - c), positions, "in order");
  assert.match(text, /^OPTIONS DESK BRIEF — 2026-09-15 15:00Z/);
  assert.match(text, /equity \$1500 \(snapshot 2026-09-15 15:00Z\) · buying power \$1500 · at risk \$0 · screen cap \$150 · normal ×1 · ARMED/);
  assert.match(text, /SPY 662 above its 20-day 655\.57 \(50-day 655\.23\), \+0\.39% on 2026-09-14 · QQQ unknown/); assert.match(text, /vol normal \(VIX 17\.5\)/); assert.match(text, /catalysts today: none among researched names · veto on/);
  assert.equal(b.cards.length, 1); assert.equal(b.cards[0].symbol, "SOFI"); assert.ok(b.cards[0].confidence.score! > 0);
  assert.match(text, /TOP 5\n1\. \[\d+\] SOFI bullish · long call 12 exp 2026-10-16/);
  assert.equal(b.best?.symbol, "SOFI"); assert.equal(b.action.action, "ENTER NOW");
  assert.deepEqual(b.gates.map((g) => [g.name, g.pass]), [["armed", true], ["drawdown tier", true], ["slot", true], ["earnings", true], ["market veto", true], ["chase", true], ["cluster", true], ["ladder cap", true], ["reserve", true], ["expiry window", true]]);
  assert.match(text, /ACTION\nENTER NOW — the best structure passes every stamped gate — not checked here: entries today vs the daily limit, the last-30-minutes rule, the intraday SPY shock, the broker's live earnings date, the exact slot count/);
  assert.match(text, /BEST TRADE\npasses every stamped gate[^\n]*\nSOFI bullish · long call 12 exp 2026-10-16 \(31\.2 DTE, 30-45\)\nprice: /);
  assert.match(text, /✓ ladder cap: Normal cap \$150\.00 vs \$86\.00 planned loss \(spread 6\.06% > 5%\)/);   // a 6% spread is not Strong; the Normal rung still fits the $86 single
  // The chase gate IS chaseCheck (the tick's function) on the signal-day bar: SOFI closed 12.10 on an 11.90 prior close.
  assert.match(text, /✓ market veto: SPY above its 20-day \(662 vs 655\.57\) and \+0\.39% on 2026-09-14\n✓ chase: SOFI \+1\.68% today = 0\.67× its implied daily move \(signal-day bar; re-checked live at the tick\)/);
  assert.equal(volRegimeOf(null), "unknown (VIX unavailable)"); assert.equal(volRegimeOf(14.9), "low (VIX 14.9)"); assert.equal(volRegimeOf(31), "high (VIX 31)");
});

test("action truth table: ENTER NOW only when every gate passes; chase or a watch name at its edge → WAIT FOR TRIGGER; otherwise NO TRADE — through the tick's own gate functions", () => {
  assert.equal(deriveOptionsAction({ best: true, gatesPass: true, watchNear: ["WTCH"], chaseWait: [], failed: [] }).action, "ENTER NOW");
  assert.equal(deriveOptionsAction({ best: true, gatesPass: false, watchNear: [], chaseWait: ["SOFI"], failed: ["chase"] }).action, "WAIT FOR TRIGGER");
  assert.equal(deriveOptionsAction({ best: false, gatesPass: false, watchNear: ["WTCH"], chaseWait: [], failed: [] }).action, "WAIT FOR TRIGGER");
  assert.equal(deriveOptionsAction({ best: true, gatesPass: false, watchNear: [], chaseWait: [], failed: ["earnings: x"] }).action, "NO TRADE");
  assert.equal(deriveOptionsAction({ best: false, gatesPass: false, watchNear: [], chaseWait: [], failed: [] }).action, "NO TRADE");
  // Through the real gates on stamped data:
  const disarmed = buildOptionsBrief(ctx({ armed: false }));
  assert.equal(disarmed.action.action, "WAIT FOR TRIGGER", "WTCH is 1.27% from its edge, so a refused best still says wait");
  assert.equal(disarmed.gates.find((g) => g.name === "armed")!.pass, false);
  const farOnly = research(); delete farOnly.bars.WTCH;   // no watch name at the trigger → a refused best is NO TRADE
  const noTrade = buildOptionsBrief(ctx({ research: farOnly, armed: false }));
  assert.equal(noTrade.action.action, "NO TRADE"); assert.match(noTrade.action.reason, /armed: desk disarmed/);
  const earnings = buildOptionsBrief(ctx({ research: research({ sofiEarnings: "2026-10-01" }) }));
  assert.equal(earnings.best, null, "earnings inside the expiry drops the structure before the gates"); assert.equal(earnings.action.action, "WAIT FOR TRIGGER");
  const veto = buildOptionsBrief(ctx({ research: research({ spyBelowAndDown: true }) }));
  assert.equal(veto.gates.find((g) => g.name === "market veto")!.pass, false); assert.match(veto.gates.find((g) => g.name === "market veto")!.note, /bullish single-name entries refused/);
  assert.equal(buildOptionsBrief(ctx({ research: research({ spyBelowAndDown: true }), vetoOn: false })).gates.find((g) => g.name === "market veto")!.pass, true);
  const cluster = buildOptionsBrief(ctx({ owned: [{ symbol: "SOFI", kind: "long_call", atRiskUsd: 87 }] }));
  assert.equal(cluster.gates.find((g) => g.name === "cluster")!.pass, false); assert.equal(cluster.account.atRiskUsd, 87);
  // Slots (Sep 20 2026): one held position of the ladder's three leaves a slot; a full book fails the gate and defers to the tick's slotsFor.
  assert.equal(cluster.gates.find((g) => g.name === "slot")!.pass, true); assert.match(cluster.gates.find((g) => g.name === "slot")!.note, /^1 of 3 slots used$/);
  const full = buildOptionsBrief(ctx({ owned: [{ symbol: "SOFI", kind: "long_call", atRiskUsd: 87 }], slots: 1 }));
  assert.equal(full.gates.find((g) => g.name === "slot")!.pass, false); assert.match(full.gates.find((g) => g.name === "slot")!.note, /1 of 1 slots used — WAIT, the tick's slot count/);
  // A chasing breakout (a +10% day on a 40% IV name = 4×) fails the chase gate through chaseCheck and turns the action into WAIT FOR TRIGGER.
  const chased = research(); chased.bars.SOFI[199].close = 11;
  const chase = buildOptionsBrief(ctx({ research: chased }));
  assert.equal(chase.gates.find((g) => g.name === "chase")!.pass, false); assert.match(chase.gates.find((g) => g.name === "chase")!.note, /^WAIT FOR TRIGGER: SOFI moved \+10% today = 3\.97× its implied daily move — not chasing/);
  assert.equal(chase.action.action, "WAIT FOR TRIGGER"); assert.deepEqual(chase.chaseWait, ["SOFI"]);
  // Reserve at 35% of $1,500 = $525: $450 already at risk leaves no room for an $86 single.
  assert.equal(buildOptionsBrief(ctx({ owned: [{ symbol: "NVDA", kind: "long_call", atRiskUsd: 300 }] })).gates.find((g) => g.name === "reserve")!.pass, true, "$386 of $525 still fits");
  const reserve = buildOptionsBrief(ctx({ owned: [{ symbol: "NVDA", kind: "long_call", atRiskUsd: 450 }] }));
  assert.equal(reserve.gates.find((g) => g.name === "reserve")!.pass, false); assert.match(reserve.gates.find((g) => g.name === "reserve")!.note, /\$450 already at risk \+ \$86 would exceed 35% of \$1,500/);
  const halted = buildOptionsBrief(ctx({ equity: 1000, equityHigh: 1500 }));   // $500 under the high, past the $450 floor → tier 4, cap ×0 → nothing screens
  assert.equal(halted.account.cap, 0); assert.equal(halted.best, null); assert.match(halted.bestNote, /no cap/);
  const tier2 = buildOptionsBrief(ctx({ equity: 1350, equityHigh: 1500 }));   // 10% under → ×0.5: Strong cap $75, the $86 single no longer fits
  assert.equal(tier2.account.cap, 75); assert.equal(tier2.best, null);
  const nothing = buildOptionsBrief(ctx({ research: null }));
  assert.equal(nothing.action.action, "NO TRADE"); assert.equal(renderOptionsBrief(nothing).includes("no broker research on file"), true);
});

test("credit spreads never reach the brief: two puts below the close build a put credit for research, and it is absent from the cards, the best trade and the watch structures", () => {
  const data = research();
  const base = { multiplier: 100, bidSize: 20, askSize: 20, at: AT, volume: 3000, openInterest: 8000, selloutAt: null, expiry: "2026-10-16", iv: 0.4, theta: -0.02 };
  for (const [symbol, id] of [["SOFI", "s"], ["WTCH", "w"]] as const) data.contracts.push(
    { ...base, id: `${id}p11`, symbol, type: "put", strike: 11, bid: 0.20, ask: 0.22, delta: -0.2 },
    { ...base, id: `${id}p10`, symbol, type: "put", strike: 10, bid: 0.08, ask: 0.09, delta: -0.1 });
  const b = buildOptionsBrief(ctx({ research: data }));
  assert.ok(b.cards.every((c) => !c.structure.endsWith("_credit")) && b.cards.length >= 1);
  assert.ok(b.best && !b.best.structure.endsWith("_credit"));
  assert.ok(b.watch.every((w) => !w.structure || !w.structure.kind.endsWith("_credit")));
  assert.ok(!renderOptionsBrief(b).includes("credit"));
});

test("Slack: one line only when the action or best symbol changed, at most two posts per ET day, and the last-key is decided before the send", () => {
  const t0 = Date.parse("2026-09-15T14:00:00Z");
  const first = slackDecision(undefined, "NO TRADE", null, t0);
  assert.equal(first.send, true); assert.deepEqual(first.next, { action: "NO TRADE", bestSymbol: null, at: new Date(t0).toISOString(), day: "2026-09-15", posts: 1 });
  assert.equal(slackDecision(JSON.stringify(first.next), "NO TRADE", null, t0 + 3_600_000).send, false, "unchanged → silent");
  const second = slackDecision(JSON.stringify(first.next), "ENTER NOW", "SOFI", t0 + 3_600_000);
  assert.equal(second.send, true); assert.equal(second.next.posts, 2);
  const third = slackDecision(JSON.stringify(second.next), "WAIT FOR TRIGGER", "WTCH", t0 + 7_200_000);
  assert.equal(third.send, false, `a third change the same day stays off Slack (cap ${OPTIONS_BRIEF_MAX_POSTS_PER_DAY})`); assert.deepEqual(third.next, second.next);
  const nextDay = slackDecision(JSON.stringify(second.next), "WAIT FOR TRIGGER", "WTCH", t0 + 86_400_000);
  assert.equal(nextDay.send, true); assert.equal(nextDay.next.posts, 1); assert.equal(nextDay.next.day, "2026-09-16");
  assert.equal(slackDecision("not json", "NO TRADE", null, t0).send, true, "an unreadable last-key is a first brief");
});

test("a conditional line pins the numbers: structure, the close level, the SPY/QQQ and earnings clauses, and the Normal cap as the max loss incl. fee", () => {
  const b = buildOptionsBrief(ctx());
  assert.deepEqual(b.watch.map((w) => [w.symbol, w.distancePct, w.withinTrigger]), [["WTCH", 1.27, true], ["FARR", 9.09, false]]);
  const w = b.watch[0];
  assert.equal(w.line, "enter long call 12 2026-10-16 only if WTCH closes above 12 with SPY/QQQ constructive and no earnings before 2026-10-16; max loss incl. fee $150.00");
  assert.deepEqual(w.structure, { kind: "long_call", strikes: [12], expiry: "2026-10-16", debit: 0.85 }); assert.equal(w.maxDebitUsd, 150); assert.match(w.earningsNote, /next earnings 2026-11-20 is after expiry/);
  assert.match(renderOptionsBrief(b), /CONDITIONAL ORDERS\nWTCH bullish at 11\.85 \(1\.27% from 12, AT THE TRIGGER\): enter long call 12 2026-10-16 only if WTCH closes above 12/);
  assert.equal(edgeDistancePct({ direction: "bearish", close: 10.5, rangeLow: 10.2, rangeHigh: 12 }), 2.86);
  // The Normal cap scales with equity and the drawdown tier: $3,000 equity → 10% = $300, held down by whatever ceiling is armed.
  assert.equal(buildOptionsBrief(ctx({ equity: 3000, equityHigh: 3000 })).watch[0].maxDebitUsd, 150, "the armed $150 ceiling still wins");
  assert.equal(buildOptionsBrief(ctx({ equity: 3000, equityHigh: 3000, ceiling: 225 })).watch[0].maxDebitUsd, 225);
  assert.equal(buildOptionsBrief(ctx({ equity: 3000, equityHigh: 3000, ceiling: 400 })).watch[0].maxDebitUsd, 300, "above the ceiling the equity percentage governs");
});
