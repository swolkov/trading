import assert from "node:assert/strict";
import test from "node:test";
import {
  US_MARGIN_MAX_LEVERAGE,
  US_MARGIN_SYMBOLS,
  US_MARGIN_SYMBOLS_SQL,
  isUsMarginSymbol,
  symbolBase,
  usRetailMaxLeverage,
} from "../src/lib/kraken-pairs";
import { SCAN_COINS } from "../src/lib/margin-scanner";

// The 19 coins removed on Sep 5 2026 — none may ever come back without landing on Kraken's
// US retail margin list first. They carried −$12.7k of paper losses live could never take.
const REMOVED_SEP5 = ["BNB", "XMR", "TIA", "TON", "APT", "ICP", "INJ", "ARB", "OP", "ATOM", "ETC", "FIL", "POL", "ONDO", "BONK", "WLD", "JUP", "STX", "PYTH"];

test("every scanned coin is one a US retail account can margin-trade", () => {
  for (const c of SCAN_COINS) {
    assert.equal(isUsMarginSymbol(c.symbol), true, `${c.symbol} is scanned but not US-margin-tradeable`);
    assert.equal(c.symbol, `${c.name}/USD`, `${c.name}: symbol spelling must be NAME/USD (the stored form)`);
  }
});

test("the scanner does not watch what it cannot trade — the Sep 5 removals stay out", () => {
  const scanned = new Set(SCAN_COINS.map((c) => c.name));
  for (const name of REMOVED_SEP5) {
    assert.equal(scanned.has(name), false, `${name} was removed Sep 5 (not US-tradeable) and must not be scanned`);
    assert.equal(isUsMarginSymbol(`${name}/USD`), false, `${name} must not be in the US table`);
  }
});

test("stablecoins and gold are on the US list but never scanned — they do not move", () => {
  const scanned = new Set(SCAN_COINS.map((c) => c.name));
  for (const name of ["USDC", "PAXG"]) {
    assert.equal(name in US_MARGIN_MAX_LEVERAGE, true);
    assert.equal(scanned.has(name), false, `${name} must not be scanned`);
  }
  // No duplicates, and the list is the whole tradeable universe minus those two.
  assert.equal(scanned.size, SCAN_COINS.length, "duplicate coin in SCAN_COINS");
  assert.equal(scanned.size, Object.keys(US_MARGIN_MAX_LEVERAGE).length - 2);
});

test("symbolBase resolves every spelling Kraken uses to the same base", () => {
  for (const s of ["BTC/USD", "XBT/USD", "XBTUSD", "XXBTZUSD", "XBTUSD:BTNL", "btc/usd"]) {
    assert.equal(symbolBase(s), "BTC", s);
  }
  assert.equal(symbolBase("XDG/USD"), "DOGE");
  assert.equal(symbolBase("DOGE/USD"), "DOGE");
  assert.equal(symbolBase("XXLMZUSD"), "XLM");
  assert.equal(symbolBase("XZECZUSD"), "ZEC");
  assert.equal(symbolBase("SOLUSD:BTNL"), "SOL");
  assert.equal(symbolBase("PENGU/USD"), "PENGU");
  assert.equal(symbolBase("ARB/USD"), "ARB");
});

test("the SQL predicate and isUsMarginSymbol agree on every stored spelling", () => {
  // Paper trades are stored as NAME/USD. Parse the IN-list out of the SQL constant and
  // check it against the JS function for every symbol that has ever been stored plus the
  // aliases, so the scoreboard (SQL) and the log badge (JS) can never disagree.
  const m = US_MARGIN_SYMBOLS_SQL.match(/IN \((.*)\)$/);
  assert.ok(m, "SQL predicate shape changed");
  const inList = new Set(m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")));
  assert.ok(US_MARGIN_SYMBOLS_SQL.startsWith("upper(COALESCE(symbol,'')) IN ("), "must be NULL-safe and case-insensitive");
  const stored = [
    ...US_MARGIN_SYMBOLS,
    ...REMOVED_SEP5.map((n) => `${n}/USD`),
    "XBT/USD", "XDG/USD", "btc/usd", "arb/usd",
  ];
  for (const s of stored) {
    assert.equal(inList.has(s.toUpperCase()), isUsMarginSymbol(s), `SQL and JS disagree on ${s}`);
  }
  for (const s of inList) {
    assert.doesNotMatch(s, /[^A-Z0-9/]/, `unexpected character in SQL list entry ${s}`);
  }
});

test("US-retail leverage caps come from the table, AssetPairs only as a fallback", () => {
  assert.equal(usRetailMaxLeverage("XBTUSD:BTNL", 10), 20);
  assert.equal(usRetailMaxLeverage("XXBTZUSD", 10), 20);
  assert.equal(usRetailMaxLeverage("XXLMZUSD", 3), 2);   // AssetPairs says 3x; US retail is 2x
  assert.equal(usRetailMaxLeverage("PENGUUSD", 3), 3);
  assert.equal(usRetailMaxLeverage("ETH/USD", 5), 10);
  assert.equal(usRetailMaxLeverage("ARBUSD", 3), 3);     // not US-tradeable: caller's fallback
});
