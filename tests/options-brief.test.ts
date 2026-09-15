import assert from "node:assert/strict";
import test from "node:test";
import { OPTIONS_BRIEF_RULES, buildOptionsBrief, deriveOptionsAction, edgeDistancePct, renderOptionsBrief, volRegimeOf, type BriefContext } from "../src/lib/options-brief";
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
  assert.deepEqual(b.gates.map((g) => [g.name, g.pass]), [["armed", true], ["drawdown tier", true], ["earnings", true], ["market veto", true], ["chase", true], ["cluster", true], ["ladder cap", true], ["reserve", true], ["expiry window", true]]);
  assert.match(text, /ACTION\nENTER NOW — the best structure passes every gate on stamped data/);
  assert.match(text, /BEST TRADE\npasses every stamped gate[^\n]*\nSOFI bullish · long call 12 exp 2026-10-16 \(31\.2 DTE, 30-45\)\nprice: /);
  assert.match(text, /✓ ladder cap: Normal cap \$100\.50 vs \$86\.00 planned loss \(spread 6\.06% > 5%\)/);   // a 6% spread is not Strong; the Normal rung still fits the $86 single
  assert.match(text, /✓ market veto: SPY above its 20-day \(662 vs 655\.57\) and \+0\.39% on 2026-09-14\n✓ chase: 0\.67× the implied daily move/);
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
  const reserve = buildOptionsBrief(ctx({ owned: [{ symbol: "NVDA", kind: "long_call", atRiskUsd: 300 }] }));
  assert.equal(reserve.gates.find((g) => g.name === "reserve")!.pass, false); assert.match(reserve.gates.find((g) => g.name === "reserve")!.note, /\$300 already at risk \+ \$86 would exceed 25% of \$1,500/);
  const halted = buildOptionsBrief(ctx({ equity: 1100, equityHigh: 1500 }));   // 26.7% under the high → tier 4, cap ×0 → nothing screens
  assert.equal(halted.account.cap, 0); assert.equal(halted.best, null); assert.match(halted.bestNote, /no cap/);
  const tier2 = buildOptionsBrief(ctx({ equity: 1350, equityHigh: 1500 }));   // 10% under → ×0.5: Strong cap $75, the $86 single no longer fits
  assert.equal(tier2.account.cap, 75); assert.equal(tier2.best, null);
  const nothing = buildOptionsBrief(ctx({ research: null }));
  assert.equal(nothing.action.action, "NO TRADE"); assert.equal(renderOptionsBrief(nothing).includes("no broker research on file"), true);
});

test("a conditional line pins the numbers: structure, the close level, the SPY/QQQ and earnings clauses, and the Normal cap as the max debit", () => {
  const b = buildOptionsBrief(ctx());
  assert.deepEqual(b.watch.map((w) => [w.symbol, w.distancePct, w.withinTrigger]), [["WTCH", 1.27, true], ["FARR", 9.09, false]]);
  const w = b.watch[0];
  assert.equal(w.line, "enter long call 12 2026-10-16 only if WTCH closes above 12 with SPY/QQQ constructive and no earnings before 2026-10-16; max debit $100.50");
  assert.deepEqual(w.structure, { kind: "long_call", strikes: [12], expiry: "2026-10-16", debit: 0.85 }); assert.equal(w.maxDebitUsd, 100.5); assert.match(w.earningsNote, /next earnings 2026-11-20 is after expiry/);
  assert.match(renderOptionsBrief(b), /CONDITIONAL ORDERS\nWTCH bullish at 11\.85 \(1\.27% from 12, AT THE TRIGGER\): enter long call 12 2026-10-16 only if WTCH closes above 12/);
  assert.equal(edgeDistancePct({ direction: "bearish", close: 10.5, rangeLow: 10.2, rangeHigh: 12 }), 2.86);
  // The Normal cap scales with equity and the drawdown tier: $3,000 equity → 6.7% = $201, capped by the $150 ceiling.
  assert.equal(buildOptionsBrief(ctx({ equity: 3000, equityHigh: 3000 })).watch[0].maxDebitUsd, 150);
  assert.equal(buildOptionsBrief(ctx({ equity: 3000, equityHigh: 3000, ceiling: 225 })).watch[0].maxDebitUsd, 201);
});
