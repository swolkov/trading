import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  FETCH_TIMEOUT_MS, FUNDING_PERIOD_HOURS, KF_FUNDING_HOURS, OI_DROP_PROXY, SNAPSHOT_MIN_INTERVAL_MS, SYMBOL_MAP,
  fetchBybitLinearTickers, fetchFearGreed, fetchKrakenFuturesTickers, normalizeDerivatives, oiChange24h,
  parseBybitLinearTickers, parseFearGreed, parseKrakenFuturesTickers,
} from "../src/lib/margin-derivatives";
import { derivStamps, gatherIntel, stampSql } from "../src/lib/margin-intel";
import { INTEL_STAMP_COLUMNS } from "../src/lib/margin-shadow";
import { SCAN_UNIVERSE } from "../src/lib/kraken-pairs";

// REAL SHAPES captured 2026-09-15 15:34Z from futures.kraken.com/derivatives/api/v3/tickers (trimmed
// to the coins under test; every field as returned). PI_XBTUSD is the legacy inverse contract —
// its fundingRate is in a different unit and must be ignored.
const KF_PAYLOAD = {
  result: "success",
  serverTime: "2026-09-15T15:34:47.577Z",
  tickers: [
    { symbol: "PI_XBTUSD", last: 75864.5, tag: "perpetual", pair: "XBT:USD", markPrice: 76352.41158132358, openInterest: 2226762.0, fundingRate: 5.66829867e-10, fundingRatePrediction: 5.06952846e-10, suspended: false },
    { symbol: "PF_XBTUSD", last: 76346, lastTime: "2026-09-15T15:34:47.339163Z", tag: "perpetual", pair: "XBT:USD", markPrice: 76339.81962376942, bid: 76346, ask: 76347, vol24h: 6726.4025, volumeQuote: 522900341.3257, openInterest: 1894.5955, open24h: 78508, fundingRate: 1.7558992668752336, fundingRatePrediction: 2.6537719268059745, suspended: false, indexPrice: 76324.73, postOnly: false, change24h: -2.75 },
    { symbol: "PF_ETHUSD", last: 2427.9, tag: "perpetual", pair: "ETH:USD", markPrice: 2427.79347901115, openInterest: 30058.94, fundingRate: -0.024164862565790864, fundingRatePrediction: 0.04383146806666586, suspended: false },
    { symbol: "PF_SOLUSD", last: 99.37, tag: "perpetual", pair: "SOL:USD", markPrice: 99.36208411753, openInterest: 245284.59, fundingRate: -0.002601767695625, fundingRatePrediction: -0.001250823595416634, suspended: false },
    { symbol: "PF_PENGUUSD", last: 0.006995, tag: "perpetual", pair: "PENGU:USD", markPrice: 0.00699731331, openInterest: 53646600.0, fundingRate: 1.68889972253e-07, fundingRatePrediction: 4.00353894785e-07, suspended: false },
    { symbol: "PF_BNBUSD", markPrice: 600, openInterest: 100, fundingRate: 0.001 },   // not a US-margin coin → ignored
    { symbol: "PF_BROKENUSD", markPrice: "n/a", openInterest: 1, fundingRate: 0 },     // unparseable → skipped
  ],
};
// Bybit v5 documented shape (geo-blocked from US IPs, so this is the docs' example form, not a capture).
const BYBIT_PAYLOAD = {
  retCode: 0, retMsg: "OK",
  result: { category: "linear", list: [
    { symbol: "BTCUSDT", lastPrice: "76350.10", markPrice: "76349.50", indexPrice: "76340.00", openInterest: "52000.123", openInterestValue: "3970000000.00", fundingRate: "0.0001", nextFundingTime: "1789459200000", turnover24h: "1", volume24h: "1" },
    { symbol: "ZECUSDT", lastPrice: "1126.30", markPrice: "1126.25", openInterest: "12000.5", openInterestValue: "13515000.00", fundingRate: "-0.00025", nextFundingTime: "1789459200000" },
    { symbol: "BNBUSDT", markPrice: "600", openInterest: "1", fundingRate: "0.0001" },
  ] },
};
const FNG_PAYLOAD = { name: "Fear and Greed Index", data: [{ value: "69", value_classification: "Greed", timestamp: "1789430400", time_until_update: "30292" }], metadata: { error: null } };

test("SYMBOL_MAP covers every one of the 26 US-margin coins, BTC as PF_XBTUSD, and nothing else", () => {
  assert.equal(SCAN_UNIVERSE.length, 26);
  for (const c of SCAN_UNIVERSE) {
    assert.ok(SYMBOL_MAP[c], `${c} mapped`);
    assert.equal(SYMBOL_MAP[c].kf, `PF_${c === "BTC" ? "XBT" : c}USD`);
    assert.equal(SYMBOL_MAP[c].bybit, `${c}USDT`);
  }
  assert.equal(Object.keys(SYMBOL_MAP).length, 26);
  assert.ok(!("BNB" in SYMBOL_MAP), "BNB is not US-margin-tradeable and is not mapped");
});

