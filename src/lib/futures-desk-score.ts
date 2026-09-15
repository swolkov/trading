// FUTURES DESK — the regime engine and the 0–100 opportunity score (E7), pure.
//
// STAMP AND MEASURE, NOT A GATE. The regime label and the score are written on every signal row
// (refused ones included) so the weekly review can measure whether the score RANKS outcomes on this
// desk's own record. Nothing here sizes or refuses anything until `futures_desk_score_promoted` is
// "true" — which a person sets, from the desk action route, only on a green `scorePromotionVerdict`
// (≥ 30 resolved per bucket, the ≥ 80 bucket beating the < 70 bucket by mean R at Welch t ≥ 2). The
// crypto desk's own conviction score ranked BACKWARDS; a weighted score is not trusted until measured.
//
// Two clocks: the alert's context fields come from TradingView (delayed bar close); the regime comes
// from Yahoo daily bars fetched by the guardian once per ET day. The drift is stamped, never acted on.
import type { EventMode } from "@/lib/event-calendar";
import type { AlertPayload } from "@/lib/futures-desk-rules";

// ---- regime: trend × volatility on daily bars ----------------------------------------------------------
export interface DailyBar { h: number; l: number; c: number }
export const SMA_FAST = 50;
export const SMA_SLOW = 200;
export const ATR_LEN = 14;
/** ATR percentile window (daily bars, ≈ one trading year). */
export const VOL_WINDOW = 250;
/** ATR14 percentile below this = lowvol; at or above `VOL_HIGH_FROM` = highvol; between = midvol. */
export const VOL_LOW_BELOW = 1 / 3;
export const VOL_HIGH_FROM = 2 / 3;
/** Fewer daily bars than this (the slow SMA) → "unknown". */
export const MIN_BARS_FOR_REGIME = SMA_SLOW;

export type TrendLabel = "uptrend" | "range" | "downtrend";
export type VolLabel = "lowvol" | "midvol" | "highvol";
export type RegimeLabel = `${TrendLabel}-${VolLabel}` | "unknown";
export const REGIME_LABELS: readonly RegimeLabel[] = [
  "uptrend-lowvol", "uptrend-midvol", "uptrend-highvol", "range-lowvol", "range-midvol", "range-highvol", "downtrend-lowvol", "downtrend-midvol", "downtrend-highvol",
];

export interface RegimeRead {
  label: RegimeLabel; trend: TrendLabel | null; vol: VolLabel | null;
  close: number | null; sma50: number | null; sma200: number | null; atr: number | null;
  /** Where today's ATR14 sits among the last 250 (0 = the quietest day of the year, 1 = the wildest). */
  atrPct: number | null;
}
const UNKNOWN: RegimeRead = { label: "unknown", trend: null, vol: null, close: null, sma50: null, sma200: null, atr: null, atrPct: null };

const sma = (xs: number[], n: number): number => xs.slice(-n).reduce((s, v) => s + v, 0) / n;

/** Wilder ATR series: the first value is the mean of the first `len` true ranges, then smoothed. One
 *  value per bar from index `len` on (bars before that have no ATR). */
export function atrSeries(bars: DailyBar[], len = ATR_LEN): number[] {
  if (bars.length <= len) return [];
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  const out: number[] = [];
  let atr = tr.slice(0, len).reduce((s, v) => s + v, 0) / len;
  out.push(atr);
  for (let i = len; i < tr.length; i++) { atr = (atr * (len - 1) + tr[i]) / len; out.push(atr); }
  return out;
}

/** Fraction of the OTHER values in the window strictly below the last one (0 … 1); 0.5 with fewer than two values. */
export function percentileOfLast(values: number[]): number {
  if (values.length < 2) return 0.5;
  const last = values[values.length - 1];
  const others = values.slice(0, -1);
  return others.filter((v) => v < last).length / others.length;
}

export function trendLabelOf(close: number, sma50: number, sma200: number): TrendLabel {
  if (close > sma50 && sma50 > sma200) return "uptrend";
  if (close < sma50 && sma50 < sma200) return "downtrend";
  return "range";
}
export function volLabelOf(atrPct: number): VolLabel {
  if (atrPct < VOL_LOW_BELOW) return "lowvol";
  if (atrPct >= VOL_HIGH_FROM) return "highvol";
  return "midvol";
}

/** The regime of a daily series (oldest first). Bars with a non-finite or non-positive h/l/c are dropped;
 *  fewer than 200 remaining → "unknown". Never throws. */
