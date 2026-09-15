import { atr, hasOneInstrument, keyNumber, range, signal } from "./indicators";
import { et } from "./session";
import type { EdgeCandidate } from "./types";

export { PROMPT_FAMILY_CANDIDATES } from "./prompt-families";
export {
  liquiditySweepReversal, maContinuation, orbContinuation, overnightRangeBreak, pdhPdlBreak,
  rangeExpansionMomentum, vwapDeviationMr, vwapReclaim,
} from "./prompt-families";

export function compressionBreakout(compressionRatio: number, targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `compression_breakout_c${keyNumber(compressionRatio)}_t${keyNumber(targetR)}`,
    version: "1.0.0",
    family: "compression_breakout",
    barMinutes: 5,
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

export function openingDrive(minimumDriveAtr: number, targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `opening_drive_d${keyNumber(minimumDriveAtr)}_t${keyNumber(targetR)}`,
    version: "1.0.0",
    family: "opening_drive",
    barMinutes: 5,
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
    key: `slow_trend_b${lookback}_t${keyNumber(targetR)}`,
    version: "1.0.0",
    family: "slow_trend",
    barMinutes: 60,
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