test("Kraken Futures parser: PF_ only, raw funding is USD/unit/hour, funding8hRel = funding ÷ mark × 8, OI in base units", () => {
  const t = parseKrakenFuturesTickers(KF_PAYLOAD);
  assert.deepEqual(t.map((x) => x.coin).sort(), ["BTC", "ETH", "PENGU", "SOL"]);
  const btc = t.find((x) => x.coin === "BTC")!;
  assert.equal(btc.source, "kraken-futures");
  assert.equal(btc.funding, 1.7558992668752336, "raw is stored untouched");
  assert.equal(btc.fundingPred, 2.6537719268059745);
  assert.equal(btc.oi, 1894.5955);
  assert.ok(Math.abs(btc.oiUsd! - 1894.5955 * 76339.81962376942) < 1e-6);
  // Kraken's own historicalfundingrates row for this hour: relativeFundingRate 2.3137929e-05
  // (computed on the mark at the top of the hour, so within ~1%, not to the digit).
  const hourlyRel = btc.funding / btc.mark;
  assert.ok(Math.abs(hourlyRel / 2.3137929166667e-05 - 1) < 0.02, `hourly relative ${hourlyRel}`);
  assert.ok(Math.abs(btc.funding8hRel! - hourlyRel * 8) < 1e-12);
  assert.equal(KF_FUNDING_HOURS, 1);
  assert.equal(FUNDING_PERIOD_HOURS, 8);
  const eth = t.find((x) => x.coin === "ETH")!;
  assert.ok(eth.funding8hRel! < 0, "negative raw funding stays negative");
  assert.ok(Math.abs(eth.funding8hRel!) < 0.001, "an 8h relative rate is a small fraction, never a dollar figure");
  assert.ok((btc.raw as { symbol: string }).symbol === "PF_XBTUSD");
  // Garbage in → empty out, never a throw.
  assert.deepEqual(parseKrakenFuturesTickers(null), []);
  assert.deepEqual(parseKrakenFuturesTickers({ tickers: "nope" }), []);
  assert.deepEqual(parseKrakenFuturesTickers("<html>"), []);
});

test("Bybit parser: the documented v5 linear shape; fundingRate is already a per-period fraction; OI value from the payload", () => {
  const t = parseBybitLinearTickers(BYBIT_PAYLOAD);
  assert.deepEqual(t.map((x) => x.coin).sort(), ["BTC", "ZEC"]);
  const zec = t.find((x) => x.coin === "ZEC")!;
  assert.equal(zec.source, "bybit");
  assert.equal(zec.funding, -0.00025);
  assert.equal(zec.funding8hRel, -0.00025);
  assert.equal(zec.fundingPred, null);
  assert.equal(zec.oi, 12000.5);
  assert.equal(zec.oiUsd, 13515000);
  assert.equal(zec.mark, 1126.25);
  assert.deepEqual(parseBybitLinearTickers({ error: "The Amazon CloudFront distribution is configured to block access from your country" }), []);
  assert.deepEqual(parseBybitLinearTickers(undefined), []);
});

test("normalise: Kraken wins, Bybit fills only the gaps; oiChange24h is a fraction or null", () => {
  const kf = parseKrakenFuturesTickers(KF_PAYLOAD);
  const by = parseBybitLinearTickers(BYBIT_PAYLOAD);
  const n = normalizeDerivatives(kf, by);
  assert.equal(n.BTC.source, "kraken-futures");
  assert.equal(n.ZEC.source, "bybit");
  assert.equal(Object.keys(n).length, 5);
  assert.ok(Math.abs(oiChange24h(1050, 1000)! - 0.05) < 1e-12);
  assert.ok(Math.abs(oiChange24h(950, 1000)! + 0.05) < 1e-12);
  assert.equal(oiChange24h(1000, null), null);
  assert.equal(oiChange24h(null, 1000), null);
  assert.equal(oiChange24h(1000, 0), null);
  assert.equal(oiChange24h(NaN, 1000), null);
  assert.equal(OI_DROP_PROXY, -0.05);
});

test("Fear & Greed parser on the real shape; garbage → null", () => {
  assert.deepEqual(parseFearGreed(FNG_PAYLOAD), { value: 69, label: "Greed", at: new Date(1789430400 * 1000).toISOString() });
  assert.equal(parseFearGreed({}), null);
  assert.equal(parseFearGreed({ data: [{ value: "x" }] }), null);
});

