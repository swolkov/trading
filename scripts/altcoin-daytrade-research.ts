/**
 * altcoin-daytrade-research.ts — rigorous test of whether an INTRADAY (day-trade)
 * strategy has a durable, fee-surviving edge on the liquid Kraken alt basket
 * (SOL, XRP, DOGE, AVAX, LINK), LONG-only, that beats buy-and-hold and a
 * 50-day-SMA trend follower.
 *
 * Data: Binance public klines (15m + 1h), fetched by scripts/altcoin-fetch.ts to
 *       /tmp/altcoin-data/*.csv. Binance USDT-pairs used as a PROXY for Kraken USD spot.
 * Helpers ema/rsi/atr are COPIED from scripts/backtest.ts (not modified there).
 *
 * Costs (Kraken alt spot, round-trip): 0.6% optimistic (maker/limit) and
 *       1.0% realistic (taker/market + wider alt spread). Results reported gross,
 *       and net at both cost levels. An edge counts ONLY if positive NET in BOTH
 *       the in-sample and out-of-sample periods.
 *
 * Run: npx tsx scripts/altcoin-daytrade-research.ts
 */
import fs from "node:fs";
import path from "node:path";

// ===================== math helpers (copied verbatim from scripts/backtest.ts) =====================
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
function ema(data: number[], period: number): number[] {
  if (!data.length) return [];
  const k = 2 / (period + 1);
  const r = [data[0]];
  for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
  return r;
}
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  const avgGain = changes.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const avgLoss = changes.filter(c => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period;
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}
// NOTE: the point-in-time `atr()` helper from backtest.ts is replaced here by a full-series
// `fullATR()` (below) computed once per coin/tf, to avoid O(n^2) slicing over ~140k bars.

// ===================== config =====================
const DATA_DIR = "/tmp/altcoin-data";
const COINS = ["SOLUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"];
const TFS = ["15m", "1h"] as const;
type TF = typeof TFS[number];
const BARS_PER_DAY: Record<TF, number> = { "15m": 96, "1h": 24 };

// split: IS = start .. mid-2024 ; OOS = mid-2024 .. present
const SPLIT_MS = Date.parse("2024-07-01T00:00:00Z");

// round-trip cost fractions
const COST_OPT = 0.006;   // 0.6% — maker/limit optimistic
const COST_REAL = 0.010;  // 1.0% — taker/market + alt spread realistic

// exit params
const ATR_STOP = 1.5;
const ATR_TARGETS = [2.5, 1.5];
const TIME_EXIT_BARS: Record<TF, number> = { "15m": 32, "1h": 24 };  // ~8h(15m) / ~1day(1h)

// ===================== load =====================
function loadBars(sym: string, tf: TF): Bar[] {
  const p = path.join(DATA_DIR, `${sym}_${tf}.csv`);
  const rows = fs.readFileSync(p, "utf8").trim().split("\n").slice(1);
  const bars: Bar[] = [];
  for (const r of rows) {
    const c = r.split(",");
    bars.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ===================== trade sim =====================
interface Trade { entryT: number; ret: number; }  // ret = gross fraction return (+/-)

const WARMUP = 60;  // bars of history needed before signals compute

// Precomputed indicator series for a bar array (computed ONCE per coin/tf — avoids O(n^2) slicing).
interface Indics {
  ema9: number[];
  ema21: number[];
  rsi14: (number | null)[];
  atr14: number[];      // ATR over trailing 14 (period as in helper) at each index
  rollHigh20: number[]; // highest high of PRIOR 20 bars (excludes current)
  rollHigh24Incl: number[]; // highest high of trailing 24 bars INCLUDING current
}

// full-series EMA reuses the helper's recurrence (already O(n))
function fullRSI(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let avgGain = 0, avgLoss = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const ch = closes[k] - closes[k - 1];
      if (ch > 0) avgGain += ch; else avgLoss += -ch;
    }
    avgGain /= period; avgLoss /= period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
function fullATR(bars: Bar[], period = 14): number[] {
  const out: number[] = new Array(bars.length).fill(0);
  const tr: number[] = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++)
    tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    sum += tr[i];
    if (i > period) sum -= tr[i - period];
    if (i >= period) out[i] = sum / period;
  }
  return out;
}
function rollingMaxPrior(bars: Bar[], N: number, includeCurrent: boolean): number[] {
  const out: number[] = new Array(bars.length).fill(-Infinity);
  for (let i = 0; i < bars.length; i++) {
    const start = i - N + (includeCurrent ? 1 : 0);
    const end = includeCurrent ? i : i - 1;
    if (start < 0) { out[i] = -Infinity; continue; }
    let hh = -Infinity;
    for (let j = start; j <= end; j++) hh = Math.max(hh, bars[j].h);
    out[i] = hh;
  }
  return out;
}
function buildIndics(bars: Bar[]): Indics {
  const closes = bars.map(b => b.c);
  return {
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    rsi14: fullRSI(closes),
    atr14: fullATR(bars),
    rollHigh20: rollingMaxPrior(bars, 20, false),
    rollHigh24Incl: rollingMaxPrior(bars, 24, true),
  };
}

