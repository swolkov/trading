/**
 * OVERNIGHT STRATEGY MODULE — the validated overnight-drift edge, deployable.
 *
 * Long at the US cash close (~16:00 ET), exit at the cash open (~09:30 ET). Time-triggered, not
 * price-pattern. Same code for backtest replay and live: call `onBar(etMin, date, prices)` each bar.
 * Validated (scripts/overnight-test.ts): positive every year, Sharpe ~1.2–1.9 (note: bull-flattered;
 * directional — pair with the market-neutral spread book and gate by regime in production).
 */
export interface OvernightConfig {
  symbols: string[];
  entryWindow?: [number, number];   // ET minute-of-day to enter (default 16:00 area)
  exitWindow?: [number, number];    // ET minute-of-day to exit (default 09:30 area)
  skipFriday?: boolean;             // don't carry over the weekend gap (default true)
}
export interface OvernightSignal { symbol: string; action: "open" | "close"; side: "long"; reason: string; }
interface ONState { inPos: boolean; entryDay: string; exitDay: string; }

export class OvernightStrategy {
  private cfg: Required<OvernightConfig>;
  private st = new Map<string, ONState>();
  constructor(cfg: OvernightConfig) {
    this.cfg = { entryWindow: [956, 965], exitWindow: [566, 575], skipFriday: true, ...cfg };
    for (const s of cfg.symbols) this.st.set(s, { inPos: false, entryDay: "", exitDay: "" });
  }

  /** Call once per bar with ET minute-of-day, the calendar date (YYYY-MM-DD), and current prices. */
  onBar(etMin: number, date: string, prices: Record<string, number>): OvernightSignal[] {
    const dow = new Date(date + "T12:00:00Z").getUTCDay();   // 0=Sun … 5=Fri
    const out: OvernightSignal[] = [];
    const [eLo, eHi] = this.cfg.entryWindow, [xLo, xHi] = this.cfg.exitWindow;
    for (const sym of this.cfg.symbols) {
      const s = this.st.get(sym)!;
      if (!isFinite(prices[sym])) continue;
      // exit at the cash open (once per day)
      if (s.inPos && etMin >= xLo && etMin <= xHi && s.exitDay !== date) {
        out.push({ symbol: sym, action: "close", side: "long", reason: "cash-open exit" });
        s.inPos = false; s.exitDay = date;
      }
      // enter at the cash close (once per day; skip Friday → no weekend gap)
      if (!s.inPos && etMin >= eLo && etMin <= eHi && s.entryDay !== date && !(this.cfg.skipFriday && dow === 5)) {
        out.push({ symbol: sym, action: "open", side: "long", reason: "hold overnight (close→open drift)" });
        s.inPos = true; s.entryDay = date;
      }
    }
    return out;
  }

  hasPosition(symbol: string): boolean { return !!this.st.get(symbol)?.inPos; }
}
