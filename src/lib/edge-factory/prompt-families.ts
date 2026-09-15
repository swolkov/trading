// THE TRADOVATE FUTURES PROMPT'S STRATEGY FAMILIES (E10) — pre-registered candidates.
//
// Every family here is declared in research/edge-factory-trials.json (hypothesis, markets, bar
// size, parameters, and the expectation stated BEFORE the run) and judged by the unchanged
// `validateCandidate` gate. Several are families this repo has already measured dead on the same
// 15-year archive (opening-range breakouts, intraday index mean-reversion, liquidity sweeps — see
// the ledger's `expectation` fields); they are re-run only because the ledger makes the re-test
// cheap and honest, not because anything new is expected of them.
//
// Bar sizes are deliberate: 5-minute only where the rule needs it (a 5-minute opening range, a
// session VWAP), 15-minute for the level breaks, 60-minute for the momentum and moving-average
// families — the Aug 23 timeframe study found sub-15-minute bars are a cost machine.
import { atr, averageVolume, hasOneInstrument, keyNumber, range, signal, sma } from "./indicators";
import { RTH_OPEN, barsToRthClose, et, overnightRange, priorRthRange, rthOpenIndex, sessionVwap } from "./session";
import type { EdgeCandidate } from "./types";

const ELEVEN_THIRTY = 11 * 60 + 30, TEN = 10 * 60, TWELVE = 12 * 60, FIFTEEN = 15 * 60, FIFTEEN_THIRTY = 15 * 60 + 30, FIFTEEN_FORTY_FIVE = 15 * 60 + 45;

/** First close beyond the opening range (5/15/30 minutes from 09:30 ET), before 11:30 ET, once per
 *  day. Stop = the range height (floored at 0.5×ATR20); exit at the target, the stop or 16:00 ET. */
export function orbContinuation(orMinutes: 5 | 15 | 30, targetR: number): EdgeCandidate {
  const orBars = orMinutes / 5;
  const candidate: EdgeCandidate = {
    key: `orb_continuation_or${orMinutes}_t${keyNumber(targetR)}`,
    version: "1.0.0",
    family: "orb_continuation",
    barMinutes: 5,
    minimumHistory: 400,
    evaluate: (bars, index) => {
      const stamp = et(bars[index].t);
      if (stamp.tod < RTH_OPEN + orMinutes || stamp.tod >= ELEVEN_THIRTY) return null;
      const open = rthOpenIndex(bars, index, 120);
      if (open < 0) return null;
      const orEnd = open + orBars - 1;
      if (index <= orEnd || et(bars[orEnd].t).tod !== RTH_OPEN + orMinutes - 5) return null;
      if (!hasOneInstrument(bars, index - 60, index)) return null;
      const a = atr(bars, index - 1, 20);
      if (a <= 0) return null;
      const or = range(bars, open, orEnd);
      for (let k = orEnd + 1; k < index; k++) if (bars[k].c > or.high || bars[k].c < or.low) return null;   // already broke today
      const stop = Math.max(or.high - or.low, a * 0.5);
      const hold = barsToRthClose(stamp.tod, 5);
      if (bars[index].c > or.high) return signal(candidate, "long", stop, targetR, hold, `${orMinutes}-minute opening range broke upward`);
      if (bars[index].c < or.low) return signal(candidate, "short", stop, targetR, hold, `${orMinutes}-minute opening range broke downward`);
      return null;
    },
  };
  return candidate;
}

/** After `belowBars` consecutive closes on one side of the session VWAP, the first close back
 *  across it — 10:00–15:00 ET. Stop 1.5×ATR20; exit at the target, the stop or 16:00 ET. */
export function vwapReclaim(belowBars: number, targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `vwap_reclaim_k${belowBars}_t${keyNumber(targetR)}`,
    version: "1.0.0",
    family: "vwap_reclaim",
    barMinutes: 5,
    minimumHistory: 400,
    evaluate: (bars, index) => {
      const stamp = et(bars[index].t);
      if (stamp.tod < TEN || stamp.tod >= FIFTEEN) return null;
      const open = rthOpenIndex(bars, index, 120);
      if (open < 0 || index - open < belowBars + 1) return null;
      if (!hasOneInstrument(bars, Math.min(open, index - 60), index)) return null;
      const a = atr(bars, index - 1, 20);
      if (a <= 0) return null;
      const now = sessionVwap(bars, open, index);
      if (!now) return null;
      let allBelow = true, allAbove = true;
      for (let j = index - belowBars; j < index; j++) {
        const v = sessionVwap(bars, open, j);
        if (!v) return null;
        if (bars[j].c >= v.vwap) allBelow = false;
        if (bars[j].c <= v.vwap) allAbove = false;
      }
      const hold = barsToRthClose(stamp.tod, 5);
      if (allBelow && bars[index].c > now.vwap) return signal(candidate, "long", a * 1.5, targetR, hold, `reclaimed the session VWAP after ${belowBars} closes below it`);
      if (allAbove && bars[index].c < now.vwap) return signal(candidate, "short", a * 1.5, targetR, hold, `lost the session VWAP after ${belowBars} closes above it`);
      return null;
    },
  };
  return candidate;
}

