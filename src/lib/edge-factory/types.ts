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
  symbol: "ES" | "NQ" | "GC";
  tradedSymbol: "MES" | "MNQ" | "MGC";
  pointValue: number;
  tickSize: number;
  commissionRoundTurn: number;
  entrySlippagePoints: number;
  exitSlippagePoints: number;
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

export interface EdgeCandidate {
  key: string;
  version: string;
  family: "compression_breakout" | "opening_drive" | "slow_trend";
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
