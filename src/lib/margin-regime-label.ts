// REGIME LABEL (Sep 15 2026) — the operating spec's nine market-state words, computed per coin
// from the features the scan already holds (barFeatures on the 1d and 4h series). A STAMP on
// every paper row (regime_label) and a line in the desk brief — NOT a gate: the only regime
// filter this desk has tested (selective-btc) lost at t=−6, so a label earns a rule only after
// the byRegime cut of the record says it ranks.
//
// Precedence (first match wins):
//   panic                 1d volatility ≥3× its 30-bar norm AND the day's move ≥8% either way
//   breakout              4h volatility expanding (≥1.8× norm) with price through its 20-bar range
//   low-vol compression   4h volatility ≤0.55× norm (the coil the breakout detector waits on)
//   high-vol chop         4h volatility ≥1.5× norm with no daily direction
//   strong bull / bear    1d and 4h both trending the same way (tfDirection: above/below the
//                         20-bar mean AND the close 20 bars ago)
//   weak bull / bear      1d trending, 4h not agreeing
//   range                 1d flat
//   unknown               features missing
import type { TfFeatures } from "@/lib/margin-scanner";
import { tfDirection } from "@/lib/margin-mtf";

export type RegimeLabel = "strong bull" | "weak bull" | "strong bear" | "weak bear" | "range" | "high-vol chop" | "low-vol compression" | "breakout" | "panic" | "unknown";
export const REGIME_LABELS: RegimeLabel[] = ["strong bull", "weak bull", "strong bear", "weak bear", "range", "high-vol chop", "low-vol compression", "breakout", "panic", "unknown"];

export const PANIC_VOL_RATIO = 3;
export const PANIC_MOVE = 0.08;
export const EXPANSION_RATIO = 1.8;
export const COMPRESSION_RATIO = 0.55;
export const CHOP_RATIO = 1.5;

const fin = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

export function regimeLabel(d1: TfFeatures | null | undefined, h4: TfFeatures | null | undefined): RegimeLabel {
  if (!d1 && !h4) return "unknown";
  if (d1 && fin(d1.atrRatio30) && fin(d1.ret1) && d1.atrRatio30 >= PANIC_VOL_RATIO && Math.abs(d1.ret1) >= PANIC_MOVE) return "panic";
  if (h4 && fin(h4.atrRatio30) && fin(h4.close)) {
    const through = (fin(h4.hh20) && h4.close > h4.hh20) || (fin(h4.ll20) && h4.close < h4.ll20);
    if (h4.atrRatio30 >= EXPANSION_RATIO && through) return "breakout";
    if (h4.atrRatio30 <= COMPRESSION_RATIO) return "low-vol compression";
  }
  const dd = tfDirection(d1);
  const dh = tfDirection(h4);
  if (h4 && fin(h4.atrRatio30) && h4.atrRatio30 >= CHOP_RATIO && dd === "flat") return "high-vol chop";
  if (dd === "up") return dh === "up" ? "strong bull" : "weak bull";
  if (dd === "down") return dh === "down" ? "strong bear" : "weak bear";
  if (!d1) return "unknown";
  return "range";
}

/** From scanUniverse()'s features map. */
export function regimeLabelFor(features: Record<string, TfFeatures>, coin: string): RegimeLabel {
  return regimeLabel(features[`${coin}:1d`], features[`${coin}:4h`]);
}
