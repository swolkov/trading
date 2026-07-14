/**
 * CRYPTO INTRADAY DAY-TRADE RESEARCH — does an active day-trade strategy beat holding,
 * NET OF KRAKEN FEES, on BTC/ETH? Decides whether to switch the live $500 Kraken account
 * off its 50-day trend follower.
 *
 * READ-ONLY research. Writes nothing but console output.
 *
 * DATA: data/MBT_1m.csv (micro-BTC futures) and data/MET_1m.csv (micro-ETH futures),
 *   1-min bars 2022-05-26 → 2026-05-25 (~4y). Futures track spot closely = fine proxies.
 *   Crypto trades 24/7 so we use ALL hours (no RTH filter).
 *
 * METHOD (see task spec):
 *   1. Resample 1m → 5m, 15m, 1h.
 *   2. Entry styles (LONG and SHORT where realistic): momentum/trend-continuation,
 *      mean-reversion (RSI), breakout (N-bar range), dip-buy/sell-high (prior loser baseline),
 *      VWAP reversion. Plus a random-entry sanity baseline.
 *   3. Exits: 1.5-ATR stop with {2.5, 1.5}-ATR targets + time-exit after N bars.
 *      Intrabar STOP-FIRST on ambiguous bars. One position per coin at a time.
 *   4. IS = 2022-06 → 2024-06 ; OOS = 2024-07 → 2026-05. Report each separately.
 *      Edge only counts if positive NET OF FEES in BOTH periods.
 *   5. Benchmarks over OOS: BTC buy&hold, ETH buy&hold, 50-day-SMA trend follower.
 *   6. Metrics per variant/period: #trades, WR, PF, net avg%/trade, net total%, maxDD — all NET.
 *   7. Report trades/month (turnover kills after fees).
 *
 * FEES — Kraken spot <$50k volume: 0.25% maker / 0.40% taker PER SIDE.
 *   Round trip: ~0.50% (maker/limit) to ~0.80% (taker/market).
 *   We compute EVERY variant's net at BOTH fee levels and report separately.
 *
 * SHORTS: shorting spot on Kraken is not realistic for a $500 cash account (margin/borrow),
 *   so SHORT variants are clearly flagged as "not realistic on spot — reference only".
 *
 * Indicator math (ema/rsi/atr) is copied verbatim from scripts/backtest.ts (engine-identical).
 *
 * Run: npx tsx scripts/crypto-daytrade-research.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================ indicators (verbatim from scripts/backtest.ts) ============================
function emaSeries(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
}
// RSI as a full series (Wilder-style, matches engine's incremental behavior closely enough for research)
function rsiSeries(c: number[], p = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= p) {
      ag += g; al += l;
      if (i === p) { ag /= p; al /= p; out.push(100 - 100 / (1 + ag / (al || 1e-9))); }
      else out.push(null);
    } else {
      ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p;
      out.push(100 - 100 / (1 + ag / (al || 1e-9)));
    }
  }
  return out;
}
function atrSeries(b: Bar[], p = 14): number[] {
  const tr: number[] = [b[0].h - b[0].l];
  for (let i = 1; i < b.length; i++)
    tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
  const out: number[] = []; let a = tr[0];
  for (let i = 0; i < tr.length; i++) { a = i === 0 ? tr[0] : (a * (p - 1) + tr[i]) / p; out.push(a); }
  return out;
}
function smaAt(a: number[], p: number, i: number): number | null {
  if (i < p - 1) return null;
  let s = 0; for (let k = i - p + 1; k <= i; k++) s += a[k];
  return s / p;
}

// ============================ data types & loading ============================
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");

// Load 1-min CSV → Bar[] (streaming line parse to stay memory-light on ~1M rows).
function load1m(file: string): Bar[] {
  const raw = fs.readFileSync(path.join(DATA, file), "utf8");
  const bars: Bar[] = [];
  let nl = raw.indexOf("\n"); // skip header
  let start = nl + 1;
  while (start < raw.length) {
    nl = raw.indexOf("\n", start);
    const end = nl === -1 ? raw.length : nl;
    const line = raw.slice(start, end);
    start = end + 1;
    if (!line) continue;
    // ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume
    const p = line.split(",");
    if (p.length < 9) continue;
    const t = Date.parse(p[0]);
    const o = +p[4], h = +p[5], l = +p[6], c = +p[7], v = +p[8];
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    bars.push({ t, o, h, l, c, v });
    if (nl === -1) break;
  }
  return bars;
}

// Resample 1-min bars to a coarser timeframe (minutes). Bucket by floor(t / tfMs).
function resample(bars: Bar[], tfMin: number): Bar[] {
  const tfMs = tfMin * 60_000;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curKey = -1;
  for (const b of bars) {
    const key = Math.floor(b.t / tfMs);
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { t: key * tfMs, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      curKey = key;
    } else if (cur) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ============================ fee model ============================
// Round-trip fee applied on notional. Two levels: maker 0.50%, taker 0.80%.
const FEE_MAKER = 0.0050; // 0.25%/side * 2
const FEE_TAKER = 0.0080; // 0.40%/side * 2

// ============================ signal generation ============================
// A "signal" is a decision at the CLOSE of bar i to enter at bar i+1's open, with a direction.
// dir = +1 long, -1 short.
type Dir = 1 | -1;
interface Signal { i: number; dir: Dir; }

// Precomputed indicator context for a bar series.
interface Ctx {
  c: number[]; h: number[]; l: number[]; o: number[];
  ema9: number[]; ema21: number[]; ema50: number[]; ema200: number[];
  rsi: (number | null)[];
  atr: number[];
  // rolling VWAP (session-less, 20-bar rolling as a simple intraday reference)
  vwap20: number[];
}
function buildCtx(b: Bar[]): Ctx {
  const c = b.map(x => x.c), h = b.map(x => x.h), l = b.map(x => x.l), o = b.map(x => x.o);
  const vwap20: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const from = Math.max(0, i - 19);
    let pv = 0, vv = 0;
    for (let k = from; k <= i; k++) { const tp = (b[k].h + b[k].l + b[k].c) / 3; pv += tp * b[k].v; vv += b[k].v; }
    vwap20.push(vv > 0 ? pv / vv : c[i]);
  }
  return {
    c, h, l, o,
    ema9: emaSeries(c, 9), ema21: emaSeries(c, 21), ema50: emaSeries(c, 50), ema200: emaSeries(c, 200),
    rsi: rsiSeries(c, 14), atr: atrSeries(b, 14), vwap20,
  };
}

// --- entry styles. Each returns per-bar signal (or null). We only emit at bar i for entry at i+1. ---
// a. Momentum / trend-continuation: EMA9>EMA21>EMA50 (up-stack) and price pulls to/above EMA9, RSI 50-70.
//    SHORT mirror: down-stack + RSI 30-50.
function sigMomentum(x: Ctx, i: number): Dir | null {
  if (i < 200) return null;
  const r = x.rsi[i]; if (r == null) return null;
  const up = x.ema9[i] > x.ema21[i] && x.ema21[i] > x.ema50[i];
  const dn = x.ema9[i] < x.ema21[i] && x.ema21[i] < x.ema50[i];
  // continuation: momentum turning back up after a shallow dip in an uptrend
  if (up && r > 50 && r < 70 && x.c[i] > x.ema9[i] && x.c[i - 1] <= x.ema9[i - 1]) return 1;
  if (dn && r < 50 && r > 30 && x.c[i] < x.ema9[i] && x.c[i - 1] >= x.ema9[i - 1]) return -1;
  return null;
}
// b. Mean-reversion: RSI<30 long (oversold bounce) / RSI>70 short (overbought fade).
function sigMeanRev(x: Ctx, i: number): Dir | null {
  const r = x.rsi[i]; if (r == null) return null;
  const rp = x.rsi[i - 1];
  if (rp == null) return null;
  // cross UP through 30 (oversold turning) → long ; cross DOWN through 70 → short
  if (rp < 30 && r >= 30) return 1;
  if (rp > 70 && r <= 70) return -1;
  return null;
}
// c. Breakout: close breaks N-bar high → long ; breaks N-bar low → short. N=20.
function sigBreakout(x: Ctx, i: number, N = 20): Dir | null {
  if (i < N) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = i - N; k < i; k++) { hi = Math.max(hi, x.h[k]); lo = Math.min(lo, x.l[k]); }
  if (x.c[i] > hi) return 1;
  if (x.c[i] < lo) return -1;
  return null;
}
// d. Dip-buy / sell-high (prior LOSER baseline): buy a red bar below a recent low ; sell a green bar above a recent high.
function sigDipBuy(x: Ctx, i: number, N = 20): Dir | null {
  if (i < N) return null;
  let lo = Infinity, hi = -Infinity;
  for (let k = i - N; k < i; k++) { lo = Math.min(lo, x.l[k]); hi = Math.max(hi, x.h[k]); }
  if (x.c[i] < lo && x.c[i] < x.o[i]) return 1;   // new low, red bar → dip buy
  if (x.c[i] > hi && x.c[i] > x.o[i]) return -1;  // new high, green bar → sell high
  return null;
}
// e. VWAP reversion: price stretched below rolling VWAP by >0.75 ATR → long back to VWAP; above → short.
function sigVwapRev(x: Ctx, i: number): Dir | null {
  if (i < 20) return null;
  const a = x.atr[i]; if (!(a > 0)) return null;
  const d = x.c[i] - x.vwap20[i];
  if (d < -0.75 * a) return 1;
  if (d > 0.75 * a) return -1;
  return null;
}

// Random-entry sanity baseline (seeded, deterministic). ~1 entry every `spacing` bars, random dir.
function makeRandom(spacing: number, seed = 12345) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  return (i: number): Dir | null => {
    if (i < 200) return null;
    if (i % spacing !== 0) return null;
    return rnd() < 0.5 ? 1 : -1;
  };
}

// ============================ trade simulation ============================
interface Trade { entryT: number; dir: Dir; entry: number; exit: number; grossRet: number; outcome: string; }

interface ExitCfg { stopATR: number; targetATR: number; timeBars: number; }

// Simulate one strategy over a series. signalFn(ctx,i) → Dir|null at close of i, enter at i+1 open.
// grossRet is signed simple return in the trade direction (before fees).
function simulate(b: Bar[], x: Ctx, signalFn: (i: number) => Dir | null, cfg: ExitCfg): Trade[] {
  const trades: Trade[] = [];
  let blockUntil = -1; // index; one position at a time
  const n = b.length;
  for (let i = 0; i < n - 1; i++) {
    if (i <= blockUntil) continue;
    const dir = signalFn(i);
    if (!dir) continue;
    const a = x.atr[i];
    if (!(a > 0)) continue;
    const entryIdx = i + 1;
    const entry = b[entryIdx].o;
    const stop = dir === 1 ? entry - cfg.stopATR * a : entry + cfg.stopATR * a;
    const target = dir === 1 ? entry + cfg.targetATR * a : entry - cfg.targetATR * a;
    let exit = entry, outcome = "time", exitIdx = Math.min(n - 1, entryIdx + cfg.timeBars);
    const lastBar = Math.min(n - 1, entryIdx + cfg.timeBars);
    for (let j = entryIdx; j <= lastBar; j++) {
      const bar = b[j];
      if (dir === 1) {
        const hitStop = bar.l <= stop, hitTgt = bar.h >= target;
        if (hitStop && hitTgt) { exit = stop; outcome = "stop(ambig)"; exitIdx = j; break; } // stop first
        if (hitStop) { exit = stop; outcome = "stop"; exitIdx = j; break; }
        if (hitTgt) { exit = target; outcome = "target"; exitIdx = j; break; }
      } else {
        const hitStop = bar.h >= stop, hitTgt = bar.l <= target;
        if (hitStop && hitTgt) { exit = stop; outcome = "stop(ambig)"; exitIdx = j; break; }
        if (hitStop) { exit = stop; outcome = "stop"; exitIdx = j; break; }
        if (hitTgt) { exit = target; outcome = "target"; exitIdx = j; break; }
      }
      exit = bar.c; exitIdx = j; // running close → becomes time exit if no stop/target
    }
    const grossRet = dir === 1 ? (exit - entry) / entry : (entry - exit) / entry;
    trades.push({ entryT: b[entryIdx].t, dir, entry, exit, grossRet, outcome });
    blockUntil = exitIdx; // block until the real exit bar (one position/coin at a time)
  }
  return trades;
}

// ============================ metrics (net of a given round-trip fee) ============================
interface Metrics { n: number; wr: number; pf: number; avgPct: number; totalPct: number; maxDD: number; }
function metrics(trades: Trade[], feeRT: number): Metrics {
  const n = trades.length;
  if (!n) return { n: 0, wr: 0, pf: 0, avgPct: 0, totalPct: 0, maxDD: 0 };
  let eq = 1, peak = 1, dd = 0, gp = 0, gl = 0, wins = 0, sum = 0;
  for (const t of trades) {
    const r = t.grossRet - feeRT; // subtract round-trip fee on notional
    sum += r;
    if (r > 0) { wins++; gp += r; } else gl += -r;
    eq *= (1 + r);
    peak = Math.max(peak, eq);
    dd = Math.max(dd, (peak - eq) / peak);
  }
  return {
    n, wr: wins / n,
    pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0),
    avgPct: (sum / n) * 100,
    totalPct: (eq - 1) * 100,
    maxDD: dd * 100,
  };
}

// ============================ benchmarks (OOS window) ============================
function buyHoldPct(daily: Bar[], from: number, to: number): number {
  const seg = daily.filter(d => d.t >= from && d.t <= to);
  if (seg.length < 2) return 0;
  return (seg[seg.length - 1].c / seg[0].c - 1) * 100;
}
// 50-day SMA trend follower on daily closes: hold when close>SMA50, cash otherwise. Net of fee per switch.
function sma50Trend(daily: Bar[], from: number, to: number, feeRT: number): { totalPct: number; switches: number; maxDD: number } {
  const seg = daily.filter(d => d.t >= from - 60 * 86400_000 && d.t <= to); // warmup 60d before window
  const c = seg.map(d => d.c);
  let eq = 1, inPos = false, switches = 0, peak = 1, dd = 0;
  for (let i = 0; i < seg.length; i++) {
    const m = smaAt(c, 50, i);
    if (m == null) continue;
    if (seg[i].t < from) { // just track position state during warmup, no eq accounting
      inPos = c[i] > m;
      continue;
    }
    // daily return of holding from i-1 to i, if in position at start of day
    if (i > 0 && inPos) {
      eq *= c[i] / c[i - 1];
    }
    const want = c[i] > m;
    if (want !== inPos) { eq *= (1 - feeRT / 2); switches++; inPos = want; } // one side fee per switch (~half round trip)
    peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
  }
  return { totalPct: (eq - 1) * 100, switches, maxDD: dd * 100 };
}

// ============================ periods ============================
const IS_START = Date.UTC(2022, 5, 1);  // 2022-06
const IS_END = Date.UTC(2024, 5, 30, 23, 59);   // 2024-06
const OOS_START = Date.UTC(2024, 6, 1); // 2024-07
const OOS_END = Date.UTC(2026, 4, 25, 23, 59);  // 2026-05-25

function inIS(t: number) { return t >= IS_START && t <= IS_END; }
function inOOS(t: number) { return t >= OOS_START && t <= OOS_END; }
function monthsBetween(a: number, bb: number) { return (bb - a) / (365.25 / 12 * 86400_000); }

// ============================ main ============================
const STYLES: { name: string; fn: (x: Ctx, i: number) => Dir | null; shortRealistic: boolean }[] = [
  { name: "momentum", fn: sigMomentum, shortRealistic: false },
  { name: "meanrev", fn: sigMeanRev, shortRealistic: false },
  { name: "breakout", fn: sigBreakout, shortRealistic: false },
  { name: "dipbuy", fn: sigDipBuy, shortRealistic: false },
  { name: "vwaprev", fn: sigVwapRev, shortRealistic: false },
];
const EXITS: { name: string; cfg: ExitCfg }[] = [
  { name: "1.5s/2.5t", cfg: { stopATR: 1.5, targetATR: 2.5, timeBars: 24 } },
  { name: "1.5s/1.5t", cfg: { stopATR: 1.5, targetATR: 1.5, timeBars: 24 } },
  // wider stop + wider target + longer hold: gives edge room above the fee floor
  { name: "3s/5t/48", cfg: { stopATR: 3.0, targetATR: 5.0, timeBars: 48 } },
];
const TFS = [
  { name: "5m", min: 5 },
  { name: "15m", min: 15 },
  { name: "1h", min: 60 },
];

interface Row {
  coin: string; tf: string; style: string; exit: string; side: string;
  isM: Metrics; oosM: Metrics; isTpm: number; oosTpm: number;
}

function run() {
  console.log("\n" + "=".repeat(110));
  console.log("  CRYPTO INTRADAY DAY-TRADE RESEARCH — BTC/ETH, fee-aware, IS vs OOS");
  console.log("  Fees: MAKER round-trip 0.50% | TAKER round-trip 0.80% (Kraken <$50k tier)");
  console.log("  IS 2022-06→2024-06 | OOS 2024-07→2026-05");
  console.log("=".repeat(110));

  const coins: { name: string; file: string }[] = [
    { name: "BTC", file: "MBT_1m.csv" },
    { name: "ETH", file: "MET_1m.csv" },
  ];

  const rows: Row[] = [];
  const benchmarks: Record<string, { bh: number; trendMaker: number; trendTaker: number; trendSwitches: number; trendDD: number }> = {};

  for (const coin of coins) {
    console.log(`\nLoading ${coin.name} (${coin.file}) ...`);
    const m1 = load1m(coin.file);
    console.log(`  ${m1.length} 1-min bars  ${new Date(m1[0].t).toISOString().slice(0,10)} → ${new Date(m1[m1.length-1].t).toISOString().slice(0,10)}`);

    // daily for benchmarks
    const daily = resample(m1, 1440);
    const bh = buyHoldPct(daily, OOS_START, OOS_END);
    const trM = sma50Trend(daily, OOS_START, OOS_END, FEE_MAKER);
    const trT = sma50Trend(daily, OOS_START, OOS_END, FEE_TAKER);
    benchmarks[coin.name] = { bh, trendMaker: trM.totalPct, trendTaker: trT.totalPct, trendSwitches: trM.switches, trendDD: trM.maxDD };

    for (const tf of TFS) {
      const b = resample(m1, tf.min);
      const x = buildCtx(b);
      const isBars = b.filter(bb => inIS(bb.t)).length;
      const oosBars = b.filter(bb => inOOS(bb.t)).length;
      const isMonths = monthsBetween(IS_START, IS_END);
      const oosMonths = monthsBetween(OOS_START, OOS_END);

      for (const style of STYLES) {
        for (const exit of EXITS) {
          // LONG-ONLY (realistic on spot): only take dir=+1 signals
          // FULL (long+short): reference only, shorting spot not realistic
          const allTrades = simulate(b, x, (i) => style.fn(x, i), exit.cfg);
          const longTrades = allTrades.filter(t => t.dir === 1);

          for (const [side, trs, realistic] of [
            ["long", longTrades, true] as const,
            ["l+s", allTrades, false] as const,
          ]) {
            const isTr = trs.filter(t => inIS(t.entryT));
            const oosTr = trs.filter(t => inOOS(t.entryT));
            rows.push({
              coin: coin.name, tf: tf.name, style: style.name, exit: exit.name,
              side: realistic ? side : side + "*",
              isM: metrics(isTr, FEE_MAKER),   // headline uses MAKER; taker computed on demand below
              oosM: metrics(oosTr, FEE_MAKER),
              isTpm: isTr.length / isMonths,
              oosTpm: oosTr.length / oosMonths,
            });
          }
        }
      }
      // random baseline (long-only)
      for (const spacing of [50]) {
        const rnd = makeRandom(spacing);
        const trs = simulate(b, x, (i) => rnd(i), EXITS[0].cfg).filter(t => t.dir === 1);
        const isTr = trs.filter(t => inIS(t.entryT)), oosTr = trs.filter(t => inOOS(t.entryT));
        rows.push({
          coin: coin.name, tf: tf.name, style: `RANDOM/${spacing}`, exit: EXITS[0].name, side: "long",
          isM: metrics(isTr, FEE_MAKER), oosM: metrics(oosTr, FEE_MAKER),
          isTpm: isTr.length / monthsBetween(IS_START, IS_END), oosTpm: oosTr.length / monthsBetween(OOS_START, OOS_END),
        });
      }
      console.log(`  ${tf.name}: ${b.length} bars (IS ${isBars}, OOS ${oosBars})`);
    }
  }

  // ---- benchmarks table ----
  console.log("\n" + "=".repeat(110));
  console.log("BENCHMARKS over OOS (2024-07 → 2026-05):");
  console.log("=".repeat(110));
  console.log("  coin | buy&hold total% | 50d-trend total% (maker) | (taker) | switches | trend maxDD%");
  for (const c of Object.keys(benchmarks)) {
    const bm = benchmarks[c];
    console.log(`  ${c.padEnd(4)} | ${bm.bh.toFixed(1).padStart(14)} | ${bm.trendMaker.toFixed(1).padStart(23)} | ${bm.trendTaker.toFixed(1).padStart(6)} | ${String(bm.trendSwitches).padStart(8)} | ${bm.trendDD.toFixed(1).padStart(11)}`);
  }

  // ---- full results table (long-only realistic first) ----
  const fmtM = (m: Metrics) => `${String(m.n).padStart(4)} ${(m.wr*100).toFixed(0).padStart(3)}% PF${m.pf.toFixed(2).padStart(5)} avg${(m.avgPct>=0?"+":"")+m.avgPct.toFixed(3)}% tot${(m.totalPct>=0?"+":"")+m.totalPct.toFixed(0)}% dd${m.maxDD.toFixed(0)}%`;

  // GROSS (zero-fee) check — is ANY variant positive BEFORE fees? If not, fees aren't even the issue.
  console.log("\n" + "=".repeat(110));
  console.log("GROSS (ZERO-FEE) SANITY — long-only OOS variants with POSITIVE gross avg%/trade (edge exists before fees?):");
  console.log("  If a variant clears fees: gross avg%/t must exceed 0.50% (maker) to net positive.");
  console.log("=".repeat(110));
  {
    let anyPos = false;
    for (const coin of coins) {
      const m1 = load1m(coin.file);
      for (const tf of TFS) {
        const b = resample(m1, tf.min);
        const x = buildCtx(b);
        for (const style of STYLES) {
          for (const exit of EXITS) {
            const trs = simulate(b, x, (i) => style.fn(x, i), exit.cfg).filter(t => t.dir === 1);
            const oosTr = trs.filter(t => inOOS(t.entryT));
            const isTr = trs.filter(t => inIS(t.entryT));
            if (oosTr.length < 20 || isTr.length < 20) continue;
            const gOos = metrics(oosTr, 0), gIs = metrics(isTr, 0);
            if (gOos.avgPct > 0) {
              anyPos = true;
              const clearsMaker = gOos.avgPct > 0.50 && gIs.avgPct > 0.50;
              console.log(`  ${coin.name} ${tf.name.padEnd(3)} ${style.name.padEnd(9)} ${exit.name.padEnd(9)} | GROSS OOS avg+${gOos.avgPct.toFixed(3)}%/t PF${gOos.pf.toFixed(2)} (n${oosTr.length}) | GROSS IS avg${gIs.avgPct>=0?"+":""}${gIs.avgPct.toFixed(3)}%/t PF${gIs.pf.toFixed(2)}${clearsMaker?"  <<< CLEARS MAKER FEE BOTH":""}`);
            }
          }
        }
      }
    }
    if (!anyPos) console.log("  NONE — not a single long-only variant is even gross-positive OOS. No edge exists BEFORE fees.");
  }

  console.log("\n" + "=".repeat(110));
  console.log("ALL VARIANTS — LONG-ONLY (spot-realistic), NET OF MAKER 0.50% round-trip:");
  console.log("  cols: [n WR PF avg%/t total% maxDD]  (tpm = trades/month)");
  console.log("=".repeat(110));
  console.log("coin tf   style        exit       side |  IS: " + " ".repeat(30) + " | OOS:");
  const longRows = rows.filter(r => !r.side.includes("*") && r.side === "long");
  for (const r of longRows) {
    console.log(
      `${r.coin.padEnd(4)} ${r.tf.padEnd(4)} ${r.style.padEnd(11)} ${r.exit.padEnd(9)} ${r.side.padEnd(4)} | ` +
      `IS ${fmtM(r.isM)} tpm${r.isTpm.toFixed(1)} | OOS ${fmtM(r.oosM)} tpm${r.oosTpm.toFixed(1)}`
    );
  }

  // ---- reference: long+short (not realistic on spot) ----
  console.log("\n" + "-".repeat(110));
  console.log("REFERENCE ONLY — LONG+SHORT (shorting spot NOT realistic on a $500 Kraken cash acct), NET MAKER 0.50%:");
  console.log("-".repeat(110));
  for (const r of rows.filter(rr => rr.side.includes("*"))) {
    console.log(
      `${r.coin.padEnd(4)} ${r.tf.padEnd(4)} ${r.style.padEnd(11)} ${r.exit.padEnd(9)} ${r.side.padEnd(4)} | ` +
      `IS ${fmtM(r.isM)} | OOS ${fmtM(r.oosM)}`
    );
  }

  // ---- WINNERS: positive net (maker) in BOTH IS and OOS, long-only, PF>1 both, avg%/t>0 both ----
  console.log("\n" + "=".repeat(110));
  console.log("CANDIDATE EDGES — long-only, NET MAKER 0.50%, POSITIVE in BOTH IS and OOS (avg%/t>0 & PF>1 both):");
  console.log("=".repeat(110));
  const winners = longRows.filter(r =>
    r.isM.n >= 20 && r.oosM.n >= 20 &&
    r.isM.avgPct > 0 && r.oosM.avgPct > 0 && r.isM.pf > 1 && r.oosM.pf > 1
  );
  if (!winners.length) {
    console.log("  NONE. No long-only intraday variant is net-positive in both IS and OOS after maker fees.");
  } else {
    for (const r of winners) {
      console.log(`  [CANDIDATE] ${r.coin} ${r.tf} ${r.style} ${r.exit} | IS ${fmtM(r.isM)} | OOS ${fmtM(r.oosM)} | oos tpm ${r.oosTpm.toFixed(1)}`);
    }
    console.log("\n  ^ Now re-check these under TAKER 0.80% (market orders) — recompute:");
    // recompute winners' OOS under taker by re-simulating (cheap: we only need the trades again)
    console.log("    (see TAKER re-check block below)");
  }

  // ---- TAKER re-check: recompute every long-only variant's IS/OOS net under 0.80% ----
  // We re-simulate to get trades then apply taker fee.
  console.log("\n" + "=".repeat(110));
  console.log("TAKER 0.80% re-check — long-only variants, avg%/t under taker (market orders):");
  console.log("  If a variant is positive under maker but negative under taker, it needs perfect limit fills to survive.");
  console.log("=".repeat(110));
  for (const coin of coins) {
    const m1 = load1m(coin.file);
    for (const tf of TFS) {
      const b = resample(m1, tf.min);
      const x = buildCtx(b);
      for (const style of STYLES) {
        for (const exit of EXITS) {
          const trs = simulate(b, x, (i) => style.fn(x, i), exit.cfg).filter(t => t.dir === 1);
          const isTr = trs.filter(t => inIS(t.entryT)), oosTr = trs.filter(t => inOOS(t.entryT));
          const isMk = metrics(isTr, FEE_MAKER).avgPct, isTk = metrics(isTr, FEE_TAKER).avgPct;
          const ooMk = metrics(oosTr, FEE_MAKER).avgPct, ooTk = metrics(oosTr, FEE_TAKER).avgPct;
          // only print variants where maker OOS is positive (the interesting ones)
          if (ooMk > 0 && oosTr.length >= 20) {
            console.log(`  ${coin.name} ${tf.name.padEnd(3)} ${style.name.padEnd(10)} ${exit.name.padEnd(9)} | OOS avg%/t maker ${ooMk>=0?"+":""}${ooMk.toFixed(3)} → taker ${ooTk>=0?"+":""}${ooTk.toFixed(3)} (n=${oosTr.length})  IS maker ${isMk>=0?"+":""}${isMk.toFixed(3)}/taker ${isTk>=0?"+":""}${isTk.toFixed(3)}`);
          }
        }
      }
    }
  }

  // ---- best long-only variant by OOS avg%/t (maker) with sufficient sample ----
  console.log("\n" + "=".repeat(110));
  console.log("BEST long-only variants by OOS net avg%/trade (maker), n>=20:");
  console.log("=".repeat(110));
  const ranked = [...longRows].filter(r => r.oosM.n >= 20 && !r.style.startsWith("RANDOM"))
    .sort((a, bb) => bb.oosM.avgPct - a.oosM.avgPct).slice(0, 12);
  for (const r of ranked) {
    console.log(`  ${r.coin} ${r.tf.padEnd(3)} ${r.style.padEnd(10)} ${r.exit.padEnd(9)} | OOS ${fmtM(r.oosM)} tpm${r.oosTpm.toFixed(1)} | IS ${fmtM(r.isM)}`);
  }

  console.log("\n" + "=".repeat(110));
  console.log("CAVEATS: BTC/ETH only; micro-futures as spot proxy; fees 0.50% maker / 0.80% taker round-trip;");
  console.log("  no funding/borrow cost modeled for shorts (and shorting spot isn't realistic on a $500 cash acct);");
  console.log("  1-min→resampled bars, stop-first on ambiguous bars, one position/coin; no slippage beyond fee haircut.");
  console.log("=".repeat(110) + "\n");
}

run();
