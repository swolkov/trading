import type { EdgeCandidate, EdgeSignal, ResearchBar } from "./types";

function trueRange(bars: readonly ResearchBar[], index: number): number {
  const bar = bars[index], prior = bars[index - 1];
  return prior ? Math.max(bar.h - bar.l, Math.abs(bar.h - prior.c), Math.abs(bar.l - prior.c)) : bar.h - bar.l;
}

function atr(bars: readonly ResearchBar[], index: number, period: number): number {
  if (index < period) return 0;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) sum += trueRange(bars, i);
  return sum / period;
}

function range(bars: readonly ResearchBar[], start: number, end: number): { high: number; low: number } {
  let high = -Infinity, low = Infinity;
  for (let i = start; i <= end; i++) { high = Math.max(high, bars[i].h); low = Math.min(low, bars[i].l); }
  return { high, low };
}

function hasOneInstrument(bars: readonly ResearchBar[], start: number, end: number): boolean {
  if (start < 0 || end >= bars.length || start > end) return false;
  const instrumentId = bars[start].instrumentId;
  for (let index = start + 1; index <= end; index++) {
    if (bars[index].instrumentId !== instrumentId) return false;
  }
  return true;
}

function signal(candidate: EdgeCandidate, direction: "long" | "short", stop: number, targetR: number, hold: number, rationale: string): EdgeSignal {
  return { edgeKey: candidate.key, version: candidate.version, direction, stopDistance: stop, targetDistance: stop * targetR, maxHoldBars: hold, rationale };
}

export function compressionBreakout(compressionRatio: number, targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `compression_breakout_c${String(compressionRatio).replace(".", "")}_t${String(targetR).replace(".", "")}`,
    version: "1.0.0",
    family: "compression_breakout",
    minimumHistory: 60,
    evaluate: (bars, index) => {
      const current = bars[index];
      if (!hasOneInstrument(bars, index - 60, index)) return null;
      const baselineAtr = atr(bars, index - 1, 48);
      if (baselineAtr <= 0) return null;
      const coil = range(bars, index - 12, index - 1);
      if (coil.high - coil.low > baselineAtr * compressionRatio * 4) return null;
      const breakout = range(bars, index - 20, index - 1);
      let avgVolume = 0;
      for (let i = index - 20; i < index; i++) avgVolume += bars[i].v;
      avgVolume /= 20;
      if (current.v < avgVolume * 1.2) return null;
      const stop = baselineAtr * 1.25;
      if (current.c > breakout.high) return signal(candidate, "long", stop, targetR, 36, "low-volatility coil broke upward on expanding volume");
      if (current.c < breakout.low) return signal(candidate, "short", stop, targetR, 36, "low-volatility coil broke downward on expanding volume");
      return null;
    },
  };
  return candidate;
}

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const etCache = new Map<number, { date: string; hour: number; minute: number }>();
function et(t: number) {
  const cached = etCache.get(t); if (cached) return cached;
  const parts: Record<string, string> = {};
  for (const part of etFormatter.formatToParts(t)) parts[part.type] = part.value;
  const value = { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
  etCache.set(t, value); return value;
}

export function openingDrive(minimumDriveAtr: number, targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `opening_drive_d${String(minimumDriveAtr).replace(".", "")}_t${String(targetR).replace(".", "")}`,
    version: "1.0.0",
    family: "opening_drive",
    minimumHistory: 400,
    evaluate: (bars, index) => {
      const stamp = et(bars[index].t);
      if (stamp.hour !== 9 || stamp.minute !== 55) return null;
      let openIndex = index;
      while (openIndex > index - 12) {
        const p = et(bars[openIndex].t);
        if (p.date === stamp.date && p.hour === 9 && p.minute === 30) break;
        openIndex--;
      }
      if (openIndex <= index - 12 || bars[openIndex].instrumentId !== bars[index].instrumentId) return null;
      let priorCloseIndex = openIndex - 1;
      while (priorCloseIndex > 0) {
        const priorStamp = et(bars[priorCloseIndex].t);
        if (priorStamp.date !== stamp.date && priorStamp.hour === 15 && priorStamp.minute === 55) break;
        priorCloseIndex--;
      }
      if (priorCloseIndex < 1 || !hasOneInstrument(bars, Math.min(priorCloseIndex, openIndex - 79), index)) return null;
      const a = atr(bars, openIndex - 1, 78);
      if (a <= 0) return null;
      const drive = bars[index].c - bars[openIndex].o;
      const gap = bars[openIndex].o - bars[priorCloseIndex].c;
      if (Math.abs(drive) < a * minimumDriveAtr || Math.sign(drive) !== Math.sign(gap) || gap === 0) return null;
      return signal(candidate, drive > 0 ? "long" : "short", a * 1.2, targetR, 72, "cash-open drive aligned with overnight inventory gap");
    },
  };
  return candidate;
}

export function slowTrendBreakout(lookback: number, targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `slow_trend_b${lookback}_t${String(targetR).replace(".", "")}`,
    version: "1.0.0",
    family: "slow_trend",
    minimumHistory: Math.max(lookback + 30, 100),
    evaluate: (bars, index) => {
      if (!hasOneInstrument(bars, index - lookback, index)) return null;
      const channel = range(bars, index - lookback, index - 1);
      const a = atr(bars, index - 1, 20);
      if (a <= 0) return null;
      if (bars[index].c > channel.high) return signal(candidate, "long", a * 2, targetR, 40, `${lookback}-bar time-series breakout`);
      if (bars[index].c < channel.low) return signal(candidate, "short", a * 2, targetR, 40, `${lookback}-bar time-series breakout`);
      return null;
    },
  };
  return candidate;
}

export const FIVE_MINUTE_CANDIDATES: EdgeCandidate[] = [
  compressionBreakout(0.7, 2.5), compressionBreakout(0.9, 3),
  openingDrive(0.35, 2.5), openingDrive(0.5, 3),
];

export const HOURLY_CANDIDATES: EdgeCandidate[] = [
  slowTrendBreakout(55, 2.5),
  ...[80, 100, 120].flatMap((lookback) =>
    [2.5, 3, 3.5].map((targetR) => slowTrendBreakout(lookback, targetR)),
  ),
];
