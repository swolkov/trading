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

// Timeframes scanned for awareness. 5m is the fastest — it's where intraday breakouts
// live, and the cron runs every 5 min so a break is caught within one bar. 1m/3m are
// deliberately excluded: at that cadence every coin trips a threshold constantly and the
// alerts become noise; those frames are for Spencer's own eyes while actively trading.
// `realertMs` is per-timeframe so a persistent condition pings once, not every scan.
interface TfSpec { interval: 5 | 15 | 60 | 240 | 1440; label: string; movePct: number; realertMs: number }
const TIMEFRAMES: TfSpec[] = [
  { interval: 5, label: "5m", movePct: 0.015, realertMs: 1 * 3600_000 },
  { interval: 15, label: "15m", movePct: 0.02, realertMs: 2 * 3600_000 },
  { interval: 60, label: "1h", movePct: 0.03, realertMs: 6 * 3600_000 },
  { interval: 240, label: "4h", movePct: 0.05, realertMs: 24 * 3600_000 },
  { interval: 1440, label: "1d", movePct: 0.07, realertMs: 48 * 3600_000 },
];

export interface ScanSignal {
  coin: string;
  symbol: string;
  timeframe: string;
  kind: "oversold" | "overbought" | "breakout" | "breakdown" | "move-up" | "move-down"
      | "volume-spike" | "vol-expansion" | "near-high" | "near-low" | "compression"
      | "liq-sweep-high" | "liq-sweep-low";
  detail: string;
  price: number;
  realertMs: number;   // how long before this exact signal may fire again
}

