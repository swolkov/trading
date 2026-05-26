/**
 * TRADING BOOK ORCHESTRATOR — wires the strategies + risk overlay into one engine.
 *
 * `onBar()` collects signals from every strategy, sizes them, runs each through the RiskOverlay gate,
 * and emits only the risk-APPROVED orders (2-leg for spreads, single for overnight). The live
 * execution adapter sends these to Tradovate and calls `reportFill()` when a close settles so the
 * risk engine sees realized P&L (daily-loss / drawdown). Same engine for backtest + live.
 */
import { SpreadStrategy, SpreadConfig, sizeSpread } from "./spread-strategy";
import { OvernightStrategy, OvernightConfig } from "./overnight-strategy";
import { RiskOverlay, RiskConfig } from "./risk-overlay";

export interface Order { symbol: string; side: "buy" | "sell"; qty: number; strategy: string; key: string; reason: string; }
export interface BookConfig {
  spread: SpreadConfig;
  overnight: OvernightConfig;
  risk: RiskConfig;
  mult: Record<string, number>;     // contract point-values for sizing
  riskPerTradePct: number;          // budgeted risk per position
  overnightStopPct?: number;        // notional move used to size the (stopless) overnight leg (default 1%)
}

export class TradingBook {
  private spread: SpreadStrategy;
  private overnight: OvernightStrategy;
  private risk: RiskOverlay;
  private open = new Map<string, Order[]>();   // key → the opening orders (to flatten on close)
  constructor(private cfg: BookConfig, startEquity: number) {
    this.spread = new SpreadStrategy(cfg.spread);
    this.overnight = new OvernightStrategy(cfg.overnight);
    this.risk = new RiskOverlay(cfg.risk, startEquity);
  }

  onBar(date: string, etMin: number, prices: Record<string, number>, equity: number): Order[] {
    this.risk.newDay(date);
    const orders: Order[] = [];
    const dollarRisk = equity * this.cfg.riskPerTradePct;

    // ---- SPREADS (2-leg, dollar-neutral) ----
    for (const sig of this.spread.onBar(prices)) {
      const key = "spread:" + sig.pair, [a, b] = sig.pair.split("/");
      if (sig.action === "open") {
        if (!this.risk.canEnter(key, dollarRisk, equity).ok) continue;
        const sz = sizeSpread(sig, prices, this.cfg.mult, equity, this.cfg.riskPerTradePct);
        if (sz.a < 1 || sz.b < 1) continue;   // account can't afford both legs
        const legs: Order[] = sig.dir === "long"
          ? [mk(a, "buy", sz.a, "spread", key, sig.reason), mk(b, "sell", sz.b, "spread", key, sig.reason)]
          : [mk(a, "sell", sz.a, "spread", key, sig.reason), mk(b, "buy", sz.b, "spread", key, sig.reason)];
        this.risk.onOpen(key, dollarRisk); this.open.set(key, legs); orders.push(...legs);
      } else if (this.open.has(key)) {
        orders.push(...this.open.get(key)!.map(l => mk(l.symbol, flip(l.side), l.qty, "spread", key, "close " + sig.reason)));
        this.open.delete(key);   // risk slot frees on reportFill (when realized P&L is known)
      }
    }

    // ---- OVERNIGHT (single leg, long) ----
    for (const sig of this.overnight.onBar(etMin, date, prices)) {
      const key = "on:" + sig.symbol;
      if (sig.action === "open") {
        if (!this.risk.canEnter(key, dollarRisk, equity).ok) continue;
        const qty = Math.floor(dollarRisk / (prices[sig.symbol] * this.cfg.mult[sig.symbol] * (this.cfg.overnightStopPct ?? 0.01)));
        if (qty < 1) continue;
        const o = mk(sig.symbol, "buy", qty, "overnight", key, sig.reason);
        this.risk.onOpen(key, dollarRisk); this.open.set(key, [o]); orders.push(o);
      } else if (this.open.has(key)) {
        orders.push(...this.open.get(key)!.map(l => mk(l.symbol, "sell", l.qty, "overnight", key, "close overnight")));
        this.open.delete(key);
      }
    }
    return orders;
  }

  /** Live adapter calls this when a closed position settles, so the risk engine sees realized P&L. */
  reportFill(key: string, realizedPnl: number, equity: number) { this.risk.onClose(key, realizedPnl, equity); }

  get state() { return { ...this.risk.state, openKeys: [...this.open.keys()] }; }
}

function mk(symbol: string, side: "buy" | "sell", qty: number, strategy: string, key: string, reason: string): Order { return { symbol, side, qty, strategy, key, reason }; }
function flip(s: "buy" | "sell"): "buy" | "sell" { return s === "buy" ? "sell" : "buy"; }
