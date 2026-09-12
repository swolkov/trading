import assert from "node:assert/strict";
import test from "node:test";
import { valuePostedCosts } from "../src/lib/kraken-margin";
import { isUsdAsset, ledgerAssetToPair } from "../src/lib/kraken";

// The executor's cash-day guard. Kraken posts BTC/ETH rollover in the base coin (XXBT/XETH on
// the ledger) and alt rollover in ZUSD; the September 12 version called every coin-denominated
// fee "unknown" and refused entries for the rest of the day — the pyramid add included.

const px = (asset: string) => ({ XXBT: 77_000, XETH: 2_500 } as Record<string, number>)[asset] ?? null;

test("USD fees are summed as-is and coin fees are valued at the ticker", () => {
  const r = valuePostedCosts([{ asset: "ZUSD", fee: 10.5 }, { asset: "XXBT", fee: 0.0027 }, { asset: "XETH", fee: 0.004 }], px);
  assert.equal(r.unknown, false);
  assert.ok(Math.abs(r.usd - (10.5 + 0.0027 * 77_000 + 0.004 * 2_500)) < 1e-9);
});

test("a coin fee with no price is unknown — the entry is refused, never guessed", () => {
  const r = valuePostedCosts([{ asset: "ZUSD", fee: 3 }, { asset: "SOL", fee: 0.1 }], px);
  assert.equal(r.unknown, true);
  assert.equal(r.usd, 3);              // the priced part still counts
});

test("a zero or unpriceable price is unknown too", () => {
  assert.equal(valuePostedCosts([{ asset: "XXBT", fee: 0.001 }], () => 0).unknown, true);
  assert.equal(valuePostedCosts([{ asset: "XXBT", fee: 0.001 }], () => Number.NaN).unknown, true);
});

test("rebates and zero rows never add capacity and never need a price", () => {
  const r = valuePostedCosts([{ asset: "ZUSD", fee: -4 }, { asset: "XXBT", fee: 0 }, { asset: "DOGE", fee: -0.5 }], () => { throw new Error("must not price"); });
  assert.deepEqual(r, { usd: 0, unknown: false });
});

test("no rows today = nothing posted", () => {
  assert.deepEqual(valuePostedCosts([], px), { usd: 0, unknown: false });
});

test("a malformed row fails closed instead of reading as zero", () => {
  assert.throws(() => valuePostedCosts([{ asset: "ZUSD", fee: Number.NaN }], px), /financing unavailable/);
  assert.throws(() => valuePostedCosts([{ asset: 5 as unknown as string, fee: 1 }], px), /financing unavailable/);
});

test("ledger asset codes map to what Ticker accepts", () => {
  assert.equal(ledgerAssetToPair("XXBT"), "XBTUSD");
  assert.equal(ledgerAssetToPair("XETH"), "ETHUSD");
  assert.equal(ledgerAssetToPair("SOL"), "SOLUSD");
  assert.equal(isUsdAsset("ZUSD"), true);
  assert.equal(isUsdAsset("USD"), true);
  assert.equal(isUsdAsset("XXBT"), false);
});
