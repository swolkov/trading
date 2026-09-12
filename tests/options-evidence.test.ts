import assert from "node:assert/strict";
import test from "node:test";
import { buildOptionsObservation, optionsRiskView, optionsPerformanceCoverage, summarizeOptionsHistory, parseOptionsObservation } from "../src/lib/options-evidence-model";
import { parseRobinhoodResearchEvents, mergeResearchSnapshot, discoverySymbols } from "../src/lib/options-research-ingest";
import { observationKey } from "../src/lib/options-evidence-store";
import { contractQualityFailures, type OptionsResearch, type ResearchContract } from "../src/lib/options-desk-model";
import type { AccountSnapshot } from "../src/lib/options-quote-store";

const NOW = Date.parse("2026-09-14T15:00:00Z");
const account: AccountSnapshot = { accountNumber: "685528705", type: "limited_margin", optionLevel: "3",
  cash: 1500, buyingPower: 1500, optionsValue: 0, totalValue: 1500, at: new Date(NOW).toISOString() };
const quote: ResearchContract = { id: "contract-a", symbol: "TEST", type: "call", strike: 25, expiry: "2026-10-16",
  multiplier: 100, bid: 0.29, ask: 0.30, bidSize: 10, askSize: 10, at: new Date(NOW).toISOString(),
  delta: 0.5, iv: 0.3, theta: -0.01, volume: 1000, openInterest: 2000, selloutAt: null };
function research(): OptionsResearch {
  return { capturedAt: new Date(NOW).toISOString(), source: "Robinhood MCP", bars: {}, contracts: [{ ...quote }], scans: [], errors: [] };
}
test("deposit changes sizing illustration but never produces trading profit or a raised ceiling", () => {
  const before = optionsRiskView({ ...account, totalValue: 500 }, 100, NOW);
  const after = optionsRiskView(account, 100, NOW);
  assert.equal(before.netTradingProfit, null);
  assert.equal(after.netTradingProfit, null);
  assert.equal(after.netReturnPct, null);
  assert.equal(after.tradingDrawdownPct, null);
  assert.equal(after.automaticRiskIncrease, false);
  assert.equal(after.suggestedMin, 15);
  assert.equal(after.suggestedMax, 30);
  assert.equal(after.ceilingPct, 6.67);
});
test("invalid account cannot supply a budget; stale and future snapshots are marked", () => {
  assert.equal(optionsRiskView({ ...account, accountNumber: "other" }, 100, NOW).equity, null);
  assert.equal(optionsRiskView({ ...account, totalValue: NaN }, 100, NOW).equity, null);
  assert.equal(optionsRiskView({ ...account, at: new Date(NOW + 1).toISOString() }, 100, NOW).accountFresh, false);
  assert.equal(optionsRiskView(account, 100, NOW + 900001).accountFresh, false);
});
test("affordability counts full rounded premium and reserve, without implying a signal", () => {
  const data = research();
  const atCap = buildOptionsObservation(data, 31, account, NOW).symbols[0];
  const belowCap = buildOptionsObservation(data, 30, account, NOW).symbols[0];
  assert.equal(atCap.affordableLongs, 1);
  assert.equal(atCap.researchCandidates, 0);
  assert.equal(belowCap.affordableLongs, 0);
  assert.ok(belowCap.exclusions.some(e => e.reason === "Long premium exceeds budget"));
  data.contracts[0].ask = 0.30001;
  assert.equal(buildOptionsObservation(data, 31, account, NOW).symbols[0].affordableLongs, 0);
});
test("diagnostics share quality gates and retain stale quotes only as observations", () => {
  const data = research();
  data.contracts[0].at = new Date(NOW - 16000).toISOString();
  data.contracts[0].volume = 0;
  const observation = buildOptionsObservation(data, 100, account, NOW);
  assert.ok(contractQualityFailures(data.contracts[0], NOW).includes("Insufficient liquidity"));
  assert.equal(observation.symbols[0].qualityContracts, 0);
  assert.equal(observation.symbols[0].freshQuotes, 0);
  assert.equal(observation.quotes[0].at, data.contracts[0].at);
  data.contracts[0].bid = 99;
  assert.equal(observation.quotes[0].bid, 0.29, "archive is a copy, not a mutable reference");
});
test("partial A, full B, replay A cannot inherit B quotes into archive identity", () => {
  const partial = research(); partial.contracts = [];
  const full = research(); full.capturedAt = new Date(NOW + 1000).toISOString();
  const rawA = JSON.stringify(partial), rawB = JSON.stringify(full);
  const archive = new Map<string, ReturnType<typeof buildOptionsObservation>>();
  let display: OptionsResearch | null = null;
  for (const [raw, capture] of [[rawA, partial], [rawB, full], [rawA, partial]] as const) {
    display = mergeResearchSnapshot(display, capture);
    const key = observationKey(raw);
    if (!archive.has(key)) archive.set(key, buildOptionsObservation(capture, 100, account, NOW));
  }
  assert.equal(archive.size, 2);
  assert.equal(archive.get(observationKey(rawA))?.quotes.length, 0);
  assert.equal(archive.get(observationKey(rawB))?.quotes.length, 1);
  assert.equal(display?.contracts.length, 1, "display can retain a prior quote, archive cannot relabel it");
});
test("repeated scans cannot inflate distinct quotes or unique setup sessions", () => {
  const first = buildOptionsObservation(research(), 100, account, NOW);
  first.symbols[0].setup = "20-session breakout";
  first.symbols[0].session = "2026-09-11";
  const retry = structuredClone(first); retry.capturedAt = new Date(NOW + 60000).toISOString();
  const summary = summarizeOptionsHistory([retry, first]);
  assert.equal(summary.captures, 2);
  assert.equal(summary.distinctContractQuotes, 1);
  assert.equal(summary.callSetupSessions, 1);
  assert.equal(summary.putSetupSessions, 0);
});
test("order snapshots and missing fills never manufacture win rates or zero profit", () => {
  const coverage = optionsPerformanceCoverage({ orders: [], positions: [], at: account.at });
  assert.equal(coverage.observedOrders, 0);
  assert.equal(coverage.verifiedRoundTrips, null);
  assert.equal(coverage.winRate, null);
  assert.equal(coverage.expectancy, null);
  assert.equal(optionsPerformanceCoverage(null).observedOrders, null);
});
test("malformed archived records are excluded", () => {
  const o = buildOptionsObservation(research(), 100, account, NOW);
  assert.ok(parseOptionsObservation(JSON.stringify(o)));
  assert.equal(parseOptionsObservation(JSON.stringify({ ...o, symbols: [{ ...o.symbols[0], contracts: -1 }] })), null);
  assert.equal(parseOptionsObservation(JSON.stringify({ ...o, quotes: [{ ...quote, at: "invalid" }] })), null);
  assert.equal(parseOptionsObservation("null"), null);
});

