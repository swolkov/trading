// Options-strategy backtester. The DECISIVE part — did the trade win or lose — is driven by the REAL
// historical price path (Yahoo daily bars). Only the entry CREDIT and daily mark-to-market are modeled
// (Black-Scholes off VIX-implied vol + skew), because no historical options feed exists. This answers:
// "does selling premium on this name, at these settings, actually have a positive expectancy?" — before a
// dollar is risked. It is intentionally conservative (real commissions + slippage; close-based marks).
import { bsPrice, skewedVol, bsDelta, type OptType } from "./black-scholes";

export interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }

export type StrategyKind = "put_credit" | "call_credit" | "iron_condor";

export interface StratConfig {
  kind: StrategyKind;
  dteCalendar: number;   // days to expiry at entry
  otmPct: number;        // short strike distance from spot (e.g. 0.03 = 3% OTM)
  widthPct: number;      // spread width as % of spot (defines max loss)
  profitTarget: number;  // take profit at this fraction of credit (0.5 = +50%)
  stopMultiple: number;  // stop when loss reaches this × credit (1 = −1× credit)
  ivFloorPctile: number; // only enter when VIX percentile (trailing 1y) ≥ this (0 = always)
  stepDays: number;      // enter every N trading days (controls sample overlap)
}

export interface OTrade {
  entryDate: string; exitDate: string; kind: StrategyKind;
  creditPerShare: number; maxLossPerShare: number;
  pnl: number;           // dollars, 1 contract, NET of costs
  r: number;             // pnl / maxLossDollars
  shortDelta: number;    // |delta| of the short leg at entry (≈ prob ITM)
  exit: "target" | "stop" | "expiry" | "time";
  win: boolean;
}

// Per-name ATM vol proxy from VIX (SPX 30d IV). QQQ/IWM run a bit hotter than SPX historically.
const VOL_MULT: Record<string, number> = { SPY: 1.0, QQQ: 1.13, IWM: 1.22, DIA: 0.95 };
function atmVolFromVix(sym: string, vix: number): number {
  return Math.max(0.05, (vix / 100) * (VOL_MULT[sym] ?? 1.1));
}

// Round-trip cost per 1-lot: commission ($0.65/contract/leg, open+close) + slippage (~$0.04/share/leg).
function roundTripCost(legs: number): number {
  const commission = 0.65 * legs * 2;
  const slippage = 0.04 * 100 * legs; // per leg, one-way bid/ask give-up
  return commission + slippage;
}

// Value (debit to close) of a short vertical given current spot/T/vol. legs priced with entry-fixed skew.
function verticalValue(type: OptType, S: number, shortK: number, longK: number, T: number, sSkew: number, lSkew: number): number {
  return bsPrice(type, S, shortK, T, sSkew) - bsPrice(type, S, longK, T, lSkew);
}

