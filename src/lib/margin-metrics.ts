// LEADERBOARD METRICS — the pure arithmetic behind the multi-strategy leaderboard (C1, Sep 15
// 2026). One function turns a sleeve's resolved rows into the numbers the operating spec asks
// for (expectancy after costs, profit factor, Sharpe, Sortino, max drawdown, R-multiples,
// MFE/MAE) plus the rolling-window decay read that C3's REDUCE rule and the promotion gate
// consume. Generic on purpose: the futures desk's review (E6) feeds it journal rows.
//
// Pure: no I/O, no prisma, no config. Rows arrive in RESOLVE order (the loader sorts them);
// every path statistic (drawdown, streaks, rolling windows) depends on that order.
//
// ⚠️ SHARPE ON OVERLAPPING CRYPTO TRADES IS INFLATED. Annualising mean/sd by √(trades per
// year) treats each trade as an independent draw; a sleeve holding three correlated alts at
// once has fewer independent draws than trades. Sharpe and Sortino here are RANKING numbers
// for the leaderboard, never a gate — the gate reads t, net, PF, drawdown and days.

export interface SleeveRow {
  id: number;
  source: string;
  side: string;                 // 'buy' | 'sell'
  time: string;                 // entry (ISO)
  resolvedAt: string;           // ISO
  entry: number;
  exit: number | null;
  pnl: number;                  // paper-sized net $ (fees inside)
  livePnl: number;              // the same trade at the LIVE risk budget (LIVE_RESCALE_SQL)
  fees: number;                 // fee + rollover $ at paper size
  notional: number;
  riskUsd: number;              // notional × stop fraction — one R in dollars, at paper size
  peak: number | null;          // best favourable price reached
  trough: number | null;        // worst adverse price reached — null until shadow_trough is filled (A4)
  oneR: number;                 // one R in price units
  reason: string | null;
  conviction: string | null;
}

export type MetricSeries = "live" | "paper";

export interface RBucket { bucket: string; n: number }

export interface SleeveMetrics {
  series: MetricSeries;
  n: number;
  net: number;
  expectancy: number | null;        // net ÷ n = EV per trade AFTER costs
  grossExpectancy: number | null;   // before fees
  feeShare: number | null;          // fees ÷ |gross| — the share of the raw edge fees take
  hitRate: number | null;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;      // gross wins ÷ gross losses; Infinity with no losses (computeMarginScoreboard's convention)
  tStat: number | null;             // mean × √n ÷ sd
  sharpe: number | null;            // mean ÷ sd × √(trades/yr) — RANKING ONLY, see the header
  sortino: number | null;           // mean ÷ downside deviation × √(trades/yr) — ranking only
  tradesPerYear: number | null;
  spanDays: number;                 // first entry → last resolution
  maxDD: number;                    // deepest peak-to-trough fall of cumulative P&L, in $
  maxDDPct: number | null;          // ÷ refEquity
  maxDDTrades: number;              // trades from the peak to the trough
  longestLossStreak: number;
  avgR: number | null;              // R = pnl ÷ riskUsd, FEE-INCLUSIVE: a clean stop-out reads ≈ −1.05R, not −1R
  medianR: number | null;
  rN: number;                       // rows with a usable riskUsd
  rDist: RBucket[];                 // sums to n (rows without a usable R land in "no R")
  mfeR: number | null;              // mean best excursion in R
  mfeN: number;
  maeR: number | null;              // mean worst excursion in R (≤ 0); null until troughs exist
  maeN: number;
}

export interface MetricsOptions { series?: MetricSeries; refEquity?: number | null }

export const R_BUCKETS = ["≤ −1R", "−1R..0", "0..+1R", "+1R..+2R", "+2R..+3R", "> +3R", "no R"] as const;

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sampleSd = (a: number[]) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** The series' $ per row: paper P&L as scored, or the same trade re-priced at the live budget. */
function seriesPnl(r: SleeveRow, series: MetricSeries): number {
  return series === "live" ? r.livePnl : r.pnl;
}
/** Fees at the series' size. Fees scale with notional exactly as P&L does (they are inside it). */
function seriesFees(r: SleeveRow, series: MetricSeries): number {
  if (series === "paper" || !fin(r.pnl) || r.pnl === 0) return fin(r.fees) ? r.fees : 0;
  return (fin(r.fees) ? r.fees : 0) * (r.livePnl / r.pnl);
}

/**
 * Deepest peak-to-trough fall of the cumulative sum, in the order given, and how many
 * steps it took from the peak to the trough. A series that never falls has dd 0 / 0 trades.
 */
