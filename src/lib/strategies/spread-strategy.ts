/**
 * SPREAD STRATEGY MODULE — the validated core edge (relative-value z-score reversion), deployable.
 *
 * Pure signal logic. The SAME code runs in backtest (historical replay) and live (real quotes):
 * call `onBar(prices)` once per bar with the latest price for every symbol; it returns open/close
 * signals. The execution layer translates signals → dollar-neutral 2-leg orders via `sizeSpread`.
 *
 * Validated (15yr, scripts/pairs-test.ts): CL/RB, ZC/ZS, CL/HO, 6E/6B mean-revert; ~+0.3R/trade,
 * Sharpe ~1.0 on the economically-linked basket, held out-of-sample. No lookahead (z uses prior bars).
 */
export interface SpreadConfig {
  pairs: [string, string][];   // economically-linked legs, e.g. [["CL","RB"],["ZC","ZS"]]
  lookback?: number;           // z-score window (default 60)
  entryZ?: number;             // enter when |z| > this (default 2)
  exitZ?: number;              // exit when z crosses this (default 0)
  stopZ?: number;              // stop when |z| >= this (default 3.5)
  maxHold?: number;            // bars before timeout exit (default 40)
}

export interface SpreadSignal {
  pair: string;                // "CL/RB"
  action: "open" | "close";
  dir?: "long" | "short";      // long = long A / short B; short = short A / long B
  z: number;
  ratio: number;
  sigmaPct: number;            // ratio stdev / mean — used for risk-based sizing
  reason: string;
}

interface PairState { hist: number[]; pos: { dir: number; entryBar: number } | null; bar: number; }

export class SpreadStrategy {
  private cfg: Required<SpreadConfig>;
  private st = new Map<string, PairState>();

  constructor(cfg: SpreadConfig) {
    this.cfg = { lookback: 60, entryZ: 2, exitZ: 0, stopZ: 3.5, maxHold: 40, ...cfg };
    for (const [a, b] of cfg.pairs) this.st.set(`${a}/${b}`, { hist: [], pos: null, bar: 0 });
  }

  /** Call once per bar with current prices for all symbols. Returns signals to act on. */
  onBar(prices: Record<string, number>): SpreadSignal[] {
    const out: SpreadSignal[] = [];
    for (const [a, b] of this.cfg.pairs) {
      const key = `${a}/${b}`, s = this.st.get(key)!;
      const pa = prices[a], pb = prices[b];
      if (!isFinite(pa) || !isFinite(pb) || pb <= 0) continue;
      const ratio = pa / pb;
      s.bar++;
      s.hist.push(ratio);
      if (s.hist.length > this.cfg.lookback + 2) s.hist.shift();
      if (s.hist.length <= this.cfg.lookback) continue;

      const w = s.hist.slice(0, this.cfg.lookback);            // prior `lookback` bars (excludes current) → no lookahead
      const mean = w.reduce((x, y) => x + y, 0) / w.length;
      const sd = Math.sqrt(w.reduce((x, y) => x + (y - mean) ** 2, 0) / w.length) || 1e-9;
      const z = (ratio - mean) / sd, sigmaPct = sd / mean;

      if (s.pos) {
        const revert = s.pos.dir === -1 ? z <= this.cfg.exitZ : z >= this.cfg.exitZ;
        const stopped = Math.abs(z) >= this.cfg.stopZ;
        const timeout = s.bar - s.pos.entryBar >= this.cfg.maxHold;
        if (revert || stopped || timeout) {
          out.push({ pair: key, action: "close", z, ratio, sigmaPct, reason: stopped ? "stop" : timeout ? "timeout" : "revert" });
          s.pos = null;
        }
      }
      if (!s.pos) {
        if (z > this.cfg.entryZ) { s.pos = { dir: -1, entryBar: s.bar }; out.push({ pair: key, action: "open", dir: "short", z, ratio, sigmaPct, reason: `z=${z.toFixed(2)} > ${this.cfg.entryZ} → short ratio (short ${a} / long ${b})` }); }
        else if (z < -this.cfg.entryZ) { s.pos = { dir: 1, entryBar: s.bar }; out.push({ pair: key, action: "open", dir: "long", z, ratio, sigmaPct, reason: `z=${z.toFixed(2)} < -${this.cfg.entryZ} → long ratio (long ${a} / short ${b})` }); }
      }
    }
    return out;
  }

  /** True if a pair currently has an open position. */
  hasPosition(pair: string): boolean { return !!this.st.get(pair)?.pos; }
}

/**
 * Dollar-neutral leg sizing for a spread entry. risk = 1.5σ stop on the ratio.
 * Returns whole-contract quantities per leg (caller checks the account can afford both legs' margin).
 */
export function sizeSpread(
  sig: SpreadSignal, prices: Record<string, number>, mult: Record<string, number>, equity: number, riskPct: number,
): { a: number; b: number; dollarRisk: number } {
  const [a, b] = sig.pair.split("/");
  const notional = (equity * riskPct) / (1.5 * sig.sigmaPct);   // per-leg notional so a 1.5σ adverse ratio move ≈ riskPct
  const qa = Math.max(0, Math.round(notional / (prices[a] * mult[a])));
  const qb = Math.max(0, Math.round(notional / (prices[b] * mult[b])));
  return { a: qa, b: qb, dollarRisk: equity * riskPct };
}