export function regimeOf(input: DailyBar[]): RegimeRead {
  const bars = (Array.isArray(input) ? input : []).filter((b) => b && [b.h, b.l, b.c].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0));
  if (bars.length < MIN_BARS_FOR_REGIME) return { ...UNKNOWN };
  const closes = bars.map((b) => b.c);
  const close = closes[closes.length - 1];
  const sma50 = sma(closes, SMA_FAST), sma200 = sma(closes, SMA_SLOW);
  const atrs = atrSeries(bars);
  if (!atrs.length) return { ...UNKNOWN };
  const atr = atrs[atrs.length - 1];
  const atrPct = percentileOfLast(atrs.slice(-VOL_WINDOW));
  const trend = trendLabelOf(close, sma50, sma200), vol = volLabelOf(atrPct);
  return { label: `${trend}-${vol}`, trend, vol, close, sma50, sma200, atr, atrPct };
}
export function regimeLabel(bars: DailyBar[]): RegimeLabel { return regimeOf(bars).label; }
export function trendOf(label: RegimeLabel | null | undefined): TrendLabel | null {
  if (!label || label === "unknown") return null;
  return label.split("-")[0] as TrendLabel;
}

// ---- the snapshot the guardian writes (`futures_desk_regime`) ---------------------------------------------
export const REGIME_KEY = "futures_desk_regime";
/** Yahoo's continuous front-month symbols, one per desk root. */
export const REGIME_ROOTS: readonly string[] = ["ES", "NQ", "YM", "GC", "SI", "HG", "RTY"];
export interface RegimeRootInfo { label: RegimeLabel; close: number | null; sma50: number | null; sma200: number | null; atr: number | null; atrPct: number | null; at: string }
export interface RegimeSnapshot { at: string; byRoot: Record<string, RegimeRootInfo> }

/** Tolerant reader: bad JSON or a wrong shape → null; a root entry with an unrecognised label is dropped. */
export function parseRegime(raw: string | null | undefined): RegimeSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || typeof v.at !== "string" || !v.byRoot || typeof v.byRoot !== "object") return null;
    const byRoot: Record<string, RegimeRootInfo> = {};
    const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
    for (const [root, info] of Object.entries(v.byRoot as Record<string, Record<string, unknown>>)) {
      if (!info || typeof info !== "object") continue;
      const label = String(info.label);
      if (label !== "unknown" && !REGIME_LABELS.includes(label as RegimeLabel)) continue;
      byRoot[root] = { label: label as RegimeLabel, close: num(info.close), sma50: num(info.sma50), sma200: num(info.sma200), atr: num(info.atr), atrPct: num(info.atrPct), at: typeof info.at === "string" ? info.at : v.at };
    }
    return { at: v.at, byRoot };
  } catch { return null; }
}
/** The label to stamp for a root: the snapshot's, or "unknown" when there is none. */
export function regimeLabelFor(snap: RegimeSnapshot | null, root: string): RegimeLabel {
  return snap?.byRoot[root]?.label ?? "unknown";
}
/** The journal stamp: a real label, or null — "unknown" is not a regime the promotion gate should count. */
export function regimeStamp(snap: RegimeSnapshot | null, root: string): string | null {
  const l = regimeLabelFor(snap, root);
  return l === "unknown" ? null : l;
}

// ---- the 0–100 opportunity score ----------------------------------------------------------------------
/** The eight parts and their caps (sum 100). */
export const SCORE_PARTS = { structure: 20, trend: 10, volume: 10, liquidity: 10, catalyst: 10, rr: 15, regimeFit: 10, expectancy: 15 } as const;
export type ScorePart = keyof typeof SCORE_PARTS;
/** Static liquidity by root; an unmapped root scores as the thinnest. */
export const LIQUIDITY_SCORE: Record<string, number> = { ES: 10, NQ: 10, YM: 8, GC: 8, SI: 6, HG: 6, RTY: 6 };
/** Expected move for the R:R part = k × ATR — an ASSUMPTION (two ATRs over the hold), stated here and
 *  measured against MFE by the weekly review; it is not a target the desk trades to. */
export const EXPECTED_MOVE_ATR_K = 2;
/** An edge × root or edge × regime cell needs this many resolved trades before its statistic scores. */
export const SCORE_MIN_CELL_N = 10;
/** Neutral values when a part cannot be measured (never NaN). */
export const NEUTRAL = { structureProx: 5, structureMtf: 2.5, trend: 5, volume: 5, catalyst: 5, rr: 7.5, regimeFit: 5, expectancy: 7 } as const;

export interface CellStats { n: number; avgR: number | null }
export interface OpportunityScore { score: number; components: Record<ScorePart, number>; missing: string[] }
type ScoreAlert = Pick<AlertPayload, "side" | "root" | "price" | "stop"> & Partial<Pick<AlertPayload, "atr" | "volRatio" | "dist20h" | "d1Up" | "h4Up">>;

/** Linear map of x from [x0, x1] onto [0, max], clamped. */
const lin = (x: number, x0: number, x1: number, max: number): number => Math.max(0, Math.min(1, (x - x0) / (x1 - x0))) * max;
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const r1 = (x: number): number => Math.round(x * 10) / 10;

