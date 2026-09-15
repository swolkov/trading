// Server-side margin scanner — watches every liquid margin coin across timeframes and
// surfaces notable technical events for AWARENESS. This is the "brain that watches
// everything" without Spencer hand-placing hundreds of alerts.
//
// ⚠️ AWARENESS ONLY. It pushes to Slack and logs to the DB; it NEVER calls the executor.
// Every mechanical signal family we tested (17 of them) lost out-of-sample, so auto-
// trading these would just automate losing. The scanner's job is to put Spencer's eyes
// on the right chart at the right moment and to build a scored record — not to trade.
import { getKrakenOHLC, type KrakenBar } from "@/lib/kraken-margin";
import { SCAN_UNIVERSE } from "@/lib/kraken-pairs";

// THE SCAN UNIVERSE = the US-retail margin list (kraken-pairs.ts US_MARGIN_MAX_LEVERAGE),
// minus the two that don't move (USDC stablecoin, PAXG gold) — derived from that one
// table (SCAN_UNIVERSE), so the scanner cannot drift from what the live book can trade.
//
// ⚠️ HISTORY, do not repeat: from Sep 1–5 2026 this list held 37 coins curated from
// Kraken's public AssetPairs (the INTERNATIONAL product). 19 of them — BNB XMR TIA TON APT
// ICP INJ ARB OP ATOM ETC FIL POL ONDO BONK WLD JUP STX PYTH — cannot be margin-traded by a
// US retail account at all. They produced 170 of 266 resolved paper trades and −$12.7k
// while the 18 tradeable coins netted +$3.5k. The record was measuring a universe live
// could never run. Watching what you cannot trade is not "free": it fills the sample with
// the wrong population. Spreads re-checked Sep 5 (all < 0.10%); candles verified for
// every new name.
// 26 coins (Sep 5 2026): BTC ETH SOL XRP DOGE ADA AVAX LINK LTC SUI · AAVE BCH CRV DOT HBAR
// HYPE PEPE SHIB TRX UNI ZEC · PENGU NEAR RENDER ALGO XLM.
export const SCAN_COINS: { name: string; symbol: string }[] = SCAN_UNIVERSE.map((name) => ({ name, symbol: `${name}/USD` }));

// Timeframes scanned for awareness. 5m is the fastest — it's where intraday breakouts
// live, and the cron runs every 5 min so a break is caught within one bar. 1m/3m are
// deliberately excluded: at that cadence every coin trips a threshold constantly and the
// alerts become noise; those frames are for Spencer's own eyes while actively trading.
// `realertMs` is per-timeframe so a persistent condition pings once, not every scan.
export interface TfSpec { interval: 5 | 15 | 60 | 240 | 1440; label: string; movePct: number; realertMs: number }
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
  // On breakout / breakdown signals only (Sep 15 2026, the C5 twins): the pierced 20-bar level
  // (swing-retest waits for its retest) and ATR14 ÷ close at signal time (swing-atr's stop).
  level?: number;
  atrFrac?: number;
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

// ---------- BAR FEATURES (intel foundation, Sep 15 2026) ----------
// The scanner fetched 130 bar series per tick and kept only the signals. These are the plain
// numbers the intelligence layer stamps on paper rows (multi-timeframe direction, regime,
// opportunity score) and that the desk brief reads — computed ONCE per fetch, never a second
// call. Pure, never mutates `bars`, NaN where under-sampled. evaluate() and scoreConviction()
// do not read this and are unchanged — pinned by test.
export interface TfFeatures {
  close: number;
  ret1: number;           // close ÷ the previous bar's close − 1 (the forming bar's move so far)
  sma20: number;          // mean of the last 20 closes (the forming bar included)
  prevClose20: number;    // the close 20 bars ago — with sma20 gives the direction stamp
  hh20: number; ll20: number;   // extremes of the 20 COMPLETED bars, as evaluate() reads them
  hh90: number; ll90: number;   // extremes of the last 90 bars (the decision zone)
  atr14: number;
  atrRatio30: number;     // ATR now ÷ its own 30-bar average (compression <0.55, expansion ≥1.8)
  volRatio20: number;     // last completed bar's volume ÷ 20-bar average
  rsi14: number;
  lastRange: number;      // (high − low) ÷ close of the forming bar
  dollarVol20: number;    // mean of volume × close over the 20 completed bars
  // DATA QUALITY. A series with a hole or a stale newest bar must not size a live order.
  gapBars: number;        // missing bars inside the last 21 (spacing > the timeframe)
  dupBars: number;        // repeated timestamps inside the last 21
  staleMs: number;        // how long past the newest bar's scheduled close `now` is (0 while forming)
  dataOk: boolean;
  dataReason: string | null;
}

