import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CARD_FEE_PCT_SIDE, EXPECTED_SLIP_PCT, buildTradeCard, renderTradeCard, tradeCardOneLiner, type TradeCard, type TradeCardInput } from "../src/lib/margin-trade-card";
import { MODEL_TAKER_FEE_PCT } from "../src/lib/margin-synthesis";
import { rollover4h } from "../src/lib/margin-shadow";
import { LIQ_BUFFER_MULT, leverageThatFitsStop, liveNotional, projectedMarginLevel } from "../src/lib/margin-live-risk";

// THE WORKED EXAMPLE the plan was written against: $10,000 equity, an A+ (8%) entry on a 4%
// stop → $20,000 notional at the 9× rung that fits the stop, $2,222 margin, margin level 450%
// after, isolated liquidation 6.67% away = 1.67× the stop, account-level 45.6%, fees $100.
const EQUITY = 10_000;
const example = (over: Partial<TradeCardInput> = {}): TradeCardInput => {
  const leverage = leverageThatFitsStop(4, 20);
  return {
    at: "2026-09-15T04:02:00.000Z", symbol: "ETH/USD", side: "buy", source: "swing-pyr", horizonH: 168, regime: "up",
    entryPx: 4000, stopFrac: 0.04, trailR: 2, addAtR: 1,
    pairMaxLeverage: 20, operatorMaxLeverage: 20, leverage,
    notional: liveNotional(EQUITY, 0.08, 0.04, leverage), equity: EQUITY, marginUsedNow: 0, grossNotionalNow: 0,
    conviction: "high", score: null, ddTier: 0, ddMult: 1, eventMode: "normal", decayMult: 1, action: "ENTER", ...over,
  };
};
const near = (a: number | null, b: number, tol = 0.01, why = "") => assert.ok(a != null && Math.abs(a - b) <= tol, `${why} expected ≈${b}, got ${a}`);

test("worked example: $10k · 8% · 4% stop → $20k at 9×, $2,222 margin, ML 450%, liq 6.67% = 1.67× stop, account 45.6%, fees $100", () => {
  const c = buildTradeCard(example());
  assert.equal(c.leverageUsed, 9);
  assert.equal(c.leveragePermitted, 9, "pair 20 ∧ operator 20 ∧ fits-stop(4%) = 9");
  near(c.notional, 20_000, 1e-6);
  near(c.marginUsd, 2222.22, 0.01);
  near(c.riskUsd, 800, 1e-6);
  near(c.riskPct, 8, 1e-9);
  near(c.marginLevelAfter, 450, 0.01);
  assert.equal(c.marginLevelAfter, projectedMarginLevel(EQUITY, 0, 20_000, 9), "the same helper the margin-level floor uses");
  near(c.liqDistIsolatedPct, 6.6667, 0.001);
  near(c.liqMultipleVsStop, LIQ_BUFFER_MULT, 1e-9, "1.67× the stop, exactly the buffer the leverage fit enforces");
  near(c.liqPriceIsolated, 4000 * (1 - 0.6 / 9), 0.01);
  near(c.liqDistAccountPct, 45.56, 0.01, "(10,000 − 0.4 × 2,222) ÷ 20,000");
  near(c.expectedFeesUsd, 100, 1e-9, "2 × 0.25% × $20,000");
  // The paper model's own rate, whatever it is for the symbol as the scan spells it (pinned to
  // rollover4h so the card and the paper record can never disagree about carry).
  near(c.expectedFinancingUsd, rollover4h("ETH/USD") * 42 * 20_000, 1e-9, "per-coin 4h rollover × ceil(168/4) periods × notional");
  near(c.expectedFinancingUsd, 252, 1e-9, "0.03%/4h × 42 periods × $20,000");
  near(c.expectedSlippageUsd, 140, 1e-9, "0.7% of notional");
  assert.equal(c.stopPct, 4);
  near(c.stopPx, 3840, 1e-9);
  assert.equal(c.trailRule, "breakeven at +1R, trail 2R, add at +1R");
  assert.equal(c.rr, null);
  assert.equal(c.rrNote, "no fixed TP; 2R trail");
  assert.equal(c.grade, "A+");
  assert.equal(c.action, "ENTER");
  assert.equal(c.reason, undefined);
});

test("a short mirrors the long: stop and liquidation above the entry; account distance identical", () => {
  const c = buildTradeCard(example({ side: "sell" }));
  near(c.stopPx, 4160, 1e-9);
  near(c.liqPriceIsolated, 4000 * (1 + 0.6 / 9), 0.01);
  near(c.liqDistAccountPct, 45.56, 0.01);
});