/** A close more than `z` volume-weighted standard deviations from the session VWAP is faded back
 *  toward it — 10:00–15:30 ET. Stop 1.5×ATR20; target = the distance back to VWAP (floored at half
 *  the stop); exit at the target, the stop or 16:00 ET. */
export function vwapDeviationMr(z: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `vwap_deviation_mr_z${keyNumber(z)}`,
    version: "1.0.0",
    family: "vwap_deviation_mr",
    barMinutes: 5,
    minimumHistory: 400,
    evaluate: (bars, index) => {
      const stamp = et(bars[index].t);
      if (stamp.tod < TEN || stamp.tod >= FIFTEEN_THIRTY) return null;
      const open = rthOpenIndex(bars, index, 120);
      if (open < 0) return null;
      if (!hasOneInstrument(bars, Math.min(open, index - 60), index)) return null;
      const a = atr(bars, index - 1, 20);
      if (a <= 0) return null;
      const v = sessionVwap(bars, open, index);
      if (!v || !(v.sigma > 0)) return null;
      const stop = a * 1.5;
      const distance = Math.abs(bars[index].c - v.vwap);
      const targetR = Math.max(distance, stop * 0.5) / stop;
      const hold = barsToRthClose(stamp.tod, 5);
      if (bars[index].c > v.vwap + z * v.sigma) return signal(candidate, "short", stop, targetR, hold, `close ${z}σ above the session VWAP — fade back to it`);
      if (bars[index].c < v.vwap - z * v.sigma) return signal(candidate, "long", stop, targetR, hold, `close ${z}σ below the session VWAP — fade back to it`);
      return null;
    },
  };
  return candidate;
}

/** The first RTH close of the day beyond the prior RTH day's high (long) or low (short), before
 *  15:45 ET. Stop 1.5×ATR20 (15-minute bars); exit at the target, the stop or 16:00 ET. */
export function pdhPdlBreak(targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `pdh_pdl_break_t${keyNumber(targetR)}`,
    version: "1.0.0",
    family: "pdh_pdl_break",
    barMinutes: 15,
    minimumHistory: 200,
    evaluate: (bars, index) => {
      const stamp = et(bars[index].t);
      if (stamp.tod < RTH_OPEN || stamp.tod >= FIFTEEN_FORTY_FIVE) return null;
      const open = rthOpenIndex(bars, index, 40);
      if (open < 0) return null;
      const prior = priorRthRange(bars, open, 160);
      if (!prior || !hasOneInstrument(bars, Math.min(prior.startIndex, index - 20), index)) return null;
      const a = atr(bars, index - 1, 20);
      if (a <= 0) return null;
      for (let k = open; k < index; k++) if (bars[k].c > prior.high || bars[k].c < prior.low) return null;   // first break only
      const hold = barsToRthClose(stamp.tod, 15);
      if (bars[index].c > prior.high) return signal(candidate, "long", a * 1.5, targetR, hold, "first close above the prior day's high");
      if (bars[index].c < prior.low) return signal(candidate, "short", a * 1.5, targetR, hold, "first close below the prior day's low");
      return null;
    },
  };
  return candidate;
}

/** The first RTH close beyond the overnight (18:00 → 09:30 ET) range, before 12:00 ET. Stop
 *  1.5×ATR20 (15-minute bars); exit at the target, the stop or 16:00 ET. */
export function overnightRangeBreak(targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `overnight_range_break_t${keyNumber(targetR)}`,
    version: "1.0.0",
    family: "overnight_range_break",
    barMinutes: 15,
    minimumHistory: 200,
    evaluate: (bars, index) => {
      const stamp = et(bars[index].t);
      if (stamp.tod < RTH_OPEN || stamp.tod >= TWELVE) return null;
      const open = rthOpenIndex(bars, index, 40);
      if (open < 0) return null;
      const overnight = overnightRange(bars, open, 80, 20);
      if (!overnight || !hasOneInstrument(bars, Math.min(overnight.startIndex, index - 20), index)) return null;
      const a = atr(bars, index - 1, 20);
      if (a <= 0) return null;
      for (let k = open; k < index; k++) if (bars[k].c > overnight.high || bars[k].c < overnight.low) return null;
      const hold = barsToRthClose(stamp.tod, 15);
      if (bars[index].c > overnight.high) return signal(candidate, "long", a * 1.5, targetR, hold, "first RTH close above the overnight high");
      if (bars[index].c < overnight.low) return signal(candidate, "short", a * 1.5, targetR, hold, "first RTH close below the overnight low");
      return null;
    },
  };
  return candidate;
}