/** The score of one alert. Every part is capped at its weight, missing inputs score their neutral value
 *  and are listed in `missing`, and the total is an integer 0–100. Pure: the same inputs always score
 *  the same. `stats` are the desk's own edge × root and edge × regime cells (from the leaderboard) — a
 *  cell under 10 resolved trades scores neutral. */
export function futuresOpportunityScore(a: ScoreAlert, regime: RegimeLabel | null, policy: EventMode | null, stats: { edgeRoot: CellStats | null; edgeRegime: CellStats | null }): OpportunityScore {
  const missing: string[] = [];
  const long = a.side === "long";
  // Structure 20 = proximity to the 20-bar high (10) + multi-timeframe alignment (5 + 5).
  let prox: number;
  if (fin(a.dist20h)) { const v = lin(a.dist20h, -0.05, 0, 10); prox = long ? v : 10 - v; } else { prox = NEUTRAL.structureProx; missing.push("dist20h"); }
  const mtf = (["d1Up", "h4Up"] as const).reduce((s, k) => { const v = a[k]; if (typeof v !== "boolean") { missing.push(k); return s + NEUTRAL.structureMtf; } return s + (v === long ? 5 : 0); }, 0);
  const structure = Math.min(SCORE_PARTS.structure, prox + mtf);
  // Trend 10 from the regime's trend half, mirrored for a short.
  const t = trendOf(regime);
  let trend: number;
  if (!t) { trend = NEUTRAL.trend; missing.push("regime"); } else { const up = t === "uptrend" ? 10 : t === "range" ? 5 : 0; trend = long ? up : 10 - up; }
  // Volume 10: 0.5× average → 0, 1.5× → 10.
  let volume: number;
  if (fin(a.volRatio)) volume = lin(a.volRatio, 0.5, 1.5, 10); else { volume = NEUTRAL.volume; missing.push("volRatio"); }
  const liquidity = LIQUIDITY_SCORE[a.root] ?? 6;
  let catalyst: number;
  if (policy === "normal") catalyst = 10; else if (policy === "reduced") catalyst = 5; else if (policy === "paused") catalyst = 0; else { catalyst = NEUTRAL.catalyst; missing.push("eventMode"); }
  // R:R 15: expected move (k × ATR) ÷ stop distance; 0.5 → 0, 3 → 15.
  let rr: number;
  const stopPts = fin(a.stop) && fin(a.price) ? Math.abs(a.price - a.stop) : 0;
  if (fin(a.atr) && a.atr > 0 && stopPts > 0) rr = lin((EXPECTED_MOVE_ATR_K * a.atr) / stopPts, 0.5, 3, 15);
  else { rr = NEUTRAL.rr; missing.push(fin(a.atr) && a.atr > 0 ? "stop" : "atr"); }
  // Regime fit 10 and historical expectancy 15 from the desk's own cells: avg R −0.2 → 0, +0.4 → cap.
  const cell = (c: CellStats | null, cap: number, neutral: number, name: string): number => {
    if (c && c.n >= SCORE_MIN_CELL_N && fin(c.avgR)) return lin(c.avgR, -0.2, 0.4, cap);
    missing.push(name); return neutral;
  };
  const regimeFit = cell(stats.edgeRegime, SCORE_PARTS.regimeFit, NEUTRAL.regimeFit, "regimeFit (<10 trades in edge×regime)");
  const expectancy = cell(stats.edgeRoot, SCORE_PARTS.expectancy, NEUTRAL.expectancy, "expectancy (<10 trades in edge×root)");
  const components: Record<ScorePart, number> = { structure: r1(structure), trend: r1(trend), volume: r1(volume), liquidity: r1(liquidity), catalyst: r1(catalyst), rr: r1(rr), regimeFit: r1(regimeFit), expectancy: r1(expectancy) };
  const total = Object.values(components).reduce((s, v) => s + v, 0);
  return { score: Math.max(0, Math.min(100, Math.round(total))), components, missing };
}

// ---- the signal row's JSON: Pine context + the score, in one column ---------------------------------------
const PINE_KEYS = ["atr", "rsi", "volRatio", "dist20h", "d1Up", "h4Up"] as const;
/** Only the Pine v2 context fields, whatever else the column holds — the queue replay spreads this
 *  into the alert, so the score object must never ride along. */
