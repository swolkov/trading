/**
 * RISK OVERLAY — the portfolio risk engine that gates EVERY strategy signal before it becomes an order.
 *
 * This is the survival layer (proven essential: more risk = ruin; the book lives or dies here).
 * Enforces: per-trade risk cap, max concurrent positions, total portfolio heat, daily-loss halt,
 * and a hard drawdown kill switch. Strategy modules emit signals; nothing trades unless `canEnter`
 * says yes. Same module for backtest + live.
 */
export interface RiskConfig {
  maxConcurrent: number;          // max simultaneous open positions
  maxRiskPerTradePct: number;     // reject a single trade risking more than this (e.g. 0.02)
  maxPortfolioHeatPct: number;    // reject if total open risk would exceed this (e.g. 0.06)
  dailyLossLimitPct: number;      // halt new entries for the day at this loss (e.g. 0.03)
  maxDrawdownPct: number;         // hard kill switch — close/stop everything (e.g. 0.15)
}

export class RiskOverlay {
  private peak: number;
  private dayPnl = 0;
  private dayKey = "";
  private openRisk = new Map<string, number>();   // symbol → $ risk currently open
  private halted = false;                         // daily-loss halt (resets next day)
  private killed = false;                         // drawdown kill (permanent until manual reset)

  constructor(private cfg: RiskConfig, startEquity: number) { this.peak = startEquity; }

  /** Roll the trading day (resets the daily-loss halt; the drawdown kill persists). */
  newDay(date: string) { if (date !== this.dayKey) { this.dayKey = date; this.dayPnl = 0; this.halted = false; } }

  /** The single gate: may we open `symbol` risking `dollarRisk` on `equity`? */
  canEnter(symbol: string, dollarRisk: number, equity: number): { ok: boolean; reason: string } {
    if (this.killed) return { ok: false, reason: "KILLED — max drawdown breached" };
    if (this.halted) return { ok: false, reason: "HALTED — daily loss limit hit" };
    if (this.openRisk.has(symbol)) return { ok: false, reason: "already in position" };
    if (this.openRisk.size >= this.cfg.maxConcurrent) return { ok: false, reason: `max concurrent (${this.cfg.maxConcurrent})` };
    if (dollarRisk > equity * this.cfg.maxRiskPerTradePct) return { ok: false, reason: `risk $${dollarRisk.toFixed(0)} > per-trade cap` };
    const heat = [...this.openRisk.values()].reduce((s, v) => s + v, 0) + dollarRisk;
    if (heat > equity * this.cfg.maxPortfolioHeatPct) return { ok: false, reason: `portfolio heat ${(heat / equity * 100).toFixed(0)}% > cap` };
    return { ok: true, reason: "ok" };
  }

  onOpen(symbol: string, dollarRisk: number) { this.openRisk.set(symbol, dollarRisk); }

  /** Record a closed trade's P&L; updates daily loss + drawdown and trips halts/kill as needed. */
  onClose(symbol: string, pnl: number, equity: number) {
    this.openRisk.delete(symbol);
    this.dayPnl += pnl;
    this.peak = Math.max(this.peak, equity);
    if (this.dayPnl <= -equity * this.cfg.dailyLossLimitPct) this.halted = true;
    if (equity <= this.peak * (1 - this.cfg.maxDrawdownPct)) this.killed = true;
  }

  get state() { return { halted: this.halted, killed: this.killed, dayPnl: this.dayPnl, openPositions: this.openRisk.size, peak: this.peak }; }
}
