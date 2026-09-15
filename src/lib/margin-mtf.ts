// MULTI-TIMEFRAME DIRECTION STAMP (Sep 15 2026). The prompts' "1D + 4H direction, 4H + 1H
// confirm" — as a STAMP on every paper row, never a gate. The only regime filter this desk
// has tested (selective-btc) is losing at t=−6, so alignment is measured first: the slice
// "byMtfAligned" on the paper page decides whether it ever becomes one.
//
// up   = close above its 20-bar mean AND above the close 20 bars ago
// down = both below
// flat = anything else, including a missing or under-sampled series
import type { TfFeatures } from "@/lib/margin-scanner";

export type TfDirection = "up" | "down" | "flat";
export interface MtfState { d1: TfDirection; h4: TfDirection; h1: TfDirection; aligned: "long" | "short" | null; text: string }

export function tfDirection(f: TfFeatures | undefined | null): TfDirection {
  if (!f || !Number.isFinite(f.close) || !Number.isFinite(f.sma20) || !Number.isFinite(f.prevClose20)) return "flat";
  if (f.close > f.sma20 && f.close > f.prevClose20) return "up";
  if (f.close < f.sma20 && f.close < f.prevClose20) return "down";
  return "flat";
}

const LETTER: Record<TfDirection, string> = { up: "U", down: "D", flat: "F" };

/** Direction on 1d / 4h / 1h for `coin`, read from scanUniverse()'s features map. */
export function mtfState(features: Record<string, TfFeatures>, coin: string): MtfState {
  const d1 = tfDirection(features[`${coin}:1d`]);
  const h4 = tfDirection(features[`${coin}:4h`]);
  const h1 = tfDirection(features[`${coin}:1h`]);
  const aligned = d1 === "up" && h4 === "up" && h1 === "up" ? "long"
    : d1 === "down" && h4 === "down" && h1 === "down" ? "short"
    : null;
  return { d1, h4, h1, aligned, text: `${LETTER[d1]}/${LETTER[h4]}/${LETTER[h1]}` };
}