export function maxDrawdown(pnls: number[]): { dd: number; trades: number } {
  let cum = 0, peak = 0, peakIdx = -1, dd = 0, trades = 0;
  for (let i = 0; i < pnls.length; i++) {
    cum += fin(pnls[i]) ? pnls[i] : 0;
    if (cum > peak) { peak = cum; peakIdx = i; continue; }
    const fall = peak - cum;
    if (fall > dd) { dd = fall; trades = i - peakIdx; }
  }
  return { dd, trades };
}

/** Longest run of consecutive non-positive results. */
export function longestLossStreak(pnls: number[]): number {
  let best = 0, cur = 0;
  for (const p of pnls) {
    if (fin(p) && p > 0) { cur = 0; continue; }
    cur++;
    if (cur > best) best = cur;
  }
  return best;
}

/**
 * Welch's t for mean(a) − mean(b) with unequal variances. null when either sample has fewer
 * than two rows or both have zero variance. Negative = a is worse than b.
 */
export function welchT(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const va = sampleSd(a) ** 2, vb = sampleSd(b) ** 2;
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!(se > 0) || !Number.isFinite(se)) return null;
  return (mean(a) - mean(b)) / se;
}

/** R-multiple of a row, fee-inclusive (pnl ÷ riskUsd at the same size); null without a usable risk. */
export function rMultiple(r: SleeveRow): number | null {
  if (!fin(r.riskUsd) || !(r.riskUsd > 0) || !fin(r.pnl)) return null;
  return r.pnl / r.riskUsd;
}
function bucketOf(R: number | null): (typeof R_BUCKETS)[number] {
  if (R == null) return "no R";
  if (R <= -1) return "≤ −1R";
  if (R < 0) return "−1R..0";
  if (R < 1) return "0..+1R";
  if (R < 2) return "+1R..+2R";
  if (R < 3) return "+2R..+3R";
  return "> +3R";
}

const MS_DAY = 86_400_000;
export const SHARPE_MIN_SPAN_DAYS = 7;

export function sleeveMetrics(rows: SleeveRow[], opts: MetricsOptions = {}): SleeveMetrics {
  const series: MetricSeries = opts.series ?? "live";
  const refEquity = fin(opts.refEquity) && (opts.refEquity as number) > 0 ? (opts.refEquity as number) : null;
  const pnls = rows.map((r) => (fin(seriesPnl(r, series)) ? seriesPnl(r, series) : 0));
  const n = rows.length;
  const net = pnls.reduce((s, x) => s + x, 0);
  const fees = rows.reduce((s, r) => s + seriesFees(r, series), 0);
  const gross = net + fees;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const grossWin = wins.reduce((s, x) => s + x, 0);
  const grossLoss = -losses.reduce((s, x) => s + x, 0);
  const sd = sampleSd(pnls);
  const m = mean(pnls);

  // Calendar span: first entry → last resolution. Trades per year annualises the per-trade
  // mean/sd; below a week the annualisation is meaningless noise, so Sharpe/Sortino stay null.
  const entryMs = rows.map((r) => Date.parse(r.time)).filter(Number.isFinite);
  const resolveMs = rows.map((r) => Date.parse(r.resolvedAt)).filter(Number.isFinite);
  const spanDays = entryMs.length && resolveMs.length ? Math.max(0, (Math.max(...resolveMs) - Math.min(...entryMs)) / MS_DAY) : 0;
  const tradesPerYear = n >= 2 && spanDays >= SHARPE_MIN_SPAN_DAYS ? (n * 365.25) / spanDays : null;
  const sharpe = tradesPerYear != null && fin(sd) && sd > 0 ? (m / sd) * Math.sqrt(tradesPerYear) : null;
  const downside = n >= 2 ? Math.sqrt(pnls.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / n) : NaN;
  const sortino = tradesPerYear != null && fin(downside) && downside > 0 ? (m / downside) * Math.sqrt(tradesPerYear) : null;

  const { dd, trades: ddTrades } = maxDrawdown(pnls);
  const Rs = rows.map(rMultiple);
  const rValid = Rs.filter((x): x is number => x != null);
  const dist = new Map<string, number>(R_BUCKETS.map((b) => [b, 0]));
  for (const R of Rs) dist.set(bucketOf(R), (dist.get(bucketOf(R)) ?? 0) + 1);

  const mfe: number[] = [], mae: number[] = [];
  for (const r of rows) {
    if (!fin(r.oneR) || !(r.oneR > 0) || !fin(r.entry)) continue;
    const dir = r.side === "sell" ? -1 : 1;
    if (fin(r.peak)) mfe.push((dir * (r.peak - r.entry)) / r.oneR);
    if (fin(r.trough)) mae.push((dir * (r.trough - r.entry)) / r.oneR);
  }

  return {
    series, n, net,
    expectancy: n > 0 ? net / n : null,
    grossExpectancy: n > 0 ? gross / n : null,
    feeShare: gross !== 0 ? fees / Math.abs(gross) : null,
    hitRate: n > 0 ? wins.length / n : null,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    tStat: n > 1 && fin(sd) && sd > 0 ? (m * Math.sqrt(n)) / sd : null,
    sharpe, sortino, tradesPerYear, spanDays,
    maxDD: dd,
    maxDDPct: refEquity != null ? dd / refEquity : null,
    maxDDTrades: ddTrades,
    longestLossStreak: longestLossStreak(pnls),
    avgR: rValid.length ? mean(rValid) : null,
    medianR: rValid.length ? median(rValid) : null,
    rN: rValid.length,
    rDist: R_BUCKETS.map((b) => ({ bucket: b, n: dist.get(b) ?? 0 })),
    mfeR: mfe.length ? mean(mfe) : null,
    mfeN: mfe.length,
    maeR: mae.length ? mean(mae) : null,
    maeN: mae.length,
  };
}