export function barFeatures(bars: KrakenBar[], intervalMin: number, nowMs: number = Date.now()): TfFeatures {
  const n = bars.length;
  const last = bars[n - 1];
  const closes = bars.map((b) => b.c);
  const prev = bars.slice(0, -1);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
  const win20 = prev.slice(-20);
  const win90 = bars.slice(-90);
  const catr = n >= 15 ? atr14(bars) : [];
  const atrNow = catr.length ? catr[catr.length - 1] : NaN;
  const atrWin = catr.slice(-31, -1).filter((x) => !isNaN(x));
  const lastClosed = prev[prev.length - 1];
  const avgVol = win20.length ? mean(win20.map((b) => b.v)) : NaN;
  // Data quality over the last 21 bars: consecutive timestamps must differ by exactly one
  // interval (Kraken's OHLC omits empty buckets on thin pairs — that is a gap, not a bar).
  const step = intervalMin * 60;
  const tail = bars.slice(-21);
  let gapBars = 0, dupBars = 0;
  for (let i = 1; i < tail.length; i++) {
    const d = tail[i].t - tail[i - 1].t;
    if (d === 0) dupBars++;
    else if (d > step) gapBars += Math.round(d / step) - 1;
    else if (d < 0) dupBars++;   // out of order reads as a duplicate: the series is not trustworthy
  }
  const staleMs = last ? Math.max(0, nowMs - (last.t + step) * 1000) : NaN;
  let dataReason: string | null = null;
  if (n < 21) dataReason = `insufficient bars (${n})`;
  else if (dupBars > 0) dataReason = `${dupBars} duplicate bar(s) in the last 20`;
  else if (gapBars > 0) dataReason = `${gapBars} gap(s) in the last 20 bars`;
  else if (staleMs > 2 * step * 1000) dataReason = `newest bar ${Math.round(staleMs / 60_000)} min past its close (> 2× ${intervalMin}m)`;
  return {
    close: last ? last.c : NaN,
    ret1: lastClosed && lastClosed.c > 0 && last ? last.c / lastClosed.c - 1 : NaN,
    sma20: n >= 20 ? mean(closes.slice(-20)) : NaN,
    prevClose20: n >= 21 ? closes[n - 21] : NaN,
    hh20: win20.length >= 20 ? Math.max(...win20.map((b) => b.h)) : NaN,
    ll20: win20.length >= 20 ? Math.min(...win20.map((b) => b.l)) : NaN,
    hh90: win90.length ? Math.max(...win90.map((b) => b.h)) : NaN,
    ll90: win90.length ? Math.min(...win90.map((b) => b.l)) : NaN,
    atr14: atrNow,
    atrRatio30: atrWin.length && atrNow > 0 ? atrNow / mean(atrWin) : NaN,
    volRatio20: lastClosed && avgVol > 0 ? lastClosed.v / avgVol : NaN,
    rsi14: rsi14(closes),
    lastRange: last && last.c > 0 ? (last.h - last.l) / last.c : NaN,
    dollarVol20: win20.length >= 20 ? mean(win20.map((b) => b.v * b.c)) : NaN,
    gapBars, dupBars, staleMs,
    dataOk: dataReason == null,
    dataReason,
  };
}