// entry signal: given bars, precomputed indics, index i -> enter at close of bar i?
type EntrySignal = (bars: Bar[], ind: Indics, i: number) => boolean;

const SIGNALS: Record<string, EntrySignal> = {
  // a. Momentum / trend-continuation: fast EMA above slow, price above fast EMA, rising green bar
  momentum: (bars, ind, i) =>
    ind.ema9[i] > ind.ema21[i] && bars[i].c > ind.ema9[i] && bars[i].c > bars[i].o && bars[i].c > bars[i - 1].c,
  // b. Mean-reversion: RSI oversold (<30) + turning up (green bar)
  meanrev: (bars, ind, i) => {
    const r = ind.rsi14[i]; return r != null && r < 30 && bars[i].c > bars[i].o;
  },
  // c. Breakout: close above the highest high of the prior 20 bars
  breakout: (bars, ind, i) => ind.rollHigh20[i] > -Infinity && bars[i].c > ind.rollHigh20[i],
  // d. Dip-buy baseline: >=5% off the trailing-24 high + turning green
  dipbuy: (bars, ind, i) => {
    const hh = ind.rollHigh24Incl[i]; if (hh <= -Infinity) return false;
    return (hh - bars[i].c) / hh >= 0.05 && bars[i].c > bars[i].o;
  },
  // random sanity baseline (~2% of bars fire); seeded LCG for reproducibility
  random: (() => {
    let seed = 12345;
    return (_bars: Bar[], _ind: Indics, _i: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) < 0.02;
    };
  })(),
};

interface VariantResult {
  trades: number;
  winRate: number;
  grossAvg: number;   // gross avg %/trade
  netAvgOpt: number;  // net avg %/trade at 0.6%
  netAvgReal: number; // net at 1.0%
  grossTotal: number;
  netTotalOpt: number;
  netTotalReal: number;
  pfGross: number;
  pfNetReal: number;
  maxDDReal: number;  // max drawdown of net-real equity, %
  tradesPerMonth: number;
}

function simulate(bars: Bar[], ind: Indics, signal: EntrySignal, tf: TF, atrTarget: number, from: number, to: number): VariantResult {
  const trades: Trade[] = [];
  const timeExit = TIME_EXIT_BARS[tf];
  let i = WARMUP;
  let inPos = false;
  let firstT = Infinity, lastT = -Infinity;

  while (i < bars.length - 1) {
    const bt = bars[i].t;
    if (bt < from || bt >= to) { i++; continue; }
    if (inPos) { i++; continue; }
    const a = ind.atr14[i];
    if (a <= 0) { i++; continue; }
    if (!signal(bars, ind, i)) { i++; continue; }

    // enter at close of bar i
    const entry = bars[i].c;
    const stop = entry - ATR_STOP * a;
    const target = entry + atrTarget * a;
    inPos = true;
    firstT = Math.min(firstT, bt); lastT = Math.max(lastT, bt);

    let exitPrice = entry;
    let resolved = false;
    for (let j = i + 1; j <= Math.min(i + timeExit, bars.length - 1); j++) {
      const b = bars[j];
      // intrabar stop-first on ambiguous bars (bar spans both stop and target)
      const hitStop = b.l <= stop;
      const hitTarget = b.h >= target;
      if (hitStop && hitTarget) { exitPrice = stop; resolved = true; i = j; break; }
      if (hitStop) { exitPrice = stop; resolved = true; i = j; break; }
      if (hitTarget) { exitPrice = target; resolved = true; i = j; break; }
      if (j === i + timeExit) { exitPrice = b.c; resolved = true; i = j; break; }  // time exit
    }
    if (!resolved) { exitPrice = bars[bars.length - 1].c; i = bars.length; }
    const ret = (exitPrice - entry) / entry;
    trades.push({ entryT: bt, ret });
    inPos = false;
    i++;
  }

  return summarize(trades, tf, firstT, lastT);
}

