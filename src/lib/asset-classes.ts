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
  // Infrastructure
  exchange: string;       // e.g. "CME GLOBEX"
  dataFeed: string;       // e.g. "Databento GLBX.MDP3"
  broker: string;         // e.g. "Tradovate"
  hours: string;          // e.g. "Sun 6pm ET → Fri 5pm ET, 1h daily break"
}

export const ASSET_CLASSES: AssetClassMeta[] = [
  {
    id: "equity_index_futures",
    label: "Equity Index Futures",
    shortLabel: "Equity",
    description: "ES, NQ, YM, RTY + their micro counterparts (MES, MNQ, MYM, M2K).",
    symbols: ["ES", "NQ", "YM", "RTY", "MES", "MNQ", "MYM", "M2K"],
    exchange: "CME GLOBEX",
    dataFeed: "Databento GLBX.MDP3",
    broker: "Tradovate",
    hours: "Sun 6pm → Fri 5pm ET (1h daily break)",
  },
  {
    id: "metals_futures",
    label: "Metals Futures",
    shortLabel: "Metals",
    description: "Gold + Micro Gold (GC, MGC).",
    symbols: ["GC", "MGC"],
    exchange: "COMEX",
    dataFeed: "Databento GLBX.MDP3",
    broker: "Tradovate",
    hours: "Sun 6pm → Fri 5pm ET (1h daily break)",
  },
  {
    id: "crypto_futures",
    label: "Crypto Futures",
    shortLabel: "Crypto",
    description:
      "CME micro crypto futures: MBT (Bitcoin), MET (Ether), BFF (Bitcoin weekly), MXR (XRP), MSL (Solana).",
    symbols: ["MBT", "MET", "BFF", "MXR", "MSL"],
    exchange: "CME GLOBEX",
    dataFeed: "Databento GLBX.MDP3",
    broker: "Tradovate",
    hours: "Sun 6pm → Fri 5pm ET (1h daily break)",
  },
  {
    id: "relative_value_spreads",
    label: "Relative-Value Spreads",
    shortLabel: "Spreads",
    description:
      "Multi-leg commodity, metals, FX, and grain spread book — the only Tier-1 validated edge. Needs $100k+ capital.",
    symbols: ["CL-RB", "ZC-ZS", "6E-6B", "GC-SI"],
    exchange: "CME / NYMEX / CBOT / COMEX",
    dataFeed: "Databento (GLBX + XNAS)",
    broker: "Tradovate (multi-leg)",
    hours: "Sun 6pm → Fri 5pm ET",
  },
  {
    id: "stocks",
    label: "Stocks (Alpaca)",
    shortLabel: "Stocks",
    description:
      "US equities via Alpaca. Swing trades from research watchlist + AI grader.",
    symbols: ["AAPL", "NVDA", "TSLA", "MSFT", "GOOGL"],
    exchange: "NYSE / NASDAQ",
    dataFeed: "Alpaca Market Data (IEX)",
    broker: "Alpaca",
    hours: "Mon-Fri 9:30am–4pm ET (RTH)",
  },
  {
    id: "crypto_spot",
    label: "Crypto Spot (Alpaca)",
    shortLabel: "Crypto Spot",
    description:
      "24/7 spot crypto on Alpaca — no expiry, no margin. Trades fractional BTC/ETH.",
    symbols: ["BTCUSD", "ETHUSD"],
    exchange: "Alpaca aggregator (Coinbase + Binance.US routing)",
    dataFeed: "Alpaca Crypto WS",
    broker: "Alpaca",
    hours: "24 / 7 / 365",
  },
  {
    id: "options",
    label: "Stock Options",
    shortLabel: "Options",
    description:
      "Stock options strategies (wheel / covered calls / bearish puts). Currently disabled.",
    symbols: [],
    exchange: "CBOE / OCC",
    dataFeed: "Alpaca Options",
    broker: "Alpaca",
    hours: "Mon-Fri 9:30am–4pm ET (RTH)",
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