test("the account-level distance shrinks with existing exposure; the isolated one does not", () => {
  // Another $20k already posted at 9× ($2,222 margin): M_after 4,444, G_after 40,000.
  const c = buildTradeCard(example({ marginUsedNow: 2222.22, grossNotionalNow: 20_000 }));
  near(c.liqDistAccountPct, (EQUITY - 0.4 * 4444.44) / 40_000 * 100, 0.01);
  near(c.liqDistIsolatedPct, 6.6667, 0.001);
  near(c.marginLevelAfter, 225, 0.01);
});

test("financing rounds the horizon UP to whole 4h periods and follows the paper model's per-coin rollover", () => {
  const c = buildTradeCard(example({ symbol: "BTC/USD", horizonH: 97 }));
  near(c.expectedFinancingUsd, rollover4h("BTC/USD") * 25 * 20_000, 1e-9, "97h → 25 periods");
  near(buildTradeCard(example({ horizonH: 96 })).expectedFinancingUsd, rollover4h("ETH/USD") * 24 * 20_000, 1e-9, "96h → 24 periods");
  // Kraken's own pair spelling reaches the per-coin table (BTC 0.015%/4h, measured on the real ledger).
  near(buildTradeCard(example({ symbol: "XBTUSD", horizonH: 4 })).expectedFinancingUsd, 0.00015 * 20_000, 1e-9);
  assert.ok(buildTradeCard(example({ symbol: "XBTUSD", horizonH: 4 })).expectedFinancingUsd < buildTradeCard(example({ symbol: "SOLUSD", horizonH: 4 })).expectedFinancingUsd, "BTC borrows cheaper than an alt in the paper model");
});

test("leveragePermitted is the pair cap ∧ the operator cap ∧ fits-stop, and never what was used", () => {
  assert.equal(buildTradeCard(example({ pairMaxLeverage: 3 })).leveragePermitted, 3, "a 3× venue pair");
  assert.equal(buildTradeCard(example({ operatorMaxLeverage: 5 })).leveragePermitted, 5, "operator ceiling 5");
  assert.equal(buildTradeCard(example({ stopFrac: 0.08 })).leveragePermitted, 4, "an 8% stop fits 4×");
  assert.equal(buildTradeCard(example({ leverage: 20 })).leveragePermitted, 9, "the card reports what was permitted, not what was used");
  assert.equal(buildTradeCard(example({ leverage: 20 })).leverageUsed, 20);
});

test("a refusal card carries the reason, the action REFUSED, and — before sizing — no notional-derived fields", () => {
  const refusedAfterSizing = buildTradeCard(example({ action: "REFUSED", reason: "entry refused: would leave margin level at 111% (floor 150%)" }));
  assert.equal(refusedAfterSizing.action, "REFUSED");
  assert.equal(refusedAfterSizing.reason, "entry refused: would leave margin level at 111% (floor 150%)");
  near(refusedAfterSizing.notional, 20_000, 1e-6, "sized refusals keep the size they were refused at");
  const refusedBeforeSizing = buildTradeCard(example({ notional: 0, action: "REFUSED", reason: "entry refused: risk chain sized to 0 (dd ×0.25, event ×0, decay ×1) — failing closed" }));
  assert.equal(refusedBeforeSizing.notional, 0);
  assert.equal(refusedBeforeSizing.marginLevelAfter, null);
  assert.equal(refusedBeforeSizing.liqDistAccountPct, null);
  assert.equal(refusedBeforeSizing.expectedFeesUsd, 0);
  assert.equal(refusedBeforeSizing.riskUsd, 0);
  // The stop, leverage and multipliers it would have carried are still on the card.
  assert.equal(refusedBeforeSizing.stopPct, 4);
  assert.equal(refusedBeforeSizing.leverageUsed, 9);
  assert.match(refusedBeforeSizing.reason ?? "", /risk chain sized to 0/);
});

test("the grade is the setup ladder's label and never A+ for an unscored entry; score is null until stamped", () => {
  assert.equal(buildTradeCard(example({ conviction: "med" })).grade, "Strong");
  assert.equal(buildTradeCard(example({ conviction: "low" })).grade, "Normal");
  assert.equal(buildTradeCard(example({ conviction: null })).grade, "Normal");
  assert.equal(buildTradeCard(example({ score: null })).score, null);
  assert.equal(buildTradeCard(example({ score: 3 })).score, 3);
  assert.equal(buildTradeCard(example({ score: NaN })).score, null);
});