function summarize(trades: Trade[], tf: TF, firstT: number, lastT: number): VariantResult {
  const n = trades.length;
  if (n === 0) {
    return { trades: 0, winRate: 0, grossAvg: 0, netAvgOpt: 0, netAvgReal: 0, grossTotal: 0, netTotalOpt: 0, netTotalReal: 0, pfGross: 0, pfNetReal: 0, maxDDReal: 0, tradesPerMonth: 0 };
  }
  const grossRets = trades.map(t => t.ret);
  const netOptRets = trades.map(t => t.ret - COST_OPT);
  const netRealRets = trades.map(t => t.ret - COST_REAL);

  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const grossAvg = sum(grossRets) / n;
  const netAvgOpt = sum(netOptRets) / n;
  const netAvgReal = sum(netRealRets) / n;

  // total = compounded (each trade sized on full equity, one position at a time)
  const compound = (rets: number[]) => rets.reduce((eq, r) => eq * (1 + r), 1) - 1;
  const grossTotal = compound(grossRets);
  const netTotalOpt = compound(netOptRets);
  const netTotalReal = compound(netRealRets);

  const pf = (rets: number[]) => {
    const gains = sum(rets.filter(r => r > 0));
    const losses = -sum(rets.filter(r => r < 0));
    return losses === 0 ? (gains > 0 ? Infinity : 0) : gains / losses;
  };
  const pfGross = pf(grossRets);
  const pfNetReal = pf(netRealRets);

  // max drawdown on net-real compounded equity curve
  let eq = 1, peak = 1, maxDD = 0;
  for (const r of netRealRets) { eq *= (1 + r); peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak); }

  const winRate = grossRets.filter(r => r > 0).length / n;  // gross win rate
  const months = firstT < lastT ? (lastT - firstT) / (30.44 * 86400_000) : 1;
  const tradesPerMonth = months > 0 ? n / months : n;

  return {
    trades: n, winRate, grossAvg, netAvgOpt, netAvgReal,
    grossTotal, netTotalOpt, netTotalReal, pfGross, pfNetReal,
    maxDDReal: maxDD, tradesPerMonth,
  };
}

// ===================== benchmarks (per coin, OOS window) =====================
function buyHoldReturn(bars: Bar[], from: number, to: number): { ret: number; maxDD: number } {
  const seg = bars.filter(b => b.t >= from && b.t < to);
  if (seg.length < 2) return { ret: 0, maxDD: 0 };
  const ret = (seg[seg.length - 1].c - seg[0].c) / seg[0].c;
  let peak = seg[0].c, maxDD = 0;
  for (const b of seg) { peak = Math.max(peak, b.c); maxDD = Math.max(maxDD, (peak - b.c) / peak); }
  return { ret, maxDD };
}

