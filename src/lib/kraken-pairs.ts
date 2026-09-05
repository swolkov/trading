// Kraken pair-name normalization, shared by server AND client code (no imports).
//
// Kraken is inconsistent about pair names: you can send "XBTUSD" but OpenPositions,
// Ticker, and the ledger echo CANONICAL names like "XXBTZUSD" (X-prefixed base,
// Z-prefixed quote). Matching positions to symbols with ad-hoc string surgery
// produced a real bug (XXBTZUSD → "BTZ" ≠ "BTC"), so every comparison goes through
// this one function.
export function pairBase(pair: string): string {
  // Kraken's US margin product suffixes a clearing-venue tag: "XBTUSD:BTNL"
  // (Bitnomial). Spencer's real margin fills ALL carry it — strip it first.
  let base = pair.toUpperCase().replace(/:[A-Z0-9]+$/, "").replace(/ZUSD$/, "").replace(/USD$/, "");
  // Legacy X-prefix on 4+ letter codes: XXBT → XBT, XETH → ETH handled below.
  base = base.replace(/^X(?=[A-Z]{3,})/, "");
  if (base === "XBT") base = "BTC";
  if (base === "XDG") base = "DOGE";
  return base;
}

// The PUBLIC market-data pair for any position's pair name. Ticker/OHLC do not accept
// venue-suffixed names, so "XBTUSD:BTNL" must be priced via "XBTUSD".
export function publicPairFor(pair: string): string {
  const base = pairBase(pair);
  if (base === "BTC") return "XBTUSD";
  if (base === "DOGE") return "XDGUSD";
  return `${base}USD`;
}

// ⭐ THE US-RETAIL MARGIN UNIVERSE — the ONLY pairs Spencer's account can margin-trade.
// Kraken's public AssetPairs endpoint describes the INTERNATIONAL product (132 USD pairs,
// ECP-only for US clients), which is NOT what a US retail account gets. US retail margin
// runs through Kraken Derivatives US (Bitnomial-cleared — his real fills carry the
// ":BTNL" suffix) and covers this list only. Source: Kraken support, "Getting started
// with US margin trading", last updated Aug 11 2026. Verified against his own fills
// (SOLUSD:BTNL, XBTUSD:BTNL, ETHUSD:BTNL, HYPEUSD:BTNL, PEPEUSD).
//
// Why this matters: on Sep 5 2026 the paper desk was found to be scanning 37 coins of
// which 19 were NOT on this list — 64% of resolved paper trades and ALL of the losses
// were on coins the live book could never take. Paper must measure what live can do, so
// the scanner universe, the scoreboard, and the executor all gate on this one table.
// Re-verify against the support page before arming; Kraken adds pairs a few at a time.
export const US_MARGIN_MAX_LEVERAGE: Record<string, number> = {
  BTC: 20,
  ADA: 10, AVAX: 10, DOGE: 10, ETH: 10, LINK: 10, LTC: 10, SOL: 10, SUI: 10, USDC: 10, XRP: 10,
  AAVE: 5, BCH: 5, CRV: 5, DOT: 5, HBAR: 5, HYPE: 5, PEPE: 5, PAXG: 5, SHIB: 5, TRX: 5, UNI: 5, ZEC: 5,
  PENGU: 3, NEAR: 3, RENDER: 3,
  ALGO: 2, XLM: 2,
};

// Base asset of an app symbol ("BTC/USD") OR a Kraken pair (any spelling) — one function so
// "BTC/USD", "XBTUSD", "XXBTZUSD" and "XBTUSD:BTNL" all resolve to "BTC".
export function symbolBase(symbolOrPair: string): string {
  return pairBase(symbolOrPair.replace("/", ""));
}

// True when a US retail account can margin-trade this symbol/pair.
export function isUsMarginSymbol(symbolOrPair: string): boolean {
  return symbolBase(symbolOrPair) in US_MARGIN_MAX_LEVERAGE;
}

// The universe as app symbols ("BTC/USD" …), the spelling every paper trade is stored under.
export const US_MARGIN_SYMBOLS: string[] = Object.keys(US_MARGIN_MAX_LEVERAGE).map((b) => `${b}/USD`);

// SQL predicate selecting paper trades on US-tradeable pairs. Built from the table above
// (constants only — no user input reaches this string), plus Kraken's legacy aliases so a
// manual alert spelled XBT/USD or XDG/USD is still recognised as BTC/DOGE. Kept in step
// with isUsMarginSymbol() by a unit test, so SQL and JS can never disagree on a symbol.
export const US_MARGIN_SYMBOLS_SQL: string = `upper(COALESCE(symbol,'')) IN (${[
  ...US_MARGIN_SYMBOLS, "XBT/USD", "XDG/USD",
].map((s) => `'${s}'`).join(",")})`;

// Max US-retail leverage for a pair; anything not in the table falls back to the caller's
// AssetPairs value (which is only ever reached for pairs a US account cannot margin anyway).
export function usRetailMaxLeverage(pair: string, fallback: number): number {
  return US_MARGIN_MAX_LEVERAGE[symbolBase(pair)] ?? fallback;
}

// True when a Kraken pair (any spelling) refers to the same market as an app symbol
// like "BTC/USD".
export function pairMatchesSymbol(krakenPair: string, symbol: string): boolean {
  const symBase = symbol.toUpperCase().split("/")[0];
  return pairBase(krakenPair) === (symBase === "XBT" ? "BTC" : symBase);
}
