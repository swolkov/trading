// Kraken pair-name normalization, shared by server AND client code (no imports).
//
// Kraken is inconsistent about pair names: you can send "XBTUSD" but OpenPositions,
// Ticker, and the ledger echo CANONICAL names like "XXBTZUSD" (X-prefixed base,
// Z-prefixed quote). Matching positions to symbols with ad-hoc string surgery
// produced a real bug (XXBTZUSD → "BTZ" ≠ "BTC"), so every comparison goes through
// this one function.
export function pairBase(pair: string): string {
  // ⚠️ Two known traps, both currently fail-SAFE (neither coin is US-margin-tradeable, so
  // both classify as non-US): "XTZUSD" → "XT" (the ZUSD strip eats Tezos's trailing Z) and
  // "XAUTUSD" → "AUT" (the X-prefix rule fires on a 4+ letter code). If Kraken ever adds
  // XTZ or XAUT to US margin, fix THIS function before adding them to the table — the
  // SQL/JS agreement test in tests/us-margin-universe.test.ts will fail loudly until then.
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

// THE ORDER pair for a US-retail MARGIN order. Kraken routes US retail leverage through
// its Bitnomial-cleared venue and requires the ":BTNL" suffix on every leveraged order —
// entry, close, and stop alike. Without it the API answers "EOrder:Reduce only:Non-ECP"
// (validate=true still PASSES, which is how the $20 round trip caught it on Sep 5 2026).
// Public endpoints (Ticker/OHLC/AssetPairs) do NOT accept the suffix — use publicPairFor.
// Accepts "BTC/USD", "XBTUSD", "XXBTZUSD" or "XBTUSD:BTNL".
export const US_MARGIN_VENUE_SUFFIX = ":BTNL";
export function marginOrderPairFor(symbolOrPair: string): string {
  return `${publicPairFor(symbolOrPair.replace("/", ""))}${US_MARGIN_VENUE_SUFFIX}`;
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
//
// ⚠️ VERIFIED AGAINST KRAKEN ITSELF on 2026-09-09 (GET /api/margin/leverage-probe): a
// validate=true AddOrder at each rung on the :BTNL venue pair, which runs Kraken's own
// server-side checks and places nothing. Four entries were UNDERSTATED and were raised:
//
//   XLM     2 → 5      ALGO    2 → 5      NEAR    3 → 5      RENDER  3 → 5
//
// Both controls passed in the same run — BTC accepted 20× (matching real fills) and ETH
// accepted 10× — so the probe was answering honestly rather than accepting everything.
//
// This was never cosmetic. Margin is notional ÷ leverage, so at identical risk a 2× cap
// made an XLM position cost ~4.5× an ETH one, and the 150% entry floor then REFUSED it at
// live size. XLM is the top contributor in the 112-day replay: an understated cap had
// silently deleted the best-performing coin from the book.
//
// Kraken's PUBLIC AssetPairs endpoint is NOT a valid source for these numbers — it
// describes the international product and advertises BTC at 10× where the US venue really
// gives 20×. Re-run the probe rather than reading the public feed.
export const US_MARGIN_MAX_LEVERAGE: Record<string, number> = {
  BTC: 20,
  ADA: 10, AVAX: 10, DOGE: 10, ETH: 10, LINK: 10, LTC: 10, SOL: 10, SUI: 10, USDC: 10, XRP: 10,
  AAVE: 5, BCH: 5, CRV: 5, DOT: 5, HBAR: 5, HYPE: 5, PEPE: 5, PAXG: 5, SHIB: 5, TRX: 5, UNI: 5, ZEC: 5,
  ALGO: 5, NEAR: 5, RENDER: 5, XLM: 5,   // probe-verified 2026-09-09, was 2/3/3/2
  PENGU: 3,
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

// What the scanner WATCHES: the US list minus the two that do not move (USDC stablecoin,
// PAXG gold). Lives here (no imports) so client components can show the list truthfully.
export const SCAN_UNIVERSE: string[] = Object.keys(US_MARGIN_MAX_LEVERAGE).filter((b) => b !== "USDC" && b !== "PAXG");

// SQL predicate selecting paper trades on US-tradeable pairs. Built from the table above
// (constants only — no user input reaches this string). Accepts every spelling a row could
// plausibly be stored under — NAME/USD (the webhook and scanner form), NAMEUSD (raw Kraken
// code), and Kraken's legacy XBT/XDG aliases — so a future insert path that stores a raw
// pair code cannot be silently excluded by SQL while the JS badge calls it tradeable. Kept
// in step with isUsMarginSymbol() by a unit test, so SQL and JS can never disagree.
export const US_MARGIN_SYMBOLS_SQL: string = `upper(COALESCE(symbol,'')) IN (${[
  ...US_MARGIN_SYMBOLS,
  ...Object.keys(US_MARGIN_MAX_LEVERAGE).map((b) => `${b}USD`),
  "XBT/USD", "XBTUSD", "XXBTZUSD", "XDG/USD", "XDGUSD", "XXDGZUSD",
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