// 50-day SMA trend follower on the same TF's daily-close-equivalent: hold when close>SMA50(daily), else cash.
// We build daily closes from the TF bars, compute SMA50, then map each bar to in/out and accrue bar returns.
function trendFollowerReturn(bars: Bar[], tf: TF, from: number, to: number): { ret: number; maxDD: number; switches: number } {
  // daily closes
  const dayMap = new Map<string, number>();  // dateStr -> last close of that UTC day
  for (const b of bars) {
    const d = new Date(b.t).toISOString().slice(0, 10);
    dayMap.set(d, b.c);
  }
  const days = [...dayMap.keys()].sort();
  const dayClose = days.map(d => dayMap.get(d)!);
  const sma: number[] = [];
  for (let i = 0; i < dayClose.length; i++) {
    if (i < 49) { sma.push(NaN); continue; }
    let s = 0; for (let j = i - 49; j <= i; j++) s += dayClose[j];
    sma.push(s / 50);
  }
  // holding flag per day: close(prev day) > sma(prev day) -> hold today (no lookahead)
  const holdOnDay = new Map<string, boolean>();
  for (let i = 1; i < days.length; i++) {
    holdOnDay.set(days[i], !isNaN(sma[i - 1]) && dayClose[i - 1] > sma[i - 1]);
  }
  // accrue: for each bar in window, if holding that day, take the bar's return
  const seg = bars.filter(b => b.t >= from && b.t < to);
  let eq = 1, peak = 1, maxDD = 0, switches = 0, prevHold = false;
  for (let i = 1; i < seg.length; i++) {
    const d = new Date(seg[i].t).toISOString().slice(0, 10);
    const hold = holdOnDay.get(d) ?? false;
    if (hold !== prevHold) switches++;
    prevHold = hold;
    if (hold) {
      const r = (seg[i].c - seg[i - 1].c) / seg[i - 1].c;
      eq *= (1 + r);
      peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak);
    }
  }
  return { ret: eq - 1, maxDD, switches };
}

// ===================== run =====================
const pct = (x: number) => (x * 100).toFixed(2) + "%";
const pf2 = (x: number) => (x === Infinity ? "Inf" : x.toFixed(2));

interface Row {
  coin: string; tf: TF; variant: string; target: number; period: string;
  r: VariantResult;
}

