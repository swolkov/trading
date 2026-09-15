export type Direction = "long" | "short";

export interface ResearchBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  instrumentId: string;
}

export interface MarketSpec {
  symbol: "ES" | "NQ" | "GC" | "YM" | "SI" | "HG";
  tradedSymbol: "MES" | "MNQ" | "MGC" | "MYM" | "SIL" | "MHG";
  pointValue: number;
  tickSize: number;
  commissionRoundTurn: number;
  entrySlippagePoints: number;
  exitSlippagePoints: number;
  /** Where the slippage figure comes from: fills on the demo (`measured`) or a stated guess (`assumed`). */
  slippageSource?: "measured" | "assumed";
}

export interface EdgeSignal {
  edgeKey: string;
  version: string;
  direction: Direction;
  stopDistance: number;
  targetDistance: number;
  maxHoldBars: number;
  rationale: string;
}

export type EdgeFamily =
  | "compression_breakout" | "opening_drive" | "slow_trend"
  // The TRADOVATE FUTURES prompt's families (E10), pre-registered in research/edge-factory-trials.json.
  | "orb_continuation" | "vwap_reclaim" | "vwap_deviation_mr" | "pdh_pdl_break"
  | "overnight_range_break" | "liquidity_sweep_reversal" | "range_expansion_momentum" | "ma_continuation";

export interface EdgeCandidate {
  key: string;
  version: string;
  family: EdgeFamily;
  /** The bar size the rule is evaluated on (the replay feeds it bars aggregated to this width). */
  barMinutes: number;
  minimumHistory: number;
  evaluate: (bars: readonly ResearchBar[], index: number) => EdgeSignal | null;
}

export interface ReplayTrade {
  edgeKey: string;
  version: string;
  symbol: string;
  direction: Direction;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopDistance: number;
  pnl: number;
  rMultiple: number;
  exitReason: "stop" | "target" | "time" | "contract_roll";
}

export interface ReplayDiagnostics {
  signals: number;
  invalidSignals: number;
  unpriceableEntries: number;
  rollCrossingEntries: number;
  rollInterruptedTrades: number;
}

export interface ReplayResult {
  trades: ReplayTrade[];
  diagnostics: ReplayDiagnostics;
}

export interface EdgeStatistics {
  trades: number;
  netPnl: number;
  expectancyR: number;
  /** 95% confidence interval on the mean R (normal approximation, ±1.96 standard errors). */
  expectancyCi95: [number, number];
  profitFactor: number;
  winRate: number;
  tStat: number;
  maxDrawdownR: number;
  firstHalfR: number;
  secondHalfR: number;
  largestWinnerShare: number;
}

export interface ValidationVerdict {
  status: "reject" | "research";
  reasons: string[];
  adjustedPValue: number;
  development: EdgeStatistics;
  evaluation: EdgeStatistics;
  folds: EdgeStatistics[];
}