export function pineContextOf(raw: string | null | undefined): Partial<AlertPayload> {
  if (!raw) return {};
  let v: Record<string, unknown>;
  try { v = JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  if (!v || typeof v !== "object") return {};
  const out: Partial<AlertPayload> = {};
  for (const k of PINE_KEYS) {
    const x = v[k];
    if (k === "d1Up" || k === "h4Up") { if (typeof x === "boolean") out[k] = x; }
    else if (fin(x)) out[k] = x;
  }
  return out;
}
/** `{ …pine context, opportunity: { score, components, missing } }` — the column's full content. */
export function scoreJsonOf(a: Partial<AlertPayload>, s: OpportunityScore | null): string {
  const ctx: Record<string, unknown> = {};
  for (const k of PINE_KEYS) if (a[k] != null) ctx[k] = a[k];
  if (s) ctx.opportunity = s;
  return JSON.stringify(ctx);
}

// ---- score buckets and the promotion verdict (weekly review) -----------------------------------------------
export const SCORE_STRONG_FROM = 80;
export const SCORE_MID_FROM = 70;
export const SCORE_BUCKET_MIN_N = 30;
export const SCORE_BUCKET_T = 2;
export interface ScoreBuckets { top: number[]; mid: number[]; bottom: number[]; unscored: number }
export interface BucketStats { label: string; n: number; meanR: number | null; pf: number | null }
export interface ScorePromotionVerdict { ok: boolean; reasons: string[]; tStat: number | null; buckets: BucketStats[] }

/** R series per bucket (≥ 80 / 70–79 / < 70) from resolved rows; a row with no score or no R is counted, not bucketed. */
export function scoreBucketsOf(rows: { score: number | null | undefined; r: number | null | undefined }[]): ScoreBuckets {
  const b: ScoreBuckets = { top: [], mid: [], bottom: [], unscored: 0 };
  for (const row of rows) {
    if (!fin(row.score) || !fin(row.r)) { b.unscored++; continue; }
    (row.score >= SCORE_STRONG_FROM ? b.top : row.score >= SCORE_MID_FROM ? b.mid : b.bottom).push(row.r);
  }
  return b;
}
export function bucketStats(label: string, rs: number[]): BucketStats {
  const wins = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0), losses = rs.filter((r) => r < 0).reduce((s, r) => s - r, 0);
  return { label, n: rs.length, meanR: rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null, pf: losses > 0 ? wins / losses : rs.length && wins > 0 ? Infinity : null };
}
/** Welch's t between two series (unequal variances); null when either has < 2 values or both are constant. */
export function welchT(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const varOf = (xs: number[], m: number) => xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1);
  const ma = mean(a), mb = mean(b);
  const se = Math.sqrt(varOf(a, ma) / a.length + varOf(b, mb) / b.length);
  return se > 0 ? (ma - mb) / se : null;
}
/** Green only when every bucket has ≥ 30 resolved, the ≥ 80 bucket beats the < 70 bucket by mean R, and
 *  Welch t between them is ≥ 2. Every failing reason is listed. */
export function scorePromotionVerdict(b: ScoreBuckets): ScorePromotionVerdict {
  const top = bucketStats("≥ 80", b.top), mid = bucketStats("70–79", b.mid), bottom = bucketStats("< 70", b.bottom);
  const reasons: string[] = [];
  for (const s of [top, mid, bottom]) if (s.n < SCORE_BUCKET_MIN_N) reasons.push(`${s.label}: ${s.n} of ${SCORE_BUCKET_MIN_N} resolved`);
  const t = welchT(b.top, b.bottom);
  if (top.meanR != null && bottom.meanR != null && !(top.meanR > bottom.meanR)) reasons.push(`≥ 80 mean R ${top.meanR.toFixed(2)} does not beat < 70 mean R ${bottom.meanR.toFixed(2)}`);
  if (t == null || t < SCORE_BUCKET_T) reasons.push(`Welch t ${t == null ? "—" : t.toFixed(2)} is below ${SCORE_BUCKET_T}`);
  return { ok: reasons.length === 0, reasons, tStat: t, buckets: [top, mid, bottom] };
}

// ---- the promoted-only minimum score ------------------------------------------------------------------------
export const SCORE_PROMOTED_KEY = "futures_desk_score_promoted";
export const MIN_SCORE_KEY = "futures_desk_min_score";
/** `futures_desk_min_score` clamped 0–100; unreadable → 0 (no refusal — the conservative side for a key that only ever adds a refusal is "off"). */
export function parseMinScore(raw: string | null | undefined): number {
  const n = raw == null ? NaN : parseFloat(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}
/** Consulted ONLY when the score is promoted (`futures_desk_score_promoted` === "true") — until then the
 *  score is a stamp and this returns null whatever the key says. Promoted with a minimum: a score below it
 *  refuses `score 64 is below the desk minimum 70`; a MISSING score refuses too (the desk cannot show the
 *  entry met the bar). A minimum of 0 never refuses. */
export function minScoreRefusal(score: number | null | undefined, minScore: number, promoted: boolean): string | null {
  if (!promoted || !(minScore > 0)) return null;
  if (!fin(score)) return `score missing — the desk minimum is ${minScore}`;
  if (score < minScore) return `score ${score} is below the desk minimum ${minScore}`;
  return null;
}
