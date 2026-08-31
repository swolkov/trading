// Server-side margin scanner — watches every liquid margin coin across timeframes and
// surfaces notable technical events for AWARENESS. This is the "brain that watches
// everything" without Spencer hand-placing hundreds of alerts.
//
// ⚠️ AWARENESS ONLY. It pushes to Slack and logs to the DB; it NEVER calls the executor.
// Every mechanical signal family we tested (17 of them) lost out-of-sample, so auto-
// trading these would just automate losing. The scanner's job is to put Spencer's eyes
// on the right chart at the right moment and to build a scored record — not to trade.
import { getKrakenOHLC, type KrakenBar } from "@/lib/kraken-margin";

// Curated liquid margin universe (Kraken public pair codes). The 10x tier plus the most
// liquid 5x names; HYPE included because Spencer trades it. Kept as a fixed list so the
// scan is deterministic and fast rather than re-deriving the universe every run.
export const SCAN_COINS: { name: string; symbol: string }[] = [
  { name: "BTC", symbol: "BTC/USD" },
  { name: "ETH", symbol: "ETH/USD" },
  { name: "SOL", symbol: "SOL/USD" },
  { name: "XRP", symbol: "XRP/USD" },
  { name: "DOGE", symbol: "DOGE/USD" },
  { name: "ADA", symbol: "ADA/USD" },
  { name: "AVAX", symbol: "AVAX/USD" },
  { name: "LINK", symbol: "LINK/USD" },
  { name: "LTC", symbol: "LTC/USD" },
  { name: "DOT", symbol: "DOT/USD" },
  { name: "SUI", symbol: "SUI/USD" },
  { name: "AAVE", symbol: "AAVE/USD" },
  { name: "HYPE", symbol: "HYPE/USD" },
];

// Timeframes scanned for awareness. 1m/3m are deliberately NOT scanned: at that cadence
// every coin trips a threshold constantly and the alerts become noise. Those frames are
// for Spencer's own eyes on the chart; the scanner covers 15m and slower.
interface TfSpec { interval: 15 | 60 | 240 | 1440; label: string; movePct: number; realertMs: number }
const TIMEFRAMES: TfSpec[] = [
  { interval: 15, label: "15m", movePct: 0.02, realertMs: 2 * 3600_000 },
  { interval: 60, label: "1h", movePct: 0.03, realertMs: 6 * 3600_000 },
  { interval: 240, label: "4h", movePct: 0.05, realertMs: 24 * 3600_000 },
  { interval: 1440, label: "1d", movePct: 0.07, realertMs: 48 * 3600_000 },
];

export interface ScanSignal {
  coin: string;
  symbol: string;
  timeframe: string;
  kind: "oversold" | "overbought" | "breakout" | "breakdown" | "move-up" | "move-down" | "volume-spike";
  detail: string;
  price: number;
  realertMs: number;   // how long before this exact signal may fire again
}

function rsi14(closes: number[]): number {
  if (closes.length < 15) return NaN;
  let gain = 0, loss = 0;
  const start = closes.length - 15;
  for (let i = start + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  const rs = loss > 0 ? gain / loss : Infinity;
  const r = 100 - 100 / (1 + rs);
  return isFinite(r) ? r : 100;
}

function evaluate(coin: { name: string; symbol: string }, tf: TfSpec, bars: KrakenBar[]): ScanSignal[] {
  const out: ScanSignal[] = [];
  if (bars.length < 25) return out;
  const closes = bars.map((b) => b.c);
  const last = bars[bars.length - 1];
  const prev = bars.slice(0, -1);           // exclude the still-forming bar for extremes
  const mk = (kind: ScanSignal["kind"], detail: string): ScanSignal =>
    ({ coin: coin.name, symbol: coin.symbol, timeframe: tf.label, kind, detail, price: last.c, realertMs: tf.realertMs });

  // RSI extremes (strong only, to limit noise).
  const rsi = rsi14(closes);
  if (rsi <= 25) out.push(mk("oversold", `RSI ${rsi.toFixed(0)} oversold`));
  else if (rsi >= 75) out.push(mk("overbought", `RSI ${rsi.toFixed(0)} overbought`));

  // 20-bar high/low break (uses the last CLOSED bar's level vs the prior 20).
  const window = prev.slice(-20);
  const hh = Math.max(...window.map((b) => b.h));
  const ll = Math.min(...window.map((b) => b.l));
  if (last.c > hh) out.push(mk("breakout", `broke 20-bar high $${hh.toLocaleString()}`));
  else if (last.c < ll) out.push(mk("breakdown", `broke 20-bar low $${ll.toLocaleString()}`));

  // Recent move over ~3 bars, timeframe-scaled.
  const back = bars[Math.max(0, bars.length - 4)].c;
  const move = (last.c - back) / back;
  if (move >= tf.movePct) out.push(mk("move-up", `+${(move * 100).toFixed(1)}% in ${tf.label} bars`));
  else if (move <= -tf.movePct) out.push(mk("move-down", `${(move * 100).toFixed(1)}% in ${tf.label} bars`));

  // Volume spike: last closed bar >= 3x the trailing 20-bar average.
  const vols = prev.slice(-20).map((b) => b.v);
  const avgVol = vols.reduce((s, v) => s + v, 0) / (vols.length || 1);
  const lastClosed = prev[prev.length - 1];
  if (avgVol > 0 && lastClosed && lastClosed.v >= 3 * avgVol) {
    out.push(mk("volume-spike", `volume ${(lastClosed.v / avgVol).toFixed(1)}x average`));
  }
  return out;
}

// Scan the whole universe. Paced ~150ms/call to stay well under Kraken's public limit
// (13 coins × 4 timeframes = 52 calls ≈ 8s). A coin/timeframe that errors is skipped,
// not fatal.
export async function scanUniverse(): Promise<{ signals: ScanSignal[]; errors: string[] }> {
  const signals: ScanSignal[] = [];
  const errors: string[] = [];
  for (const coin of SCAN_COINS) {
    for (const tf of TIMEFRAMES) {
      try {
        const bars = await getKrakenOHLC(coin.symbol, tf.interval);
        signals.push(...evaluate(coin, tf, bars));
      } catch (e) {
        errors.push(`${coin.name}@${tf.label}: ${String(e).slice(0, 60)}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { signals, errors };
}

export function signalKey(s: ScanSignal): string {
  return `${s.coin}:${s.timeframe}:${s.kind}`;
}