test("FEE CONSTANT PIN: the card's per-side fee is the paper model's taker fee (0.25%), and the slippage is the replay's SLIP default (0.7%)", () => {
  assert.equal(CARD_FEE_PCT_SIDE, MODEL_TAKER_FEE_PCT);
  assert.equal(CARD_FEE_PCT_SIDE, 0.25);
  // margin-shadow's TAKER is module-private; pin it on the source so the two cannot drift.
  const shadow = readFileSync(new URL("../src/lib/margin-shadow.ts", import.meta.url), "utf8");
  assert.match(shadow, /const TAKER = 0\.0025;/);
  const replay = readFileSync(new URL("../scripts/backtest-portfolio.ts", import.meta.url), "utf8");
  assert.match(replay, /process\.env\.SLIP \?\? 0\.007/, "the replay's SLIP default is the card's expected slippage");
  assert.equal(EXPECTED_SLIP_PCT, 0.7);
});

test("renderTradeCard names every field of the card, in a fixed-width block", () => {
  const c = buildTradeCard(example({ score: 3 }));
  const text = renderTradeCard(c);
  for (const key of Object.keys(c) as (keyof TradeCard)[]) assert.ok(text.includes(key), `render is missing "${key}"`);
  assert.ok(text.startsWith("🟢 LIVE ENTRY"));
  assert.ok(text.includes("```"), "a Slack code block");
  assert.ok(renderTradeCard({ ...c, action: "REFUSED", reason: "x" }).startsWith("⛔ REFUSED"));
  assert.ok(renderTradeCard({ ...c, action: "VALIDATE" }).startsWith("🧪 VALIDATE-ONLY"));
  const line = tradeCardOneLiner(c);
  assert.match(line, /ENTER ETH\/USD buy \(swing-pyr, A\+\) \$20000 at 9×/);
  assert.match(line, /liq 1\.67× stop \/ account 45\.6%/);
});

test("regime and score are internal-only on AlertOrder: the TradingView webhook never sets them; the scan route passes both", () => {
  const webhook = readFileSync(new URL("../src/app/api/webhook/tradingview/route.ts", import.meta.url), "utf8");
  const alertBuild = webhook.split("const alert: AlertOrder")[1] ?? "";
  assert.ok(alertBuild.length > 0, "the webhook builds an explicit AlertOrder");
  assert.ok(!/\bregime\b/.test(webhook), "the webhook route must never set regime");
  assert.ok(!/\bscore\b\s*[:=]/.test(webhook), "the webhook route must never set score");
  assert.ok(!/\.\.\.\s*b\b/.test(alertBuild), "the webhook must not spread the request body into AlertOrder");
  const scan = readFileSync(new URL("../src/app/api/cron/margin-scan/route.ts", import.meta.url), "utf8");
  assert.ok(/regime:\s*regime\.btcUp === true \? "up"/.test(scan), "the scan route passes the regime it read");
  assert.ok(/score:\s*conv\.score/.test(scan), "the scan route passes its score");
  assert.ok(/recordRefusal\(/.test(scan), "the scan route records card-less refusals");
  // And the executor persists a card on every post-sizing refusal and after AddOrder.
  const exec = readFileSync(new URL("../src/lib/margin-executor.ts", import.meta.url), "utf8");
  assert.ok(/const refuse = async \(reason: string\)/.test(exec));
  for (const gate of ["refusalNote.chainZero", "refusalNote.liqBuffer", "would leave margin level", "below Kraken minimum", "went stale during entry checks", "not enough route time left"]) {
    assert.ok(new RegExp(`refuse\\((?:[^)]*)?${gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(exec) || new RegExp(`return refuse\\([\\s\\S]{0,40}${gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(exec), `${gate} goes through refuse()`);
  }
  // The LAST AddOrder in the file is the entry's (the close path sends its own earlier).
  const afterOrder = exec.split('res = await krakenPrivate("AddOrder", params)').pop() ?? "";
  assert.ok(/persistTradeCard\(card, txid \?\? null\)/.test(afterOrder), "the card is persisted only after AddOrder");
  assert.ok(/announceTradeCard\(card, txid \?\? null\)\.catch/.test(afterOrder), "the announcement is after AddOrder and caught");
  // Nothing card-related sits between a decision and AddOrder: inside executeAlert, before the
  // order is sent, the only persist is the one inside refuse() (a refusal has no order to block).
  const entryPath = exec.split("// ---- ENTRY PATH ----")[1] ?? "";
  const beforeOrder = entryPath.split('res = await krakenPrivate("AddOrder", params)')[0];
  const withoutRefuse = beforeOrder.replace(/const refuse = async[\s\S]*?\n    };/, "");
  assert.ok(withoutRefuse.length < beforeOrder.length, "refuse() was found and excised");
  assert.ok(!/persistTradeCard|announceTradeCard/.test(withoutRefuse), "no card write before AddOrder outside refuse()");
});
