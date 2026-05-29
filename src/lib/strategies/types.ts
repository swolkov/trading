/**
 * Strategy interface — one signal-generator per (asset class × timeframe × signal-family).
 *
 * Different asset classes behave fundamentally differently (proved empirically: same code that
 * works on equity indexes catastrophically fails on crypto futures). Each Strategy declares the
 * symbols it applies to + its validated tier per EDGE-HIERARCHY.md, so the engine never runs the
 * wrong signal on the wrong instrument.
 */

export interface OHLCBar {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface StrategySignal {
  direction: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  // What kind of signal fired — for logging and journaling
  setupName: string;
  // Strategy id that fired
  strategyId: string;
  // Why this fired in plain English (goes into the trade journal)
  reason: string;
  // Optional: confidence score [0-100] if the strategy computes one
  confidence?: number;
}

/**
 * Validated tier per EDGE-HIERARCHY.md.
 *  1 = full-battery validated, real-capital ready
 *  2 = plausible-unvalidated (backtest positive, needs forward shadow execution)
 *  3 = speculative R&D (data-gated)
 *  "rejected" = tested and failed — kept here for traceability; never registered
 */
export type Tier = 1 | 2 | 3 | "rejected";

export interface BacktestEvidence {
  pf: number;
  trades: number;
  netPerContract: number;
  winRate: number;
  period: string; // "2022-05 → 2026-05"
  yearsPositive: string; // "4 of 5"
}

export interface Strategy {
  /** Unique id — kebab-case, includes asset+timeframe+signal-family */
  id: string;
  /** Human-readable name for UI / journal */
  name: string;
  /** Which symbols this strategy applies to. Empty = applies to none (placeholder). */
  applicableSymbols: string[];
  /** Bar timeframe this strategy operates on */
  timeframe: Timeframe;
  /** Validated tier per EDGE-HIERARCHY.md */
  tier: Tier;
  /** One-line description of the edge */
  description: string;
  /** Backtest evidence — what the historical data showed */
  backtest?: BacktestEvidence;
  /** Path to the vault doc with full strategy writeup */
  vaultDoc?: string;
  /** Path to the code file implementing the signal */
  codePath: string;
  /**
   * Run the signal detector against the most recent bars.
   * Returns a signal if conditions are met, null otherwise.
   * MUST be deterministic and idempotent — the engine may call this on every cycle.
   */
  detect(bars: OHLCBar[], context: { symbol: string; now: number }): StrategySignal | null;
}