export function evaluate(coin: { name: string; symbol: string }, tf: TfSpec, bars: KrakenBar[]): ScanSignal[] {
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
  if (last.h > hh || last.l < ll) {
    // The level and the ATR fraction ride on the directional signal for the twins that need them;
    // nothing else reads them, and scoreConviction never does (pinned by the golden test).
    const a = atr14(bars); const atrNow = a[a.length - 1];
    const atrFrac = atrNow > 0 && last.c > 0 ? atrNow / last.c : undefined;
    if (last.h > hh) out.push({ ...mk("breakout", `pierced 20-bar high $${hh.toLocaleString()}`), level: hh, ...(atrFrac != null ? { atrFrac } : {}) });
    else out.push({ ...mk("breakdown", `pierced 20-bar low $${ll.toLocaleString()}`), level: ll, ...(atrFrac != null ? { atrFrac } : {}) });
  }

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
// (26 coins × 5 timeframes = 130 calls ≈ 20s, comfortably inside the 300s cron budget).
// A coin/timeframe that errors (bad pair, thin history) is skipped, not fatal.
// Also returns the per-series FEATURES ("COIN:tf" → TfFeatures) and BTC's 5m/1h bars, from
// the same fetches — the intelligence layer reads these; the signal path is unchanged.
export interface UniverseScan { signals: ScanSignal[]; errors: string[]; features: Record<string, TfFeatures>; btcBars: { m5: KrakenBar[]; h1: KrakenBar[] } }
export async function scanUniverse(): Promise<UniverseScan> {
  const signals: ScanSignal[] = [];
  const errors: string[] = [];
  const features: Record<string, TfFeatures> = {};
  const btcBars: UniverseScan["btcBars"] = { m5: [], h1: [] };
  for (const coin of SCAN_COINS) {
    for (const tf of TIMEFRAMES) {
      try {
        const bars = await getKrakenOHLC(coin.symbol, tf.interval);
        signals.push(...evaluate(coin, tf, bars));
        try { features[`${coin.name}:${tf.label}`] = barFeatures(bars, tf.interval); } catch { /* features are additive; a bad series just has none */ }
        if (coin.name === "BTC" && tf.interval === 5) btcBars.m5 = bars;
        if (coin.name === "BTC" && tf.interval === 60) btcBars.h1 = bars;
      } catch (e) {
        errors.push(`${coin.name}@${tf.label}: ${String(e).slice(0, 60)}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { signals, errors, features, btcBars };
}

// Scan ONE coin across every timeframe — the live path's entry point into the same
// analysis the paper experiment runs. A live alert names a coin and a direction but carries
// no conviction, and conviction is what decides position size; computing it here means a
// live trade is sized off exactly the signals paper would have seen, rather than off a
// number Spencer would otherwise have to hand-type into a TradingView alert.
// ~5 OHLC calls, under a second — trivial inside the webhook's budget.
export async function scanCoin(symbol: string): Promise<{ signals: ScanSignal[]; errors: string[] }> {
  const coin = SCAN_COINS.find((c) => c.symbol.toUpperCase() === symbol.toUpperCase())
    ?? { name: symbol.split("/")[0], symbol };
  const signals: ScanSignal[] = [];
  const errors: string[] = [];
  for (const tf of TIMEFRAMES) {
    try {
      const bars = await getKrakenOHLC(coin.symbol, tf.interval);
      signals.push(...evaluate(coin, tf, bars));
    } catch (e) {
      errors.push(`${coin.name}@${tf.label}: ${String(e).slice(0, 60)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { signals, errors };
}

// Conviction for a LIVE alert, scored by the SAME scoreConviction the paper record is
// built from, so a live trade and its paper twin get the same tier in the same market.
// Returns null when the coin shows no signal in the alert's direction — an alert with
// nothing behind it. The caller MUST treat null as "no bonus", never as high.
export async function convictionForAlert(symbol: string, side: "buy" | "sell"): Promise<Conviction | null> {
  const { signals } = await scanCoin(symbol);
  if (!signals.length) return null;
  const want: ScanSignal["kind"] = side === "buy" ? "breakout" : "breakdown";
  const matches = signals.filter((s) => s.kind === want);
  if (!matches.length) return null;
  // Prefer the highest timeframe agreeing with the alert — the same preference the
  // scanner's own plan selection makes, and the most meaningful one to score.
  const order = ["1d", "4h", "1h", "15m", "5m"];
  matches.sort((a, b) => order.indexOf(a.timeframe) - order.indexOf(b.timeframe));
  return scoreConviction(matches[0], signals);
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
