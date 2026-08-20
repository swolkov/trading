import type { EdgeCandidate, MarketSpec, ReplayResult, ReplayTrade, ResearchBar } from "./types";

function roundAgainstTrader(direction: "long" | "short", price: number, tickSize: number, entering: boolean): number {
  const shouldRoundUp = (direction === "long") === entering;
  const ticks = price / tickSize;
  return (shouldRoundUp ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9)) * tickSize;
}

function adversePrice(direction: "long" | "short", price: number, slip: number, entering: boolean, tickSize: number): number {
  const sign = direction === "long" ? 1 : -1;
  return roundAgainstTrader(direction, price + sign * slip * (entering ? 1 : -1), tickSize, entering);
}

/**
 * Event-driven, one-position-at-a-time replay. Signals are evaluated only after a bar is complete,
 * entries occur at the next bar open, roll-crossing signals are skipped, and ambiguous stop/target
 * bars resolve to the stop. These rules are deliberately conservative and mirror live constraints.
 */
export function replayCandidateDetailed(
  bars: readonly ResearchBar[],
  candidate: EdgeCandidate,
  market: MarketSpec,
): ReplayResult {
  const trades: ReplayTrade[] = [];
  const diagnostics: ReplayResult["diagnostics"] = {
    signals: 0,
    invalidSignals: 0,
    unpriceableEntries: 0,
    rollCrossingEntries: 0,
    rollInterruptedTrades: 0,
  };
  let nextEligibleIndex = candidate.minimumHistory;

  for (let i = candidate.minimumHistory; i < bars.length - 1; i++) {
    if (i < nextEligibleIndex) continue;
    const signal = candidate.evaluate(bars, i);
    if (!signal || signal.edgeKey !== candidate.key || signal.version !== candidate.version) continue;
    diagnostics.signals++;
    if (![signal.stopDistance, signal.targetDistance, signal.maxHoldBars].every(Number.isFinite)
      || signal.stopDistance <= 0 || signal.targetDistance <= 0 || signal.maxHoldBars < 1) {
      diagnostics.invalidSignals++;
      continue;
    }

    const entryBar = bars[i + 1];
    if (entryBar.instrumentId !== bars[i].instrumentId) {
      diagnostics.rollCrossingEntries++;
      continue;
    }
    const entryPrice = adversePrice(signal.direction, entryBar.o, market.entrySlippagePoints, true, market.tickSize);
    if (entryPrice < entryBar.l || entryPrice > entryBar.h) {
      diagnostics.unpriceableEntries++;
      continue;
    }
    const rawStop = signal.direction === "long" ? entryPrice - signal.stopDistance : entryPrice + signal.stopDistance;
    const rawTarget = signal.direction === "long" ? entryPrice + signal.targetDistance : entryPrice - signal.targetDistance;
    const stop = roundAgainstTrader(signal.direction, rawStop, market.tickSize, false);
    const target = roundAgainstTrader(signal.direction, rawTarget, market.tickSize, false);
    const actualStopDistance = Math.abs(entryPrice - stop);
    let exitPrice = adversePrice(signal.direction, entryBar.c, market.exitSlippagePoints, false, market.tickSize);
    let exitReason: ReplayTrade["exitReason"] = "time";
    let exitIndex = Math.min(i + signal.maxHoldBars, bars.length - 1);
    let rollInterrupted = false;

    for (let j = i + 1; j <= exitIndex; j++) {
      const bar = bars[j];
      if (bar.instrumentId !== entryBar.instrumentId) {
        // The continuous series no longer contains the held contract. Exiting at the prior close
        // would use a price retroactively, while exiting on the new bar would use the wrong contract.
        // Omit the unpriceable trade and make validation reject the candidate until raw-contract
        // data can follow the held instrument through its actual exit.
        diagnostics.rollInterruptedTrades++;
        rollInterrupted = true;
        exitIndex = j;
        break;
      }
      const hitStop = signal.direction === "long" ? bar.l <= stop : bar.h >= stop;
      const hitTarget = signal.direction === "long" ? bar.h >= target : bar.l <= target;
      if (hitStop) {
        exitPrice = adversePrice(signal.direction, signal.direction === "long" ? Math.min(stop, bar.o) : Math.max(stop, bar.o), market.exitSlippagePoints, false, market.tickSize);
        exitReason = "stop";
        exitIndex = j;
        break;
      }
      // A slipped entry is only a price estimate, not an intrabar timestamp. Crediting a target on
      // the entry bar could use a high/low that printed before the modeled fill. Stops remain active
      // immediately, but favorable exits require a later bar.
      const tradedThroughTarget = signal.direction === "long"
        ? bar.h >= target + market.tickSize
        : bar.l <= target - market.tickSize;
      if (hitTarget && tradedThroughTarget && j > i + 1) {
        exitPrice = target;
        exitReason = "target";
        exitIndex = j;
        break;
      }
      if (j === exitIndex) exitPrice = adversePrice(signal.direction, bar.c, market.exitSlippagePoints, false, market.tickSize);
    }

    if (rollInterrupted) {
      nextEligibleIndex = Math.max(i + 2, exitIndex + 1);
      continue;
    }

    const points = signal.direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
    const gross = points * market.pointValue;
    const pnl = gross - market.commissionRoundTurn;
    const dollarRisk = actualStopDistance * market.pointValue + market.commissionRoundTurn;
    trades.push({
      edgeKey: candidate.key,
      version: candidate.version,
      symbol: market.tradedSymbol,
      direction: signal.direction,
      signalTime: bars[i].t,
      entryTime: entryBar.t,
      exitTime: bars[Math.max(i + 1, exitIndex)].t,
      entryPrice,
      exitPrice,
      stopDistance: actualStopDistance,
      pnl,
      rMultiple: dollarRisk > 0 ? pnl / dollarRisk : 0,
      exitReason,
    });
    nextEligibleIndex = Math.max(i + 2, exitIndex + 1);
  }
  return { trades, diagnostics };
}

export function replayCandidate(
  bars: readonly ResearchBar[],
  candidate: EdgeCandidate,
  market: MarketSpec,
): ReplayTrade[] {
  return replayCandidateDetailed(bars, candidate, market).trades;
}
