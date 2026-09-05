// Stock OHLCV bars from Yahoo (free, regular session only). One function, one shape,
// used by both the stock scanner (5m/15m/1h/1d) and the paper evaluator (1m walk).
//
// Yahoo limits: 1m bars reach back 7 days; 5m/15m 60 days; 1h ~2 years; 1d unlimited.
// Regular-session bars only (no pre/post) — a Robinhood stop order rests in the regular
// session, so scoring a paper stop against extended-hours prints would be wrong anyway.
// The newest bar is the IN-PROGRESS one during RTH, exactly like Kraken's last row; the
// evaluator treats it as touch-only.
import { isStockRthAt } from "@/lib/stock-paper-model";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinanceClass = require("yahoo-finance2").default || require("yahoo-finance2");
const yahooFinance = new YahooFinanceClass({ suppressNotices: ["ripHistorical"] });

export interface StockBar { t: number; o: number; h: number; l: number; c: number; v: number }   // t = epoch seconds
export type StockInterval = "1m" | "5m" | "15m" | "1h" | "1d";

// Keep only bars that START inside the regular session. Yahoo's intraday feed can carry
// pre/post prints (a 1-minute pull on Sep 5 2026 came back with bars stamped 23:59Z), and
// a paper stop scored against an after-hours print would be a fill no resting Robinhood
// stop order could have had. Daily bars are stamped at the session open and pass as-is.
export function regularSessionOnly(bars: StockBar[], interval: StockInterval): StockBar[] {
  if (interval === "1d") return bars;
  return bars.filter((b) => isStockRthAt(new Date(b.t * 1000), []));
}

export async function getStockBars(symbol: string, interval: StockInterval, sinceMs: number): Promise<StockBar[]> {
  const result = await yahooFinance.chart(symbol, {
    period1: new Date(sinceMs),
    period2: new Date(),
    interval,
    includePrePost: false,
  });
  const quotes = (result?.quotes ?? []) as Record<string, number | Date | null>[];
  let bars: StockBar[] = [];
  for (const q of quotes) {
    const c = Number(q.close);
    if (!(c > 0)) continue;   // Yahoo pads gaps with null rows
    const t = q.date ? Math.floor(new Date(String(q.date)).getTime() / 1000) : 0;
    if (!(t > 0)) continue;
    bars.push({ t, o: Number(q.open) || c, h: Number(q.high) || c, l: Number(q.low) || c, c, v: Number(q.volume) || 0 });
  }
  bars = regularSessionOnly(bars, interval);
  bars.sort((a, b) => a.t - b.t);
  // Dedupe by timestamp keeping the LAST copy (the most complete in-progress bar).
  return bars.filter((b, i) => i === bars.length - 1 || bars[i + 1].t !== b.t);
}
