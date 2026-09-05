import assert from "node:assert/strict";
import test from "node:test";
import {
  STOCK_ENTRY_CHASE, STOCK_EXIT_SLIP, STOCK_MARGIN_APR, STOCK_MAX_LEVERAGE, STOCK_SOURCES, STOCK_UNIVERSE,
  isStockRthAt, stockCostFrac, stockEntryPrice, stockExitParams, stockNotional, stockPaperPlans,
  stockRiskFraction, stockVerdict, tStatOf,
} from "../src/lib/stock-paper-model";

const high = { tier: "high", factors: ["3 timeframes breaking", "volume confirms"] };
const highStretched = { tier: "high", factors: ["3 timeframes breaking", "stretched (−)"] };
const med = { tier: "med", factors: ["2 timeframes breaking"] };

test("universe: 30 uppercase tickers, no duplicates", () => {
  assert.equal(STOCK_UNIVERSE.length, 30);
  assert.equal(new Set(STOCK_UNIVERSE).size, STOCK_UNIVERSE.length);
  for (const s of STOCK_UNIVERSE) assert.match(s, /^[A-Z]{1,5}$/, s);
});

test("plans: longs only, high conviction only, not stretched, sleeve by timeframe", () => {
  assert.deepEqual(stockPaperPlans("breakout", "5m", high), ["stock-fast"]);
  assert.deepEqual(stockPaperPlans("breakout", "15m", high), ["stock-fast"]);
  assert.deepEqual(stockPaperPlans("breakout", "1h", high), ["stock-swing"]);
  assert.deepEqual(stockPaperPlans("breakout", "1d", high), ["stock-swing"]);
  assert.deepEqual(stockPaperPlans("breakdown", "5m", high), [], "no shorts — Robinhood's agent route cannot short");
  assert.deepEqual(stockPaperPlans("breakout", "5m", med), []);
  assert.deepEqual(stockPaperPlans("breakout", "5m", highStretched), []);
  assert.deepEqual(stockPaperPlans("breakout", "4h", high), []);
  for (const src of STOCK_SOURCES) assert.ok(stockExitParams(src).oneRPct > 0);
});

test("sizing: risk-based, conviction-scaled, capped at 2× equity (Reg T)", () => {
  // 3% of $5,000 = $150 max loss; 2% stop → $7,500 notional; 5% stop → $3,000.
  assert.equal(Math.round(stockNotional("stock-fast", 5000, 0.03)), 7500);
  assert.equal(Math.round(stockNotional("stock-swing", 5000, 0.03)), 3000);
  // High conviction doubles risk (6% = $300) → fast wants $15,000 but is capped at 2× equity.
  assert.equal(stockRiskFraction(3, "high"), 0.06);
  assert.equal(stockRiskFraction(3, "low"), 0.015);
  assert.equal(stockNotional("stock-fast", 5000, stockRiskFraction(3, "high")), 5000 * STOCK_MAX_LEVERAGE);
  assert.equal(stockNotional("stock-fast", 0, 0.03), 0);
  assert.equal(stockNotional("stock-fast", 5000, 0), 0);
});

test("costs: chase on entry, slippage on exit, 5% APR on the borrowed part only", () => {
  assert.equal(stockEntryPrice(100), 100 * (1 + STOCK_ENTRY_CHASE));
  // Nothing borrowed → exit slippage only, regardless of hold time.
  assert.equal(stockCostFrac(4000, 5000, 24 * 30), STOCK_EXIT_SLIP);
  // $10,000 notional on $5,000 equity held 1 year → $5,000 × 5% = $250 interest = 2.5% of notional.
  const yr = stockCostFrac(10_000, 5000, 365 * 24);
  assert.ok(Math.abs(yr - (STOCK_EXIT_SLIP + 0.025)) < 1e-9, String(yr));
  // Held 0h → no interest; negative hold clamps to 0.
  assert.equal(stockCostFrac(10_000, 5000, 0), STOCK_EXIT_SLIP);
  assert.equal(stockCostFrac(10_000, 5000, -5), STOCK_EXIT_SLIP);
  assert.equal(STOCK_MARGIN_APR, 0.05);
});

test("verdict ladder matches the crypto desk's rules", () => {
  assert.equal(stockVerdict(10, 500, 3, 10), "gathering (10/30)");
  assert.equal(stockVerdict(30, -1, 3, 10), "not paying");
  assert.equal(stockVerdict(30, 500, 1.5, 10), "promising (could be luck)");
  assert.equal(stockVerdict(30, 500, 2.1, 4), "promising — significant, needs 3 more days of data");
  assert.equal(stockVerdict(30, 500, 2.1, 7), "REAL EDGE — significant");
  assert.equal(tStatOf(10, 20, 16), 2);
  assert.equal(tStatOf(10, 0, 16), null);
  assert.equal(tStatOf(10, 20, 1), null);
});

test("RTH gate: 9:30–16:00 New York, weekdays, not holidays, DST-aware", () => {
  const holidays = ["2026-09-07"];
  assert.equal(isStockRthAt(new Date("2026-09-04T13:29:00Z"), holidays), false);  // 9:29 EDT
  assert.equal(isStockRthAt(new Date("2026-09-04T13:30:00Z"), holidays), true);   // 9:30 EDT
  assert.equal(isStockRthAt(new Date("2026-09-04T19:59:00Z"), holidays), true);   // 15:59 EDT
  assert.equal(isStockRthAt(new Date("2026-09-04T20:00:00Z"), holidays), false);  // 16:00 EDT
  assert.equal(isStockRthAt(new Date("2026-09-05T15:00:00Z"), holidays), false);  // Saturday
  assert.equal(isStockRthAt(new Date("2026-09-07T15:00:00Z"), holidays), false);  // Labor Day
  assert.equal(isStockRthAt(new Date("2026-12-15T14:30:00Z"), holidays), true);   // 9:30 EST (winter)
  assert.equal(isStockRthAt(new Date("2026-12-15T14:29:00Z"), holidays), false);
});