function run() {
  const rows: Row[] = [];
  const benchRows: string[] = [];
  const dataInfo: string[] = [];

  for (const coin of COINS) {
    for (const tf of TFS) {
      const bars = loadBars(coin, tf);
      const ind = buildIndics(bars);
      const first = bars[0].t, last = bars[bars.length - 1].t;
      if (tf === "1h") {
        dataInfo.push(`${coin}: ${new Date(first).toISOString().slice(0,10)} .. ${new Date(last).toISOString().slice(0,10)}  (${bars.length} 1h bars)`);
      }
      const periods: [string, number, number][] = [
        ["IS", first, SPLIT_MS],
        ["OOS", SPLIT_MS, last + 1],
      ];
      for (const variant of Object.keys(SIGNALS)) {
        for (const target of ATR_TARGETS) {
          for (const [pname, from, to] of periods) {
            const r = simulate(bars, ind, SIGNALS[variant], tf, target, from, to);
            rows.push({ coin, tf, variant, target, period: pname, r });
          }
        }
      }

      // benchmarks (compute once per coin/tf, both periods)
      for (const [pname, from, to] of periods) {
        const bh = buyHoldReturn(bars, from, to);
        const tfw = trendFollowerReturn(bars, tf, from, to);
        benchRows.push(`${coin} ${tf} ${pname}: BuyHold net%=${pct(bh.ret)} DD=${pct(bh.maxDD)} | TrendFollow(50dSMA) net%=${pct(tfw.ret)} DD=${pct(tfw.maxDD)} switches=${tfw.switches}`);
      }
    }
  }

  // ---- output ----
  console.log("\n================= DATA COVERAGE =================");
  dataInfo.forEach(d => console.log("  " + d));
  console.log(`\n  Split: IS = start..2024-07-01 ; OOS = 2024-07-01..present`);
  console.log(`  Costs round-trip: OPT=${pct(COST_OPT)} (maker/limit)  REAL=${pct(COST_REAL)} (taker+alt spread)`);

  console.log("\n================= BENCHMARKS (per coin/tf/period) =================");
  benchRows.forEach(b => console.log("  " + b));

  // Full variant table
  console.log("\n================= ALL VARIANTS (net at REAL 1.0% cost) =================");
  console.log("coin    tf   variant   tgt  period  #tr  tr/mo   WR     PFg   PFnet  netAvg%  netTot%  maxDD");
  for (const row of rows) {
    const r = row.r;
    if (r.trades === 0) continue;
    console.log(
      `${row.coin.replace("USDT","").padEnd(5)}  ${row.tf.padEnd(3)}  ${row.variant.padEnd(8)}  ${row.target.toFixed(1)}  ${row.period.padEnd(4)}  ` +
      `${String(r.trades).padStart(4)} ${r.tradesPerMonth.toFixed(1).padStart(6)}  ${pct(r.winRate).padStart(6)}  ${pf2(r.pfGross).padStart(4)}  ${pf2(r.pfNetReal).padStart(5)}  ` +
      `${(r.netAvgReal*100).toFixed(3).padStart(7)}  ${(r.netTotalReal*100).toFixed(1).padStart(7)}  ${pct(r.maxDDReal).padStart(6)}`
    );
  }

  // ---- durable-edge finder: variant/coin/tf/target that is net-positive in BOTH IS and OOS ----
  console.log("\n================= DURABLE-EDGE SCAN (net-positive BOTH IS & OOS) =================");
  const keyed = new Map<string, { is?: VariantResult; oos?: VariantResult }>();
  for (const row of rows) {
    const k = `${row.coin}|${row.tf}|${row.variant}|${row.target}`;
    const e = keyed.get(k) ?? {};
    if (row.period === "IS") e.is = row.r; else e.oos = row.r;
    keyed.set(k, e);
  }
  let durableCount = 0;
  const survivors: string[] = [];
  for (const [k, e] of keyed) {
    if (!e.is || !e.oos) continue;
    if (e.is.trades < 20 || e.oos.trades < 20) continue;  // need sample
    const [coin, tf, variant, target] = k.split("|");
    // durable at REALISTIC cost = net total positive in BOTH periods
    if (e.is.netTotalReal > 0 && e.oos.netTotalReal > 0) {
      durableCount++;
      survivors.push(`  DURABLE(real): ${coin.replace("USDT","")} ${tf} ${variant} tgt${target} | IS netTot=${pct(e.is.netTotalReal)} PF=${pf2(e.is.pfNetReal)} | OOS netTot=${pct(e.oos.netTotalReal)} PF=${pf2(e.oos.pfNetReal)} tr/mo=${e.oos.tradesPerMonth.toFixed(1)}`);
    }
  }
  if (durableCount === 0) console.log("  NONE — no variant is net-positive at REAL cost in BOTH IS and OOS.");
  else survivors.forEach(s => console.log(s));

  // GROSS durable scan (before fees) — shows whether ANY raw signal even has a pre-cost edge.
  console.log("\n  --- GROSS (before fees): variants net-positive-EQUIVALENT (grossTotal>0) BOTH IS & OOS ---");
  let grossCount = 0;
  for (const [k, e] of keyed) {
    if (!e.is || !e.oos || e.is.trades < 20 || e.oos.trades < 20) continue;
    if (e.is.grossTotal > 0 && e.oos.grossTotal > 0) {
      grossCount++;
      const [coin, tf, variant, target] = k.split("|");
      console.log(`    GROSS+: ${coin.replace("USDT","")} ${tf} ${variant} tgt${target} | IS grossTot=${pct(e.is.grossTotal)} PFg=${pf2(e.is.pfGross)} | OOS grossTot=${pct(e.oos.grossTotal)} PFg=${pf2(e.oos.pfGross)} | net-real IS=${pct(e.is.netTotalReal)} OOS=${pct(e.oos.netTotalReal)}`);
    }
  }
  if (grossCount === 0) console.log("    NONE — no variant is even GROSS-positive in both periods (no pre-cost edge exists).");

  // also report OPTIMISTIC-cost survivors (for context)
  console.log("\n  --- at OPTIMISTIC 0.6% cost (context only) ---");
  let optCount = 0;
  for (const [k, e] of keyed) {
    if (!e.is || !e.oos || e.is.trades < 20 || e.oos.trades < 20) continue;
    // recompute net-opt totals
    if (e.is.netTotalOpt > 0 && e.oos.netTotalOpt > 0) {
      optCount++;
      const [coin, tf, variant, target] = k.split("|");
      console.log(`    ${coin.replace("USDT","")} ${tf} ${variant} tgt${target} | IS ${pct(e.is.netTotalOpt)} | OOS ${pct(e.oos.netTotalOpt)}`);
    }
  }
  if (optCount === 0) console.log("    NONE at optimistic cost either.");

  console.log("\n================= DONE =================");
}

run();
