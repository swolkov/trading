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

// True when a Kraken pair (any spelling) refers to the same market as an app symbol
// like "BTC/USD".
export function pairMatchesSymbol(krakenPair: string, symbol: string): boolean {
  const symBase = symbol.toUpperCase().split("/")[0];
  return pairBase(krakenPair) === (symBase === "XBT" ? "BTC" : symBase);
}
