// Dealer Gamma Exposure (GEX) — the "where are market-makers forced to hedge" map, computed from the full
// options open-interest chain. This is the regime signal the naive premium-selling backtest was blind to:
//   • POSITIVE GEX  → dealers are net-long gamma → they SELL rallies / BUY dips → volatility SUPPRESSED
//                     (mean-reverting, calm) → selling premium is relatively safe.
//   • NEGATIVE GEX  → dealers are net-short gamma → they BUY rallies / SELL dips → moves AMPLIFIED
//                     (trending, crash-prone) → selling premium is dangerous; stand aside or buy premium.
// Convention: customers are assumed net-long puts (protection) and net-long calls (upside), so DEALERS are
// SHORT both — dealer gamma = +call_OI·γ − put_OI·γ (the standard SqueezeMetrics/SpotGamma sign). The
// aggregate LEVEL and its zero-crossing ("gamma flip" spot) are the tradeable outputs.
import { bsGamma } from "./black-scholes";

export interface OptionOI {
  strike: number;
  type: "call" | "put";
  expiryMs: number;   // expiration timestamp
  openInterest: number;
}

export interface GexResult {
  spot: number;
  totalGex: number;        // $ gamma per 1% move, dealer-signed (positive = vol-suppressing)
  gexPerPointNorm: number; // totalGex / (spot notional) — scale-free, comparable across price levels & names
  callGex: number;
  putGex: number;
  flipSpot: number | null; // spot level where net gamma crosses zero (below = negative-gamma danger zone)
  regime: "positive" | "negative";
  nContracts: number;
}

// Dollar gamma of one option leg: OI · γ · 100 · S² · 0.01  (≈ $ the dealer must hedge per 1% move).
function legDollarGamma(oi: number, gamma: number, S: number): number {
  return oi * gamma * 100 * S * S * 0.01;
}

// Compute GEX at a given spot. `iv` is an annualized vol estimate for gamma (aggregate GEX is not very
// sensitive to per-strike IV; a single ATM vol is a fine first-order input). Options past expiry are skipped.
export function computeGex(options: OptionOI[], spot: number, nowMs: number, iv: number): GexResult {
  let callGex = 0, putGex = 0, n = 0;
  for (const o of options) {
    const T = (o.expiryMs - nowMs) / (365 * 86_400_000);
    if (T <= 0 || o.openInterest <= 0) continue;
    const g = bsGamma(spot, o.strike, T, iv);
    const dg = legDollarGamma(o.openInterest, g, spot);
    if (o.type === "call") callGex += dg; else putGex += dg;
    n++;
  }
  const totalGex = callGex - putGex; // dealers short customer calls (+) and short customer puts (−)
  return {
    spot, totalGex, gexPerPointNorm: totalGex / (spot * spot * 100),
    callGex, putGex,
    flipSpot: findFlip(options, spot, nowMs, iv),
    regime: totalGex >= 0 ? "positive" : "negative",
    nContracts: n,
  };
}

// Net dealer gamma sign scanned across a spot grid ±15% to locate the zero-crossing ("gamma flip").
function findFlip(options: OptionOI[], spot: number, nowMs: number, iv: number): number | null {
  const lo = spot * 0.85, hi = spot * 1.15, steps = 60;
  let prevSign = 0, prevS = lo;
  for (let k = 0; k <= steps; k++) {
    const S = lo + (hi - lo) * (k / steps);
    let call = 0, put = 0;
    for (const o of options) {
      const T = (o.expiryMs - nowMs) / (365 * 86_400_000);
      if (T <= 0 || o.openInterest <= 0) continue;
      const dg = legDollarGamma(o.openInterest, bsGamma(S, o.strike, T, iv), S);
      if (o.type === "call") call += dg; else put += dg;
    }
    const net = call - put;
    const sign = net >= 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) return (prevS + S) / 2; // crossed zero
    prevSign = sign; prevS = S;
  }
  return null;
}
