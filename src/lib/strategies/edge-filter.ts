/**
 * EDGE FILTER — encodes the 15-year *measured* research into the trade-confirmation layer.
 *
 * This is how you actually "beef up the AI score": not by having an AI memorize charts (memorization
 * isn't prediction), but by arming the confirmation gate with the edge map we MEASURED statistically —
 * confirm proven edges, VETO proven losers. Selection driven by expectancy, not chart-gazing.
 *
 * Sources: backtest.ts (15yr by-setup/by-market), pairs-test.ts, overnight-test.ts, study-*.ts.
 */
export interface TradeCandidate { instrument: string; setup: string; dir: "long" | "short"; rsi?: number; session?: string; }
export interface EdgeVerdict { confirm: boolean; conviction: number; reason: string; }   // conviction 0–1

export function edgeFilter(c: TradeCandidate): EdgeVerdict {
  const metal = /^M?GC$/.test(c.instrument);
  const equityIndex = /^M?(ES|NQ|RTY|YM)$/.test(c.instrument);

  // ── VETOES — statistically proven losers over 15 years ──
  if (c.setup === "trend continuation") return veto("trend-continuation loses in AND out of sample (PF 0.91–0.93)");
  if (c.setup === "RSI bounce" && equityIndex) return veto("ES/NQ RSI-bounce lost money every year (PF 0.79–0.93)");
  if (c.setup === "OR breakout" && equityIndex) return veto("equity OR-breakout net-negative over 15yr");
  if (c.setup === "vol coil breakout") return veto("coil-breakout is a coin flip (−0.003R)");
  if (c.setup === "opening drive") return veto("opening-drive continuation is a coin flip (+0.01R)");

  // ── CONFIRMS — statistically proven edges ──
  if (c.setup === "spread") return ok(0.90, "validated relative-value edge (Sharpe ~1.0, held OOS)");
  if (c.setup === "overnight") return ok(0.85, "validated overnight drift (Sharpe ~1.2, + every year)");
  if (c.setup === "RSI bounce" && metal) {
    const deep = c.dir === "long" ? (c.rsi ?? 50) < 25 : (c.rsi ?? 50) > 75;
    return ok(deep ? 0.70 : 0.50, `gold RSI-bounce — the one validated intraday edge${deep ? " (deep extreme)" : " (thin)"}`);
  }
  if (c.setup === "failed reaction" || c.setup === "failed IB") return ok(0.65, "failed-reaction fade — real but rare (+0.30R)");

  // ── default: no measured edge → don't confirm ──
  return { confirm: false, conviction: 0.30, reason: "no validated edge for this setup/instrument — skip" };
}

const ok = (conviction: number, reason: string): EdgeVerdict => ({ confirm: true, conviction, reason });
const veto = (reason: string): EdgeVerdict => ({ confirm: false, conviction: 0, reason: "VETO: " + reason });