// Wilder ATR(14) series — used to detect a volatility regime shift (big moves starting).
function atr14(bars: KrakenBar[]): number[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { tr.push(bars[i].h - bars[i].l); continue; }
    const p = bars[i - 1].c;
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - p), Math.abs(bars[i].l - p)));
  }
  const out = new Array(bars.length).fill(NaN);
  let a = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < 14) { a += tr[i]; if (i === 13) out[i] = a / 14; }
    else out[i] = (out[i - 1] * 13 + tr[i]) / 14;
  }
  return out;
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

  // 20-bar high/low break — detected the moment the FORMING bar pierces the level, not
  // when the candle finally closes. Kraken's last OHLC row is the in-progress bar, so
  // last.h/last.l are the live intrabar extremes: this catches a breakout mid-bar rather
  // than up to a full bar late. (Awareness, so a wick poke is worth surfacing — Spencer
  // decides whether it's a real break.)
  const window = prev.slice(-20);
  const hh = Math.max(...window.map((b) => b.h));
  const ll = Math.min(...window.map((b) => b.l));
  if (last.h > hh) out.push(mk("breakout", `pierced 20-bar high $${hh.toLocaleString()}`));
  else if (last.l < ll) out.push(mk("breakdown", `pierced 20-bar low $${ll.toLocaleString()}`));

  // LIQUIDITY SWEEP (the ICT/SMC "stop hunt"): price wicked BEYOND the 20-bar extreme but
  // the live price is back INSIDE it — a FAILED break that grabbed the stops resting there.
  // The claim is to FADE it (swept high → short, swept low → long). Separate from breakout on
  // purpose: on the SAME pierce, breakout bets it holds, sweep bets it reverses — the
  // scoreboard settles which pays. (Fires alongside breakout when a pierce rejects.)
  if (last.h > hh && last.c < hh) out.push(mk("liq-sweep-high", `swept 20-bar high $${hh.toLocaleString()} and rejected`));
  else if (last.l < ll && last.c > ll) out.push(mk("liq-sweep-low", `swept 20-bar low $${ll.toLocaleString()} and reclaimed`));

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

  // COIL / COMPRESSION — the pre-breakout setup: volatility has contracted into a tight
  // range, energy building for a move. On 1h+, if ATR now is well below its own 30-bar
  // average, the coin is coiling. Awareness only — the trade is the BREAK out of the coil
  // (the breakout detector above catches it); this just says "watch this one."
  if (tf.interval >= 60 && bars.length >= 45) {
    const catr = atr14(bars);
    const atrNow = catr[catr.length - 1];
    const win = catr.slice(-31, -1).filter((x) => !isNaN(x));
    const atrAvg = win.length ? win.reduce((s, x) => s + x, 0) / win.length : NaN;
    if (atrNow > 0 && atrAvg > 0 && atrNow <= 0.55 * atrAvg) {
      out.push(mk("compression", `coiling — volatility compressed (${(atrNow / atrAvg).toFixed(2)}x normal), watch for the break`));
    }
  }

  // BIG-MOVE EARLY WARNING — only on the slower frames (4h+), where these mean a regime
  // shift rather than noise. These don't predict direction; they flag that conditions for
  // a large move are HERE (act as it breaks, don't forecast the top/bottom).
  if (tf.interval >= 240 && bars.length >= 60) {
    // Volatility expansion: ATR now vs its own 30-bar average. A sharp jump = the market
    // just woke up — the environment where 78k→120k-type moves actually happen.
    const atr = atr14(bars);
    const atrNow = atr[atr.length - 1];
    const atrAvg = atr.slice(-31, -1).filter((x) => !isNaN(x)).reduce((s, x, _, arr) => s + x / arr.length, 0);
    if (atrNow > 0 && atrAvg > 0 && atrNow >= 1.8 * atrAvg) {
      out.push(mk("vol-expansion", `volatility expanding (${(atrNow / atrAvg).toFixed(1)}x normal) — big-move conditions`));
    }
    // Near a multi-period extreme: within 2% of the highest high / lowest low of the last
    // 90 bars (≈3 months on the daily). A decision zone — breaks from here tend to run.
    const win = bars.slice(-90);
    const hh = Math.max(...win.map((b) => b.h));
    const ll = Math.min(...win.map((b) => b.l));
    if (hh > 0 && last.c >= hh * 0.98) out.push(mk("near-high", `within 2% of its ${tf.label === "1d" ? "3-month" : "recent"} high $${hh.toLocaleString()}`));
    else if (ll > 0 && last.c <= ll * 1.02) out.push(mk("near-low", `within 2% of its ${tf.label === "1d" ? "3-month" : "recent"} low $${ll.toLocaleString()}`));
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

// CONVICTION SCORE — the automated stand-in for "how confident are we in this one".
// A human's gut isn't in the loop when the machine places every trade, so conviction has
// to be something measurable: how many INDEPENDENT things line up behind the break. More
// confluence = higher conviction. This is a hypothesis to TEST, not a proven edge — the
// shadow buckets results by tier so we can see whether high-conviction breaks actually win
// more than weak ones. If they do, that's the edge worth sizing into; if not, we learn it free.
//
//   +2  each ADDITIONAL timeframe of the same coin breaking the same way (multi-TF agreement)
//   +2  a volume spike on the coin (real participation behind the move)
//   +1  momentum in the same direction (move-up for a breakout, move-down for a breakdown)
//   +1  at a decision zone — near a multi-month high/low, where breaks tend to run
//   +1  volatility expanding — a regime shift, the environment big moves happen in
//   −2  stretched against the trade (overbought on a long / oversold on a short) — less room
//   tiers: high ≥4, med ≥2, else low.
export interface Conviction { tier: "low" | "med" | "high"; score: number; factors: string[] }
export function scoreConviction(sig: ScanSignal, all: ScanSignal[]): Conviction {
  const bull = sig.kind === "breakout";
  const same = all.filter((s) => s.coin === sig.coin);
  const has = (k: ScanSignal["kind"]) => same.some((s) => s.kind === k);
  const factors: string[] = [];
  let score = 0;

  const agreeKind: ScanSignal["kind"] = bull ? "breakout" : "breakdown";
  const tfAgree = new Set(same.filter((s) => s.kind === agreeKind).map((s) => s.timeframe));
  if (tfAgree.size > 1) { const n = tfAgree.size - 1; score += n * 2; factors.push(`${tfAgree.size} timeframes breaking`); }
  if (has("volume-spike")) { score += 2; factors.push("volume confirms"); }
  if (has(bull ? "move-up" : "move-down")) { score += 1; factors.push("momentum aligned"); }
  if (has(bull ? "near-high" : "near-low")) { score += 1; factors.push("at decision zone"); }
  if (has("vol-expansion")) { score += 1; factors.push("volatility expanding"); }
  if (has(bull ? "overbought" : "oversold")) { score -= 2; factors.push("stretched (−)"); }

  const tier = score >= 4 ? "high" : score >= 2 ? "med" : "low";
  return { tier, score, factors };
}
