// FUTURES DESK — trade-series metrics, pure (E6).
//
// The desk's own metrics — PF, drawdown, Sharpe/Sortino, R, expectancy, streaks — on THIS desk's
// row shape (`MetricInput`: judged P&L, risk_usd, close instant, MFE/MAE in R). It used to mirror
// the crypto desk's `margin-metrics.ts`, deleted with that desk on Sep 19 2026; this is now the
// only copy of the arithmetic. Nothing here is a gate — the
// promotion verdict in futures-desk-review.ts reads these.
import { maxDrawdown, tStatOf } from "@/lib/futures-desk-rules";

export interface MetricInput {
  /** The judged P&L of one resolved trade (after modeled fees and slippage). */
  pnl: number;
  /** Initial risk in dollars (risk_usd); ≤ 0 = unknown, the trade carries no R. */
  risk: number;
  /** When it resolved (ISO) — the series is ordered by this. */
  at: string;
  mfeR?: number | null;
  maeR?: number | null;
}

export interface SeriesMetrics {
  n: number; wins: number; losses: number;
  hitRate: number | null;
  net: number; grossProfit: number; grossLoss: number;
  /** Gross wins ÷ gross losses; null when nothing was lost (undefined, not infinite — the page shows ∞ when n > 0). */
  profitFactor: number | null;
  maxDrawdownUsd: number;
  /** Max drawdown as a % of the sizing basis. */
  maxDrawdownPct: number;
  /** Per-trade mean ÷ sd of the dollar series, unannualised (the desk has no fixed trade clock). */
  sharpe: number | null;
  /** Per-trade mean ÷ downside deviation (losses only, root-mean-square); null with no losing trade. */
  sortino: number | null;
  avgR: number | null;
  expectancyUsd: number | null;
  expectancyR: number | null;
  /** t-stat of the R series (the desk's verdict statistic). */
  tStat: number | null;
  avgWin: number | null; avgLoss: number | null;
  largestWin: number; largestLoss: number;
  avgMfeR: number | null; avgMaeR: number | null;
  streak: { maxWins: number; maxLosses: number; current: number };
  spanDays: number; firstAt: string | null; lastAt: string | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const sd = (xs: number[]): number | null => {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
};

export const EMPTY_METRICS: SeriesMetrics = {
  n: 0, wins: 0, losses: 0, hitRate: null, net: 0, grossProfit: 0, grossLoss: 0, profitFactor: null, maxDrawdownUsd: 0, maxDrawdownPct: 0,
  sharpe: null, sortino: null, avgR: null, expectancyUsd: null, expectancyR: null, tStat: null, avgWin: null, avgLoss: null, largestWin: 0, largestLoss: 0,
  avgMfeR: null, avgMaeR: null, streak: { maxWins: 0, maxLosses: 0, current: 0 }, spanDays: 0, firstAt: null, lastAt: null,
};

/** The metrics of one series. Rows are sorted by `at` first, so drawdown and streaks read in resolve order. */
export function sleeveMetrics(input: MetricInput[], basisUsd: number): SeriesMetrics {
  const rows = input.filter((r) => Number.isFinite(r.pnl)).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!rows.length) return { ...EMPTY_METRICS };
  const pnls = rows.map((r) => r.pnl);
  const winsArr = pnls.filter((p) => p > 0), lossArr = pnls.filter((p) => p < 0);
  const grossProfit = winsArr.reduce((s, p) => s + p, 0), grossLoss = -lossArr.reduce((s, p) => s + p, 0);
  const net = pnls.reduce((s, p) => s + p, 0);
  const rs = rows.filter((r) => r.risk > 0).map((r) => r.pnl / r.risk);
  const ddUsd = maxDrawdown(pnls);
  const s = sd(pnls);
  const downside = lossArr.length ? Math.sqrt(lossArr.reduce((acc, p) => acc + p * p, 0) / lossArr.length) : null;
  let run = 0, maxWins = 0, maxLosses = 0;
  for (const p of pnls) {
    if (p > 0) run = run > 0 ? run + 1 : 1; else if (p < 0) run = run < 0 ? run - 1 : -1; else run = 0;
    maxWins = Math.max(maxWins, run); maxLosses = Math.max(maxLosses, -run);
  }
  const mfes = rows.map((r) => r.mfeR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const maes = rows.map((r) => r.maeR).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const firstAt = rows[0].at, lastAt = rows[rows.length - 1].at;
  return {
    n: rows.length, wins: winsArr.length, losses: lossArr.length, hitRate: winsArr.length / rows.length,
    net, grossProfit, grossLoss, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownUsd: ddUsd, maxDrawdownPct: basisUsd > 0 ? (ddUsd / basisUsd) * 100 : 0,
    sharpe: s != null && s > 0 ? (mean(pnls) as number) / s : null,
    sortino: downside != null && downside > 0 ? (mean(pnls) as number) / downside : null,
    avgR: mean(rs), expectancyUsd: net / rows.length, expectancyR: mean(rs), tStat: tStatOf(rs),
    avgWin: mean(winsArr), avgLoss: mean(lossArr), largestWin: winsArr.length ? Math.max(...winsArr) : 0, largestLoss: lossArr.length ? Math.min(...lossArr) : 0,
    avgMfeR: mean(mfes), avgMaeR: mean(maes),
    streak: { maxWins, maxLosses, current: run },
    spanDays: Math.max(0, (Date.parse(lastAt) - Date.parse(firstAt)) / 86_400_000), firstAt, lastAt,
  };
}