test("fetchers never throw out: a hanging, failing, geo-blocked or non-JSON endpoint yields [] / null", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw new Error("TimeoutError: The operation was aborted"); }) as typeof fetch;
    assert.deepEqual(await fetchKrakenFuturesTickers(), []);
    assert.deepEqual(await fetchBybitLinearTickers(), []);
    assert.equal(await fetchFearGreed(), null);
    globalThis.fetch = (async () => new Response("{\n    error:The Amazon CloudFront distribution is configured to block access from your country\n}", { status: 403 })) as typeof fetch;
    assert.deepEqual(await fetchBybitLinearTickers(), []);
    globalThis.fetch = (async () => new Response("<html>maintenance</html>", { status: 200 })) as typeof fetch;
    assert.deepEqual(await fetchKrakenFuturesTickers(), []);
    // And the timeout is wired: the request carries an abort signal with the module's budget.
    let sawSignal = false;
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => { sawSignal = init?.signal instanceof AbortSignal; return new Response(JSON.stringify(KF_PAYLOAD), { status: 200 }); }) as typeof fetch;
    const t = await fetchKrakenFuturesTickers();
    assert.ok(sawSignal, "fetch is called with an AbortSignal");
    assert.equal(t.length, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(FETCH_TIMEOUT_MS, 8_000);
  assert.equal(SNAPSHOT_MIN_INTERVAL_MS, 15 * 60_000);
});

test("stamp: deriv_funding = funding8hRel, deriv_oi = base units, deriv_oi_chg_24h, deriv_source — only for coins the snapshot covers; all are ensureShadowColumns columns", () => {
  const kf = parseKrakenFuturesTickers(KF_PAYLOAD);
  const byCoin = Object.fromEntries(Object.values(normalizeDerivatives(kf, [])).map((t) => [t.coin, { source: t.source, funding8hRel: t.funding8hRel, oi: t.oi, oiChg24h: t.coin === "BTC" ? 0.02 : null }]));
  const intel = gatherIntel({ features: {} }, null, null, derivStamps(byCoin));
  const btc = stampSql(intel, "BTC");
  const i = btc.columns.indexOf("deriv_funding");
  assert.ok(i > 0);
  assert.deepEqual(btc.columns.slice(i, i + 4), ["deriv_funding", "deriv_oi", "deriv_oi_chg_24h", "deriv_source"]);
  assert.equal(btc.values[i], kf.find((t) => t.coin === "BTC")!.funding8hRel);
  assert.equal(btc.values[i + 1], 1894.5955);
  assert.equal(btc.values[i + 2], 0.02);
  assert.equal(btc.values[i + 3], "kraken-futures");
  assert.ok(!stampSql(intel, "DOGE").columns.includes("deriv_funding"), "an uncovered coin stamps nothing (NULL by default)");
  assert.equal(derivStamps(null), null);
  const created = new Set(INTEL_STAMP_COLUMNS.map((c) => c.split(" ")[0]));
  for (const c of btc.columns.filter((c) => c.startsWith("deriv_"))) assert.ok(created.has(c), `${c} is created by ensureShadowColumns`);
});

test("source: the scan snapshots derivatives BEFORE scanUniverse, deadline-guarded, and the executor/guardian never import the feed", () => {
  const scan = readFileSync(new URL("../src/app/api/cron/margin-scan/route.ts", import.meta.url), "utf8");
  const snapAt = scan.indexOf("await snapshotDerivatives({ deadlineMs: routeDeadlineMs })");
  const scanAt = scan.indexOf("await scanUniverse()");
  assert.ok(snapAt > 0 && snapAt < scanAt);
  assert.ok(/derivStamps\(deriv\.latest\?\.byCoin\)/.test(scan), "every paper row is stamped from the latest snapshot");
  for (const f of ["../src/lib/margin-executor.ts", "../src/app/api/cron/margin-watch/route.ts", "../src/lib/margin-live-risk.ts", "../src/lib/margin-risk-tiers.ts"]) {
    assert.ok(!/margin-derivatives/.test(readFileSync(new URL(f, import.meta.url), "utf8")), `${f} does not import the feed`);
  }
  const study = readFileSync(new URL("../scripts/study-derivatives-edge.ts", import.meta.url), "utf8");
  assert.ok(/REGISTERED_AT = "2026-09-15"/.test(study) && /OOS_FROM = "2026-10-06"/.test(study) && /MIN_BUCKET = 30/.test(study));
  for (const h of ["H1", "H2", "H3"]) assert.ok(new RegExp(`summarise\\("${h} `).test(study), `${h} is computed`);
});
