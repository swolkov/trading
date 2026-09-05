// Stock scanner — the crypto scanner's signal detectors and conviction scorer, run on
// Yahoo stock bars. Deliberately IMPORTS `evaluate` and `scoreConviction` from
// margin-scanner rather than copying them: the whole point of the stock book is to ask
// whether the SAME signal and the SAME conviction formula that showed promise on crypto
// hold on equities. Only the timeframe thresholds differ (stocks move less per bar).
import { evaluate, scoreConviction, type ScanSignal, type TfSpec } from "@/lib/margin-scanner";
import { getStockBars, type StockInterval } from "@/lib/stock-bars";
import { STOCK_UNIVERSE } from "@/lib/stock-paper-model";

export { scoreConviction };
export type { ScanSignal };

// Move thresholds are roughly half the crypto ones — a 1% 3-bar move on a 5-minute
// chart is a real event for a large cap. Lookbacks give `evaluate` what it needs:
// ≥25 bars everywhere, ≥45 on 1h for the coil detector, ≥60 on 1d for the decision-zone
// and vol-expansion checks (interval ≥ 240 in evaluate's own gating — 1d qualifies).
interface StockTf { tf: TfSpec; yf: StockInterval; lookbackMs: number }
const DAY = 24 * 3600_000;
export const STOCK_TIMEFRAMES: StockTf[] = [
  { tf: { interval: 5, label: "5m", movePct: 0.008, realertMs: 1 * 3600_000 }, yf: "5m", lookbackMs: 5 * DAY },
  { tf: { interval: 15, label: "15m", movePct: 0.012, realertMs: 2 * 3600_000 }, yf: "15m", lookbackMs: 10 * DAY },
  { tf: { interval: 60, label: "1h", movePct: 0.02, realertMs: 6 * 3600_000 }, yf: "1h", lookbackMs: 30 * DAY },
  { tf: { interval: 1440, label: "1d", movePct: 0.04, realertMs: 48 * 3600_000 }, yf: "1d", lookbackMs: 200 * DAY },
];

// Scan the whole universe: 30 names × 4 timeframes = 120 Yahoo calls, paced ~120ms
// (≈35s measured). A symbol/timeframe that errors (Yahoo hiccup, thin history) is
// skipped, never fatal — the scan reports what it could see. `budgetMs` bounds the whole
// scan: when Yahoo degrades to seconds per call, the scan stops early and says so, so the
// route always finishes inside its 300s limit instead of dying before it can report.
export async function scanStockUniverse(budgetMs = 200_000): Promise<{ signals: ScanSignal[]; errors: string[]; scannedSymbols: number }> {
  const signals: ScanSignal[] = [];
  const errors: string[] = [];
  const now = Date.now();
  let scannedSymbols = 0;
  for (const sym of STOCK_UNIVERSE) {
    if (Date.now() - now > budgetMs) {
      errors.push(`scan budget exhausted after ${scannedSymbols}/${STOCK_UNIVERSE.length} symbols`);
      break;
    }
    const coin = { name: sym, symbol: sym };
    for (const { tf, yf, lookbackMs } of STOCK_TIMEFRAMES) {
      try {
        const bars = await getStockBars(sym, yf, now - lookbackMs);
        signals.push(...evaluate(coin, tf, bars));
      } catch (e) {
        errors.push(`${sym}@${tf.label}: ${String(e).slice(0, 60)}`);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    scannedSymbols++;
  }
  return { signals, errors, scannedSymbols };
}

export function stockSignalKey(s: ScanSignal): string {
  return `${s.coin}:${s.timeframe}:${s.kind}`;
}