// ── STRATEGY DECAY — the rolling read (C3) ────────────────────────────────────────────────
// Is the LAST window of trades a different process from the ones before it? Welch's t on the
// live-priced P&L of the last `window` rows against every row before them. A significant fall
// (t ≤ −2) is DECAYING; a soft one (negative expectancy or PF < 1 in the window while the full
// record is positive) is cooling. Nothing is read below `window` rows, and nothing is read
// against a baseline of fewer than ROLLING_MIN_PRIOR rows — a 30-trade sleeve compared with
// its own first 5 trades is noise dressed as a trend.

export type RollingState = "insufficient" | "stable" | "cooling" | "DECAYING";
export interface RollingVerdict {
  state: RollingState;
  window: number;
  last: SleeveMetrics;
  prior: SleeveMetrics | null;
  full: SleeveMetrics;
  welchT: number | null;
  note: string;
}
export const ROLLING_WINDOW = 30;
export const ROLLING_MIN_PRIOR = 15;
export const DECAY_WELCH_T = -2;

export function rollingVerdict(rows: SleeveRow[], window: number = ROLLING_WINDOW, opts: MetricsOptions = {}): RollingVerdict {
  const o: MetricsOptions = { series: opts.series ?? "live", refEquity: opts.refEquity ?? null };
  const full = sleeveMetrics(rows, o);
  if (rows.length < window) {
    return { state: "insufficient", window, last: full, prior: null, full, welchT: null, note: `${rows.length}/${window} resolved — no rolling read yet` };
  }
  const lastRows = rows.slice(rows.length - window);
  const priorRows = rows.slice(0, rows.length - window);
  const last = sleeveMetrics(lastRows, o);
  if (priorRows.length < ROLLING_MIN_PRIOR) {
    return { state: "stable", window, last, prior: null, full, welchT: null, note: `no baseline yet (${priorRows.length}/${ROLLING_MIN_PRIOR} trades before the window)` };
  }
  const prior = sleeveMetrics(priorRows, o);
  const series = o.series as MetricSeries;
  const t = welchT(lastRows.map((r) => seriesPnl(r, series)), priorRows.map((r) => seriesPnl(r, series)));
  const money = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(0)}`;
  const lastExp = last.expectancy ?? 0, priorExp = prior.expectancy ?? 0, fullExp = full.expectancy ?? 0;
  if (t != null && t <= DECAY_WELCH_T) {
    return { state: "DECAYING", window, last, prior, full, welchT: t, note: `last ${window}: ${money(lastExp)}/trade vs ${money(priorExp)}/trade before (Welch t=${t.toFixed(2)} ≤ ${DECAY_WELCH_T})` };
  }
  const pfLast = last.profitFactor, pfFull = full.profitFactor;
  const cooling = (lastExp < 0 && fullExp > 0) || (pfLast != null && pfLast < 1 && pfFull != null && pfFull >= 1.2);
  if (cooling) {
    return { state: "cooling", window, last, prior, full, welchT: t, note: `last ${window}: ${money(lastExp)}/trade, PF ${pfLast == null ? "—" : pfLast === Infinity ? "∞" : pfLast.toFixed(2)} vs full ${money(fullExp)}/trade, PF ${pfFull == null ? "—" : pfFull === Infinity ? "∞" : pfFull.toFixed(2)} (Welch t=${t?.toFixed(2) ?? "—"}, not significant)` };
  }
  return { state: "stable", window, last, prior, full, welchT: t, note: `last ${window}: ${money(lastExp)}/trade vs ${money(priorExp)}/trade before (Welch t=${t?.toFixed(2) ?? "—"})` };
}