test("zero ask never counts as an affordable long", () => {
  const data = research(); data.contracts[0].ask = 0;
  assert.equal(buildOptionsObservation(data, 100, account, NOW).symbols[0].affordableLongs, 0);
});
test("small scanner pages accumulate and deduplicate without hiding a failed page", () => {
  const prefix = "mcp__robinhood-trading__";
  const blocks = [
    { type: "tool_use", id: "list", name: prefix + "get_scans", input: {} },
    { type: "tool_result", tool_use_id: "list", content: JSON.stringify({ data: { scans: [{ id: "scan", name: "Esbueno Bullish Trend" }] } }) },
    ...[1, 2].flatMap(page => [
      { type: "tool_use", id: "p" + page, name: prefix + "run_scan", input: { scan_id: "scan" } },
      { type: "tool_result", tool_use_id: "p" + page, content: JSON.stringify({ data: { result: { total_items: 3, results: page === 1 ? [{ ticker: "AAA" }, { ticker: "BBB" }] : [{ ticker: "BBB" }, { ticker: "CCC" }] } } }) },
    ]),
    { type: "tool_use", id: "p3", name: prefix + "run_scan", input: { scan_id: "scan" } },
    { type: "tool_result", tool_use_id: "p3", is_error: true, content: "failed" },
  ];
  const result = parseRobinhoodResearchEvents(JSON.stringify({ message: { content: blocks } }), account.at);
  assert.deepEqual(result.scans[0].symbols, ["AAA", "BBB", "CCC"]);
  assert.equal(result.scans[0].resultCount, 3);
  assert.equal(result.errors.length, 1);
});
test("rotating discoveries cannot grow the current universe without bound", () => {
  const prior = research(), next = research();
  prior.contracts = Array.from({ length: 50 }, (_, i) => ({ ...quote, symbol: "OLD" + i }));
  next.contracts = Array.from({ length: 12 }, (_, i) => ({ ...quote, symbol: "NEW" + i }));
  const merged = mergeResearchSnapshot(prior, next);
  assert.equal(new Set(merged.contracts.map(c => c.symbol)).size, 6);
  assert.ok(merged.contracts.every(c => c.symbol.startsWith("NEW")));
  assert.equal(optionsRiskView({ ...account, totalValue: 20000 }, 100, NOW).suggestedMax, 100);
});

test("discovery seeds come only from validated actual scanner symbols", () => {
  const scan = { id: "scan", name: "Esbueno Bullish Trend", symbols: ["AAA", "AAA", "SPY", "$(bad)", "BRK.B"], filters: {}, resultCount: 5, at: account.at };
  assert.deepEqual(discoverySymbols([scan]), ["AAA", "BRK.B"]);
  assert.deepEqual(discoverySymbols([{ ...scan, name: "Unrelated scan" }]), []);
});

test("unselected chain instruments are not missing quote requests", () => {
  const prefix = "mcp__robinhood-trading__";
  const discovery = [
    { type: "tool_use", id: "instruments", name: prefix + "get_option_instruments", input: {} },
    { type: "tool_result", tool_use_id: "instruments", content: JSON.stringify({ data: { instruments: ["A", "B", "C"].map(id => ({ id, state: "active", tradability: "tradable" })) } }) },
  ];
  const parse = (content: unknown[]) => parseRobinhoodResearchEvents(JSON.stringify({ message: { content } }), account.at);
  assert.deepEqual(parse(discovery).errors, []);
  const requested = parse([...discovery,
    { type: "tool_use", id: "quote", name: prefix + "get_option_quotes", input: { instrument_ids: ["A", "A"] } },
    { type: "tool_result", tool_use_id: "quote", is_error: true, content: "broker request failed" },
  ]);
  assert.ok(requested.errors.includes("1 requested contracts lacked usable matched quotes"));
  assert.equal(requested.errors.length, 2);
});