/** A bar that trades through the prior `lookback`-bar high (low) and closes back inside it —
 *  the "sweep" reversal. Fade it: short after a swept high, long after a swept low, any session.
 *  Stop 1.5×ATR20, target 2R, 16 bars. */
export function liquiditySweepReversal(lookback: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `liquidity_sweep_reversal_b${lookback}`,
    version: "1.0.0",
    family: "liquidity_sweep_reversal",
    barMinutes: 15,
    minimumHistory: Math.max(lookback + 30, 100),
    evaluate: (bars, index) => {
      if (!hasOneInstrument(bars, index - lookback - 1, index)) return null;
      const a = atr(bars, index - 1, 20);
      if (a <= 0) return null;
      const prior = range(bars, index - lookback, index - 1);
      const bar = bars[index];
      if (bar.h > prior.high && bar.c < prior.high) return signal(candidate, "short", a * 1.5, 2, 16, `swept the ${lookback}-bar high and closed back below it`);
      if (bar.l < prior.low && bar.c > prior.low) return signal(candidate, "long", a * 1.5, 2, 16, `swept the ${lookback}-bar low and closed back above it`);
      return null;
    },
  };
  return candidate;
}

/** A 60-minute bar at least `k`×ATR20 tall, closing in its top (bottom) quarter on ≥ 1.2× average
 *  volume — continuation in the bar's direction. Stop 1.5×ATR20, 24 bars. */
export function rangeExpansionMomentum(k: number, targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `range_expansion_momentum_k${keyNumber(k)}_t${keyNumber(targetR)}`,
    version: "1.0.0",
    family: "range_expansion_momentum",
    barMinutes: 60,
    minimumHistory: 60,
    evaluate: (bars, index) => {
      if (!hasOneInstrument(bars, index - 40, index)) return null;
      const a = atr(bars, index - 1, 20);
      if (a <= 0) return null;
      const bar = bars[index];
      const height = bar.h - bar.l;
      if (height < k * a || bar.v < averageVolume(bars, index - 20, index - 1) * 1.2) return null;
      const location = (bar.c - bar.l) / height;
      if (location >= 0.75) return signal(candidate, "long", a * 1.5, targetR, 24, `${k}×ATR range expansion closing in its top quarter`);
      if (location <= 0.25) return signal(candidate, "short", a * 1.5, targetR, 24, `${k}×ATR range expansion closing in its bottom quarter`);
      return null;
    },
  };
  return candidate;
}

/** Trend by SMA50 vs SMA200 (and the close on the trend's side of SMA200); entry on the first close
 *  back across SMA20 after a pullback through it. Stop 2×ATR20, 40 bars, 60-minute bars. */
export function maContinuation(targetR: number): EdgeCandidate {
  const candidate: EdgeCandidate = {
    key: `ma_continuation_t${keyNumber(targetR)}`,
    version: "1.0.0",
    family: "ma_continuation",
    barMinutes: 60,
    minimumHistory: 230,
    evaluate: (bars, index) => {
      if (!hasOneInstrument(bars, index - 200, index)) return null;
      const a = atr(bars, index - 1, 20);
      if (a <= 0) return null;
      const fast = sma(bars, index, 20), fastPrior = sma(bars, index - 1, 20), mid = sma(bars, index, 50), slow = sma(bars, index, 200);
      const close = bars[index].c, prior = bars[index - 1].c;
      if (close > slow && mid > slow && prior < fastPrior && close > fast) return signal(candidate, "long", a * 2, targetR, 40, "uptrend pullback closed back above SMA20");
      if (close < slow && mid < slow && prior > fastPrior && close < fast) return signal(candidate, "short", a * 2, targetR, 40, "downtrend pullback closed back below SMA20");
      return null;
    },
  };
  return candidate;
}

/** The pre-registered set, in ledger order. Parameters are few on purpose: every extra one is a
 *  hypothesis the multiple-testing adjustment charges against all of them. */
export const PROMPT_FAMILY_CANDIDATES: readonly EdgeCandidate[] = [
  orbContinuation(5, 2), orbContinuation(15, 2), orbContinuation(30, 2),
  vwapReclaim(3, 1.5), vwapReclaim(3, 2.5),
  vwapDeviationMr(2), vwapDeviationMr(3),
  pdhPdlBreak(2), pdhPdlBreak(3),
  overnightRangeBreak(2), overnightRangeBreak(3),
  liquiditySweepReversal(20), liquiditySweepReversal(50),
  rangeExpansionMomentum(2, 2.5), rangeExpansionMomentum(3, 2.5),
  maContinuation(2.5), maContinuation(3.5),
];
