// Shared bar arithmetic for the edge-factory candidates. Every helper is a pure function of the
// bar array and an index, so a candidate's `evaluate` stays stateless and replayable.
import type { EdgeCandidate, EdgeSignal, ResearchBar } from "./types";

export function trueRange(bars: readonly ResearchBar[], index: number): number {
  const bar = bars[index], prior = bars[index - 1];
  return prior ? Math.max(bar.h - bar.l, Math.abs(bar.h - prior.c), Math.abs(bar.l - prior.c)) : bar.h - bar.l;
}

export function atr(bars: readonly ResearchBar[], index: number, period: number): number {
  if (index < period) return 0;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) sum += trueRange(bars, i);
  return sum / period;
}

export function range(bars: readonly ResearchBar[], start: number, end: number): { high: number; low: number } {
  let high = -Infinity, low = Infinity;
  for (let i = start; i <= end; i++) { high = Math.max(high, bars[i].h); low = Math.min(low, bars[i].l); }
  return { high, low };
}

/** Simple moving average of closes over the `period` bars ending at `index` (inclusive). */
export function sma(bars: readonly ResearchBar[], index: number, period: number): number {
  if (index < period - 1) return 0;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) sum += bars[i].c;
  return sum / period;
}

export function averageVolume(bars: readonly ResearchBar[], start: number, end: number): number {
  let sum = 0;
  for (let i = start; i <= end; i++) sum += bars[i].v;
  return sum / Math.max(1, end - start + 1);
}

/** Every bar in [start, end] belongs to one contract — a candidate never reads across a roll. */
export function hasOneInstrument(bars: readonly ResearchBar[], start: number, end: number): boolean {
  if (start < 0 || end >= bars.length || start > end) return false;
  const instrumentId = bars[start].instrumentId;
  for (let index = start + 1; index <= end; index++) {
    if (bars[index].instrumentId !== instrumentId) return false;
  }
  return true;
}

export function signal(candidate: EdgeCandidate, direction: "long" | "short", stop: number, targetR: number, hold: number, rationale: string): EdgeSignal {
  return { edgeKey: candidate.key, version: candidate.version, direction, stopDistance: stop, targetDistance: stop * targetR, maxHoldBars: hold, rationale };
}

/** `2.5` → `25`, `0.7` → `07`: the parameter spelling the candidate keys have always used. */
export function keyNumber(value: number): string { return String(value).replace(".", ""); }
