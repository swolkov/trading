import type { EdgeStatistics, ReplayDiagnostics, ReplayTrade, ValidationVerdict } from "./types";

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.9999999999998099;
  const z = value - 1;
  for (let index = 0; index < coefficients.length; index++) x += coefficients[index] / (z + index + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-12;
  const floor = 1e-30;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const twice = 2 * iteration;
    let delta = iteration * (b - iteration) * x / ((qam + twice) * (a + twice));
    d = 1 + delta * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + delta / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    result *= d * c;
    delta = -(a + iteration) * (qab + iteration) * x / ((a + twice) * (qap + twice));
    d = 1 + delta * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + delta / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const step = d * c;
    result *= step;
    if (Math.abs(step - 1) < epsilon) break;
  }
  return result;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? front * betaContinuedFraction(a, b, x) / a
    : 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

export function oneSidedStudentTPValue(tStat: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(tStat) || degreesOfFreedom < 1 || tStat <= 0) return 1;
  const x = degreesOfFreedom / (degreesOfFreedom + tStat * tStat);
  return 0.5 * regularizedBeta(x, degreesOfFreedom / 2, 0.5);
}

export function edgeStatistics(rows: readonly ReplayTrade[]): EdgeStatistics {
  if (!rows.length) return { trades: 0, netPnl: 0, expectancyR: 0, profitFactor: 0, winRate: 0, tStat: 0, maxDrawdownR: 0, firstHalfR: 0, secondHalfR: 0, largestWinnerShare: 1 };
  const r = rows.map((row) => row.rMultiple);
  const pnl = rows.map((row) => row.pnl);
  const mean = r.reduce((sum, value) => sum + value, 0) / r.length;
  const variance = r.length > 1 ? r.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (r.length - 1) : 0;
  const tStat = variance > 0 ? mean / (Math.sqrt(variance) / Math.sqrt(r.length)) : 0;
  const grossProfit = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(pnl.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  let cumulative = 0, peak = 0, maxDrawdownR = 0;
  for (const value of r) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cumulative);
  }
  const split = Math.floor(r.length / 2);
  const winners = pnl.filter((value) => value > 0).sort((a, b) => b - a);
  return {
    trades: rows.length,
    netPnl: pnl.reduce((sum, value) => sum + value, 0),
    expectancyR: mean,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    winRate: pnl.filter((value) => value > 0).length / pnl.length,
    tStat,
    maxDrawdownR,
    firstHalfR: r.slice(0, split).reduce((sum, value) => sum + value, 0),
    secondHalfR: r.slice(split).reduce((sum, value) => sum + value, 0),
    largestWinnerShare: grossProfit > 0 ? (winners[0] ?? 0) / grossProfit : 1,
  };
}

export function validateCandidate(
  rows: readonly ReplayTrade[],
  hypothesesTested: number,
  options: {
    evaluationFraction?: number;
    folds?: number;
    embargoMs?: number;
    diagnostics?: ReplayDiagnostics;
  } = {},
): ValidationVerdict {
  const evaluationFraction = options.evaluationFraction ?? 0.2;
  const foldCount = options.folds ?? 4;
  const embargoMs = options.embargoMs ?? 24 * 60 * 60 * 1000;
  const ordered = [...rows].sort((a, b) => a.entryTime - b.entryTime);
  const cut = Math.floor(ordered.length * (1 - evaluationFraction));
  const evaluationStart = ordered[cut]?.entryTime ?? Infinity;
  const developmentRows = ordered.slice(0, cut).filter((row) => row.exitTime < evaluationStart - embargoMs);
  const evaluationRows = ordered.slice(cut);
  const development = edgeStatistics(developmentRows);
  const evaluation = edgeStatistics(evaluationRows);
  const folds: EdgeStatistics[] = [];
  for (let fold = 0; fold < foldCount; fold++) {
    const start = Math.floor(developmentRows.length * fold / foldCount);
    const end = Math.floor(developmentRows.length * (fold + 1) / foldCount);
    folds.push(edgeStatistics(developmentRows.slice(start, end)));
  }

  const oneSidedP = oneSidedStudentTPValue(development.tStat, Math.max(1, development.trades - 1));
  const adjustedPValue = Math.min(1, oneSidedP * Math.max(1, hypothesesTested));
  const reasons: string[] = [];
  if (development.trades < 100) reasons.push("development sample below 100 trades");
  if (evaluation.trades < 30) reasons.push("evaluation sample below 30 trades");
  if (development.expectancyR <= 0 || evaluation.expectancyR <= 0) reasons.push("expectancy is not positive in development and evaluation");
  if (development.firstHalfR <= 0 || development.secondHalfR <= 0) reasons.push("development chronological halves are not both positive");
  if (folds.some((fold) => fold.expectancyR <= 0)) reasons.push("at least one walk-forward fold is non-positive");
  if (evaluation.profitFactor < 1.15) reasons.push("evaluation profit factor below 1.15");
  if (adjustedPValue >= 0.05) reasons.push("fails multiple-testing-adjusted significance");
  if (development.largestWinnerShare > 0.25 || evaluation.largestWinnerShare > 0.25) reasons.push("results depend too heavily on one winner");
  if ((options.diagnostics?.invalidSignals ?? 0) > 0) reasons.push("candidate emitted invalid risk parameters");
  if ((options.diagnostics?.unpriceableEntries ?? 0) > 0) reasons.push("modeled entry slippage exceeded the observed entry-bar range");
  if ((options.diagnostics?.rollInterruptedTrades ?? 0) > 0) reasons.push("continuous-contract roll interrupted an open trade");

  // Historical data can produce a research lead, never a demo or live promotion. The evaluation
  // slice is visible and reusable during research, so it is not represented as a locked holdout.
  const executionIsPriceable = (options.diagnostics?.invalidSignals ?? 0) === 0
    && (options.diagnostics?.unpriceableEntries ?? 0) === 0
    && (options.diagnostics?.rollInterruptedTrades ?? 0) === 0;
  const status: ValidationVerdict["status"] = executionIsPriceable && reasons.length === 0 ? "research" : "reject";
  return { status, reasons, adjustedPValue, development, evaluation, folds };
}
