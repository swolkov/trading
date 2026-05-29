/**
 * Strategy registry — single source of truth for which strategies apply to which symbols.
 *
 * Update this file when:
 *  - A new strategy is added to ../../strategies/<name>.ts
 *  - A strategy's validated tier changes per EDGE-HIERARCHY.md
 *  - Forward shadow execution promotes a strategy from Tier 2 -> 1 (or rejects it)
 *
 * ROUTING LAYER: the futures-agent calls strategiesFor(symbol) to know which signal-generators
 * to run on the symbol's bars. Symbols with NO registered strategy are observation-only (the
 * sidecar collects price data, no trades placed).
 */

import type { Strategy } from "./types";
import { mbtNr4Daily } from "./mbt-nr4-daily";

export const STRATEGIES: Strategy[] = [
  mbtNr4Daily,
  // Future: equity-index-5m-rsi-bounce, gc-rsi-bounce, mbt-trend-trail-daily, spread-book-zscore
  // For now the existing 5m intraday detection in futures-agent.ts handles equity indexes;
  // those will be migrated into this registry incrementally.
];

/**
 * Symbols that should NEVER reach the existing 5m intraday detection logic in futures-agent.ts.
 * For these, the strategy registry above is the ONLY trading signal source — and if the registry
 * returns nothing for a symbol, it stays observation-only.
 *
 * Why: the existing 5m setup library was designed for equity index intraday behavior and
 * catastrophically loses on crypto futures (1yr backtest: MBT PF 0.84, MET PF 0.06, BFF PF 0.27).
 */
export const STRATEGY_REGISTRY_ONLY_SYMBOLS = new Set([
  "MBT", // Has registered strategy (mbt-nr4-daily)
  "MET", // Observation-only (no edge found in our framework)
  "BFF", // Observation-only (no edge found in our framework)
  "MXR", // Observation-only (launched 2025, not yet backtested)
  "MSL", // Observation-only (launched 2025, not yet backtested)
]);

/** Returns all strategies registered for a symbol. Empty array = observation-only. */
export function strategiesFor(symbol: string): Strategy[] {
  return STRATEGIES.filter((s) => s.applicableSymbols.includes(symbol));
}

/** True if this symbol must ONLY go through the registry (skip legacy 5m intraday detection). */
export function isRegistryOnlySymbol(symbol: string): boolean {
  return STRATEGY_REGISTRY_ONLY_SYMBOLS.has(symbol);
}
