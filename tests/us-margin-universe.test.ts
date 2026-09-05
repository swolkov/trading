import assert from "node:assert/strict";
import test from "node:test";
import {
  SCAN_UNIVERSE,
  US_MARGIN_MAX_LEVERAGE,
  US_MARGIN_SYMBOLS,
  US_MARGIN_SYMBOLS_SQL,
  isUsMarginSymbol,
  symbolBase,
  usRetailMaxLeverage,
} from "../src/lib/kraken-pairs";

// Deliberately imports ONLY kraken-pairs (no DB, no Kraken client) so this file runs in a
// bare shell. margin-scanner's SCAN_COINS is derived from SCAN_UNIVERSE by construction.

// The 19 coins removed on Sep 5 2026 — none may ever come back without landing on Kraken's
// US retail margin list first. They carried −$12.7k of paper losses live could never take.
const REMOVED_SEP5 = ["BNB", "XMR", "TIA", "TON", "APT", "ICP", "INJ", "ARB", "OP", "ATOM", "ETC", "FIL", "POL", "ONDO", "BONK", "WLD", "JUP", "STX", "PYTH"];

test("every scanned coin is one a US retail account can margin-trade", () => {
  for (const name of SCAN_UNIVERSE) {
    assert.equal(isUsMarginSymbol(`${name}/USD`), true, `${name} is scanned but not US-margin-tradeable`);
    assert.equal(name in US_MARGIN_MAX_LEVERAGE, true);
  }
});

test("the scanner does not watch what it cannot trade — the Sep 5 removals stay out", () => {
  const scanned = new Set(SCAN_UNIVERSE);
  for (const name of REMOVED_SEP5) {
    assert.equal(scanned.has(name), false, `${name} was removed Sep 5 (not US-tradeable) and must not be scanned`);
    assert.equal(isUsMarginSymbol(`${name}/USD`), false, `${name} must not be in the US table`);
  }
});

test("stablecoins and gold are on the US list but never scanned — they do not move", () => {
  const scanned = new Set(SCAN_UNIVERSE);
  for (const name of ["USDC", "PAXG"]) {
    assert.equal(name in US_MARGIN_MAX_LEVERAGE, true);
    assert.equal(scanned.has(name), false, `${name} must not be scanned`);
  }
  assert.equal(scanned.size, SCAN_UNIVERSE.length, "duplicate coin in SCAN_UNIVERSE");
  assert.equal(scanned.size, Object.keys(US_MARGIN_MAX_LEVERAGE).length - 2);
  assert.equal(scanned.size, 26);
});

test("symbolBase resolves every spelling Kraken uses to the same base", () => {
  for (const s of ["BTC/USD", "XBT/USD", "XBTUSD", "XXBTZUSD", "XBTUSD:BTNL", "btc/usd", "xbtusd:btnl"]) {
    assert.equal(symbolBase(s), "BTC", s);
  }
  assert.equal(symbolBase("XDG/USD"), "DOGE");
  assert.equal(symbolBase("XXDGZUSD"), "DOGE");
  assert.equal(symbolBase("DOGE/USD"), "DOGE");
  assert.equal(symbolBase("XXLMZUSD"), "XLM");
  assert.equal(symbolBase("XZECZUSD"), "ZEC");
  assert.equal(symbolBase("XETHZUSD"), "ETH");
  assert.equal(symbolBase("SOLUSD:BTNL"), "SOL");
  assert.equal(symbolBase("PENGU/USD"), "PENGU");
  assert.equal(symbolBase("RENDERUSD"), "RENDER");
  assert.equal(symbolBase("ARB/USD"), "ARB");
  // Garbage fails safe.
  for (const s of ["", "USD", "/USD", "BTC/USDT", "ETH/USDC", "constructor", "__proto__"]) {
    assert.equal(isUsMarginSymbol(s), false, `${JSON.stringify(s)} must not be tradeable`);
  }
});

test("the SQL predicate and isUsMarginSymbol agree on every spelling a row could carry", () => {
  // Parse the IN-list out of the SQL constant and check it against the JS function for
  // every stored form (NAME/USD), raw Kraken codes, the aliases, and the removed coins —
  // so the scoreboard (SQL) and the log badge (JS) can never disagree on a symbol.
  const m = US_MARGIN_SYMBOLS_SQL.match(/IN \((.*)\)$/);
  assert.ok(m, "SQL predicate shape changed");
  const inList = new Set(m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")));
  assert.ok(US_MARGIN_SYMBOLS_SQL.startsWith("upper(COALESCE(symbol,'')) IN ("), "must be NULL-safe and case-insensitive");
  assert.equal(US_MARGIN_SYMBOLS_SQL.includes("$"), false, "must contain no $ — strategyBreakdown interpolates it next to $1/$2 params");
  const candidates = [
    ...US_MARGIN_SYMBOLS,
    ...Object.keys(US_MARGIN_MAX_LEVERAGE).map((b) => `${b}USD`),
    ...REMOVED_SEP5.map((n) => `${n}/USD`),
    ...REMOVED_SEP5.map((n) => `${n}USD`),
    "XBT/USD", "XBTUSD", "XXBTZUSD", "XDG/USD", "XDGUSD", "XXDGZUSD", "btc/usd", "arb/usd", "xbtusd",
  ];
  for (const s of candidates) {
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
  assert.equal(usRetailMaxLeverage("ALGO/USD", 5), 2);
  assert.equal(usRetailMaxLeverage("PENGUUSD", 3), 3);
  assert.equal(usRetailMaxLeverage("ETH/USD", 5), 10);
  assert.equal(usRetailMaxLeverage("ARBUSD", 3), 3);     // not US-tradeable: caller's fallback
});