export function backtestStrategy(
  sym: string,
  bars: Bar[],
  vixByDate: Map<string, number>,
  cfg: StratConfig,
): OTrade[] {
  const trades: OTrade[] = [];
  const dateOf = (b: Bar) => b.t.slice(0, 10);
  const vixSeries = bars.map((b) => vixByDate.get(dateOf(b)) ?? NaN);

  for (let i = 20; i < bars.length - 2; i += cfg.stepDays) {
    const b0 = bars[i];
    const vix0 = vixSeries[i];
    if (!isFinite(vix0)) continue;

    // IV regime filter: VIX percentile over trailing 252 days.
    if (cfg.ivFloorPctile > 0) {
      const lo = Math.max(0, i - 252);
      const window = vixSeries.slice(lo, i).filter((v) => isFinite(v));
      if (window.length > 30) {
        const below = window.filter((v) => v <= vix0).length;
        const pctile = (below / window.length) * 100;
        if (pctile < cfg.ivFloorPctile) continue;
      }
    }

    const S0 = b0.c;
    const atmVol = atmVolFromVix(sym, vix0);
    const entryDate = dateOf(b0);
    const expiryMs = new Date(entryDate).getTime() + cfg.dteCalendar * 86_400_000;
    // Find the first bar on/after the expiry date (settlement bar); skip if not enough history.
    let j = i + 1;
    while (j < bars.length && new Date(dateOf(bars[j])).getTime() < expiryMs) j++;
    if (j >= bars.length) break; // ran out of forward data
    const T0 = cfg.dteCalendar / 365;

    // Build the legs for the chosen strategy. sides = [{type, shortK, longK, sSkew, lSkew}]
    const sides: { type: OptType; shortK: number; longK: number; sSkew: number; lSkew: number }[] = [];
    const width = S0 * cfg.widthPct;
    if (cfg.kind === "put_credit" || cfg.kind === "iron_condor") {
      const shortK = S0 * (1 - cfg.otmPct), longK = shortK - width;
      sides.push({ type: "put", shortK, longK, sSkew: skewedVol("put", atmVol, cfg.otmPct), lSkew: skewedVol("put", atmVol, cfg.otmPct + cfg.widthPct) });
    }
    if (cfg.kind === "call_credit" || cfg.kind === "iron_condor") {
      const shortK = S0 * (1 + cfg.otmPct), longK = shortK + width;
      sides.push({ type: "call", shortK, longK, sSkew: skewedVol("call", atmVol, cfg.otmPct), lSkew: skewedVol("call", atmVol, cfg.otmPct + cfg.widthPct) });
    }

    // Entry credit + short-leg delta (prob-ITM proxy).
    let credit = 0, shortDeltaAbs = 0;
    for (const s of sides) {
      credit += verticalValue(s.type, S0, s.shortK, s.longK, T0, s.sSkew, s.lSkew);
      shortDeltaAbs = Math.max(shortDeltaAbs, Math.abs(bsDelta(s.type, S0, s.shortK, T0, s.sSkew)));
    }
    if (!(credit > 0)) continue;
    // Max loss: only ONE side of a condor can finish ITM, so risk = width − totalCredit either way.
    const maxLoss = Math.max(0.01, width - credit);
    const legs = sides.length * 2;
    const cost = roundTripCost(legs);
    const maxLossDollars = maxLoss * 100 + cost;

    // Walk the REAL path from entry+1 to settlement, repricing each day; apply live exit rules.
    let exit: OTrade["exit"] = "expiry";
    let exitDate = dateOf(bars[j]);
    let pnlPerShare = 0;
    for (let d = i + 1; d <= j; d++) {
      const bd = bars[d];
      const Td = Math.max(0, (expiryMs - new Date(dateOf(bd)).getTime()) / 86_400_000) / 365;
      const vixd = isFinite(vixSeries[d]) ? vixSeries[d] : vix0;
      const volD = atmVolFromVix(sym, vixd);
      let V = 0; // debit to close the whole position now
      for (const s of sides) {
        const sSk = skewedVol(s.type, volD, cfg.otmPct), lSk = skewedVol(s.type, volD, cfg.otmPct + cfg.widthPct);
        V += verticalValue(s.type, bd.c, s.shortK, s.longK, Td, sSk, lSk);
      }
      const pl = credit - V; // per share
      if (d === j) { pnlPerShare = pl; exit = "expiry"; exitDate = dateOf(bd); break; }
      if (pl >= cfg.profitTarget * credit) { pnlPerShare = pl; exit = "target"; exitDate = dateOf(bd); break; }
      if (pl <= -cfg.stopMultiple * credit) { pnlPerShare = pl; exit = "stop"; exitDate = dateOf(bd); break; }
    }

    const pnl = pnlPerShare * 100 - cost;
    trades.push({
      entryDate, exitDate, kind: cfg.kind,
      creditPerShare: credit, maxLossPerShare: maxLoss,
      pnl, r: pnl / maxLossDollars, shortDelta: shortDeltaAbs,
      exit, win: pnl > 0,
    });
  }
  return trades;
}

export interface Stats {
  n: number; wr: number; expDollars: number; expR: number; pf: number;
  net: number; maxDD: number; sharpe: number; avgCredit: number;
}

export function computeStats(trades: OTrade[]): Stats | null {
  const n = trades.length;
  if (!n) return null;
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl < 0);
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades) { cum += t.pnl; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  const rs = trades.map((t) => t.r);
  const meanR = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - meanR) ** 2, 0) / n) || 1e-9;
  return {
    n, wr: wins.length / n, expDollars: net / n, expR: meanR,
    pf: gl ? gw / gl : (gw > 0 ? Infinity : 0),
    net, maxDD: dd, sharpe: (meanR / sd) * Math.sqrt(n), // per-sample Sharpe scaled by sqrt(n)
    avgCredit: trades.reduce((s, t) => s + t.creditPerShare, 0) / n * 100,
  };
}
