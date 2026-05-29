/**
 * Asset class taxonomy — central map of which symbols belong to which class.
 * Used by UI navigation tabs, admin views, and per-asset-class P&L attribution.
 *
 * Keep in sync with src/lib/tradovate.ts (TRADOVATE_CONTRACTS) and
 * src/lib/strategies/registry.ts.
 */

export type AssetClass =
  | "equity_index_futures"
  | "metals_futures"
  | "crypto_futures"
  | "relative_value_spreads"
  | "stocks"
  | "crypto_spot"
  | "options";

export interface AssetClassMeta {
  id: AssetClass;
  label: string;
  shortLabel: string;
  description: string;
  symbols: string[]; // canonical symbols (root, no month code)
}

export const ASSET_CLASSES: AssetClassMeta[] = [
  {
    id: "equity_index_futures",
    label: "Equity Index Futures",
    shortLabel: "Equity",
    description: "ES, NQ, YM, RTY + their micro counterparts (MES, MNQ, MYM, M2K).",
    symbols: ["ES", "NQ", "YM", "RTY", "MES", "MNQ", "MYM", "M2K"],
  },
  {
    id: "metals_futures",
    label: "Metals Futures",
    shortLabel: "Metals",
    description: "Gold + Micro Gold (GC, MGC).",
    symbols: ["GC", "MGC"],
  },
  {
    id: "crypto_futures",
    label: "Crypto Futures",
    shortLabel: "Crypto",
    description:
      "CME micro crypto futures: MBT (Bitcoin), MET (Ether), BFF (Bitcoin weekly), MXR (XRP), MSL (Solana).",
    symbols: ["MBT", "MET", "BFF", "MXR", "MSL"],
  },
  {
    id: "relative_value_spreads",
    label: "Relative-Value Spreads",
    shortLabel: "Spreads",
    description:
      "Multi-leg commodity, metals, FX, and grain spread book — the only Tier-1 validated edge. Needs $100k+ capital. Pairs include crack (CL/RB), grains (ZC/ZS), FX (6E/6B), and metals spreads.",
    symbols: ["CL-RB", "ZC-ZS", "6E-6B", "GC-SI"],
  },
  {
    id: "stocks",
    label: "Stocks (Alpaca)",
    shortLabel: "Stocks",
    description:
      "US equities via Alpaca. Swing trades from research watchlist + AI grader. $1K paper / live mode controlled separately.",
    symbols: ["AAPL", "NVDA", "TSLA", "MSFT", "GOOGL"],
  },
  {
    id: "crypto_spot",
    label: "Crypto Spot (Alpaca)",
    shortLabel: "Crypto Spot",
    description:
      "24/7 spot crypto on Alpaca — no expiry, no margin. Trades fractional BTC/ETH from $1K paper account.",
    symbols: ["BTCUSD", "ETHUSD"],
  },
  {
    id: "options",
    label: "Stock Options",
    shortLabel: "Options",
    description:
      "Stock options strategies (wheel / covered calls / bearish puts). Currently disabled — see Rules/anti-patterns.md.",
    symbols: [],
  },
];

/** Look up the asset class for a symbol; returns undefined for unknown symbols. */
export function assetClassFor(symbol: string): AssetClass | undefined {
  for (const ac of ASSET_CLASSES) {
    if (ac.symbols.includes(symbol)) return ac.id;
  }
  return undefined;
}

/** Filter a symbol list to a specific asset class. */
export function filterByAssetClass(symbols: string[], assetClass: AssetClass): string[] {
  const meta = ASSET_CLASSES.find((ac) => ac.id === assetClass);
  if (!meta) return [];
  return symbols.filter((s) => meta.symbols.includes(s));
}

/** Returns the asset classes present in a given symbol list. */
export function assetClassesIn(symbols: string[]): AssetClassMeta[] {
  return ASSET_CLASSES.filter((ac) =>
    symbols.some((s) => ac.symbols.includes(s)),
  );
}
