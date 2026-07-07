// Black-Scholes option pricing + greeks. Used ONLY by the options research/backtest engine to MODEL an
// entry premium when no historical options feed is available (we price legs off VIX-implied vol + a simple
// equity skew). The WIN/LOSS of every spread is decided by the REAL historical price path, not this model —
// this only estimates how much credit you'd have collected. Keep it dependency-free and pure.

// Standard normal CDF via the Abramowitz-Stegun erf approximation (max error ~1.5e-7).
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export type OptType = "call" | "put";

// European Black-Scholes price. S=spot, K=strike, T=years to expiry, sigma=annualized vol (e.g. 0.18),
// r=risk-free (default ~0). Returns price PER SHARE (×100 for a contract).
export function bsPrice(type: OptType, S: number, K: number, T: number, sigma: number, r = 0.04): number {
  if (T <= 0) return Math.max(0, type === "call" ? S - K : K - S); // intrinsic at/after expiry
  if (sigma <= 0) sigma = 0.01;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (type === "call") return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

// Option delta (signed: calls 0..1, puts -1..0).
export function bsDelta(type: OptType, S: number, K: number, T: number, sigma: number, r = 0.04): number {
  if (T <= 0) { const itm = type === "call" ? S > K : S < K; return itm ? (type === "call" ? 1 : -1) : 0; }
  if (sigma <= 0) sigma = 0.01;
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  return type === "call" ? normCdf(d1) : normCdf(d1) - 1;
}

// Simple equity vol skew: OTM puts trade RICHER, OTM calls slightly CHEAPER than ATM vol. `moneyness` is
// the fractional distance OTM (e.g. 0.03 = 3% OTM). Conservative linear model (~0.4 vol pts per 1% for
// puts). This only affects the modeled credit size, never the win/loss (which is from the real path).
export function skewedVol(type: OptType, atmVol: number, otmFraction: number): number {
  const f = Math.max(0, otmFraction);
  if (type === "put") return atmVol * (1 + 3.0 * f);   // richer downside
  return atmVol * Math.max(0.6, 1 - 1.0 * f);          // slightly cheaper upside
}
