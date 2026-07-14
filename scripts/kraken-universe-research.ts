/**
 * kraken-universe-research.ts
 *
 * Broad-universe crypto strategy research for a live $500 Kraken spot account.
 * Answers: across a broad liquid Kraken USD universe, what LOW-turnover strategy
 * (trend / absolute momentum / relative-momentum rotation / dual momentum) is the
 * single best, robust in BOTH in-sample and out-of-sample, NET of Kraken fees?
 *
 * DATA: Binance public market-data mirror (data-api.binance.vision), DAILY candles.
 *   Binance USDT pairs proxy Kraken USD pairs for strategy backtesting.
 *   Cached to /tmp/kraken-universe/<SYMBOL>.csv
 *
 * FEES: Kraken 0.40% taker per side (conservative). Applied on every position change.
 *
 * SPLIT: in-sample = start .. 2024-06-30 ; out-of-sample = 2024-07-01 .. present.
 *
 * Run: npx tsx scripts/kraken-universe-research.ts
 */
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- config
const HOST = "https://data-api.binance.vision";
const OUT_DIR = "/tmp/kraken-universe";
const FEE_PER_SIDE = 0.0040; // Kraken 0.40% taker per side (conservative)
const OOS_START = Date.parse("2024-07-01T00:00:00Z");
const START_MS = Date.parse("2020-01-01T00:00:00Z"); // clamp to listing automatically
const END_MS = Date.now();
const DAY = 86_400_000;

// Coin -> Binance symbol. MATIC rebranded to POL; Binance keeps history under
// MATICUSDT (POL trades thinly / short history on the mirror), so use MATICUSDT.
const UNIVERSE: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", XRP: "XRPUSDT", DOGE: "DOGEUSDT",
  AVAX: "AVAXUSDT", LINK: "LINKUSDT", ADA: "ADAUSDT", DOT: "DOTUSDT", LTC: "LTCUSDT",
  ATOM: "ATOMUSDT", UNI: "UNIUSDT", XLM: "XLMUSDT", ALGO: "ALGOUSDT", MATIC: "MATICUSDT",
  BCH: "BCHUSDT", FIL: "FILUSDT", NEAR: "NEARUSDT", APT: "APTUSDT", ARB: "ARBUSDT",
};

// ---------------------------------------------------------------- fetch
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchChunk(sym: string, startTime: number): Promise<number[][]> {
  const url = `${HOST}/api/v3/klines?symbol=${sym}&interval=1d&startTime=${startTime}&endTime=${END_MS}&limit=1000`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 418) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status === 400) return []; // symbol not found / bad
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as unknown;
      if (!Array.isArray(j)) throw new Error(`bad payload`);
      return j as number[][];
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  return [];
}

async function fetchDaily(sym: string): Promise<{ t: number; close: number }[]> {
  let start = START_MS;
  const all: number[][] = [];
  while (start < END_MS) {
    const chunk = await fetchChunk(sym, start);
    if (!chunk.length) break;
    all.push(...chunk);
    const lastOpen = chunk[chunk.length - 1][0] as number;
    const next = lastOpen + DAY;
    if (next <= start) break;
    start = next;
    if (chunk.length < 1000) break;
  }
  // de-dupe by openTime, keep only closed daily bars
  const seen = new Set<number>();
  const out: { t: number; close: number }[] = [];
  for (const r of all) {
    const t = r[0] as number;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ t, close: parseFloat(r[4] as unknown as string) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

async function loadUniverse(): Promise<Record<string, { t: number; close: number }[]>> {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const data: Record<string, { t: number; close: number }[]> = {};
  for (const [coin, sym] of Object.entries(UNIVERSE)) {
    const csv = path.join(OUT_DIR, `${coin}.csv`);
    if (fs.existsSync(csv)) {
      const rows = fs.readFileSync(csv, "utf8").trim().split("\n").slice(1);
      data[coin] = rows.map((l) => { const [t, c] = l.split(","); return { t: +t, close: +c }; });
      continue;
    }
    process.stderr.write(`fetching ${coin} (${sym})...`);
    const series = await fetchDaily(sym);
    if (series.length < 400) { process.stderr.write(` SKIP (only ${series.length} bars)\n`); continue; }
    fs.writeFileSync(csv, "t,close\n" + series.map((r) => `${r.t},${r.close}`).join("\n"));
    data[coin] = series;
    process.stderr.write(` ${series.length} bars\n`);
    await sleep(200);
  }
  return data;
}

// ---------------------------------------------------------------- align to common date grid
// Build a master sorted list of all dates; each coin maps date->close (or undefined before listing).
function buildGrid(data: Record<string, { t: number; close: number }[]>) {
  const coins = Object.keys(data);
  const dateSet = new Set<number>();
  for (const c of coins) for (const r of data[c]) dateSet.add(r.t);
  const dates = [...dateSet].sort((a, b) => a - b);
  const price: Record<string, Map<number, number>> = {};
  for (const c of coins) { price[c] = new Map(); for (const r of data[c]) price[c].set(r.t, r.close); }
  return { coins, dates, price };
}

// ---------------------------------------------------------------- metrics
interface DailyPoint { t: number; ret: number } // portfolio daily return net of fees already applied via cost

interface Result {
  strat: string; period: string;
  totalPct: number; cagr: number; vol: number; sharpe: number; maxDD: number;
  pctCash: number; rebalPerYr: number; nDays: number;
}

function summarize(strat: string, period: string, series: DailyPoint[], cashDays: number, rebalCount: number): Result {
  const n = series.length;
  if (n === 0) return { strat, period, totalPct: 0, cagr: 0, vol: 0, sharpe: 0, maxDD: 0, pctCash: 0, rebalPerYr: 0, nDays: 0 };
  let equity = 1;
  let peak = 1, maxDD = 0;
  const rets: number[] = [];
  for (const p of series) {
    equity *= (1 + p.ret);
    rets.push(p.ret);
    if (equity > peak) peak = equity;
    const dd = equity / peak - 1;
    if (dd < maxDD) maxDD = dd;
  }
  const totalPct = (equity - 1) * 100;
  const years = n / 365;
  const cagr = (Math.pow(equity, 1 / years) - 1) * 100;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const vol = sd * Math.sqrt(365) * 100;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
  const pctCash = (cashDays / n) * 100;
  const rebalPerYr = rebalCount / years;
  return { strat, period, totalPct, cagr, vol, sharpe, maxDD: maxDD * 100, pctCash, rebalPerYr, nDays: n };
}

// ---------------------------------------------------------------- backtest engine
// A strategy returns, for each rebalance decision, target weights over coins (sum<=1, rest cash).
// We simulate daily: between rebalances weights drift with price (we approximate by holding target
// weights fixed and rebalancing to target at cadence — standard rotation assumption). Fees charged
// on turnover at each rebalance = sum(|w_new - w_old_drifted|) approximated as sum of changed legs.
//
// To keep it faithful & simple for LOW-turnover strategies we model:
//   - hold target weights; daily portfolio return = sum(w_i * coin_i_daily_return)
//   - at each rebalance, turnover = sum over coins |w_target - w_prev|; fee = turnover * FEE_PER_SIDE
//     (a full switch of one slot = sell old (1 side) + buy new (1 side) = turnover 2*w -> 2 sides. correct.)

type WeightFn = (dateIdx: number, ctx: Ctx) => Record<string, number>;
interface Ctx { coins: string[]; dates: number[]; price: Record<string, Map<number, number>>; }

function priceAt(ctx: Ctx, coin: string, idx: number): number | undefined {
  return ctx.price[coin].get(ctx.dates[idx]);
}

// trailing return over `win` days ending at idx (using close[idx]/close[idx-win]-1)
function trailingReturn(ctx: Ctx, coin: string, idx: number, win: number): number | undefined {
  if (idx - win < 0) return undefined;
  const a = priceAt(ctx, coin, idx - win);
  const b = priceAt(ctx, coin, idx);
  if (a === undefined || b === undefined || a <= 0) return undefined;
  return b / a - 1;
}

function smaAbove(ctx: Ctx, coin: string, idx: number, win: number): boolean | undefined {
  if (idx - win < 0) return undefined;
  let sum = 0, cnt = 0;
  for (let k = idx - win + 1; k <= idx; k++) { const p = priceAt(ctx, coin, k); if (p === undefined) return undefined; sum += p; cnt++; }
  if (cnt < win) return undefined;
  const sma = sum / cnt;
  const px = priceAt(ctx, coin, idx);
  if (px === undefined) return undefined;
  return px > sma;
}

// Run a weight-based strategy. rebalEvery = days between rebalances (7=weekly-ish, 30=monthly-ish).
// startIdx: first index we start trading (after warmup). period filter via [from,to].
function runStrategy(
  strat: string, ctx: Ctx, weightFn: WeightFn, rebalEvery: number, warmup: number,
): { is: Result; oos: Result; full: Result } {
  const { dates } = ctx;
  const N = dates.length;
  let curWeights: Record<string, number> = {};
  let daysSinceRebal = rebalEvery; // force rebalance on first eligible day
  let rebalCountIS = 0, rebalCountOOS = 0;
  const isSeries: DailyPoint[] = [], oosSeries: DailyPoint[] = [], fullSeries: DailyPoint[] = [];
  let cashIS = 0, cashOOS = 0;

  for (let idx = warmup; idx < N; idx++) {
    const t = dates[idx];
    const isOOS = t >= OOS_START;

    // decide rebalance
    let feeToday = 0;
    if (daysSinceRebal >= rebalEvery) {
      const target = weightFn(idx, ctx);
      // normalize: drop coins with no price today
      const clean: Record<string, number> = {};
      let wsum = 0;
      for (const [c, w] of Object.entries(target)) {
        if (w <= 0) continue;
        if (priceAt(ctx, c, idx) === undefined) continue;
        clean[c] = w; wsum += w;
      }
      // turnover vs current weights
      const allCoins = new Set([...Object.keys(curWeights), ...Object.keys(clean)]);
      let turnover = 0;
      for (const c of allCoins) turnover += Math.abs((clean[c] || 0) - (curWeights[c] || 0));
      feeToday = turnover * FEE_PER_SIDE;
      curWeights = clean;
      daysSinceRebal = 0;
      if (turnover > 1e-9) { if (isOOS) rebalCountOOS++; else rebalCountIS++; }
    }
    daysSinceRebal++;

    // portfolio return from idx-1 close to idx close, using weights held (set at prior rebalance)
    // We apply today's weights to today's return (close[idx]/close[idx-1]).
    let pret = 0; let invested = 0;
    for (const [c, w] of Object.entries(curWeights)) {
      const p0 = priceAt(ctx, c, idx - 1);
      const p1 = priceAt(ctx, c, idx);
      if (p0 === undefined || p1 === undefined || p0 <= 0) continue;
      pret += w * (p1 / p0 - 1);
      invested += w;
    }
    // cash portion earns 0
    const netRet = pret - feeToday;
    const cashFraction = 1 - invested;
    if (cashFraction > 0.999) { if (isOOS) cashOOS++; else cashIS++; }

    const dp: DailyPoint = { t, ret: netRet };
    fullSeries.push(dp);
    if (isOOS) oosSeries.push(dp); else isSeries.push(dp);
  }

  return {
    is: summarize(strat, "IS", isSeries, cashIS, rebalCountIS),
    oos: summarize(strat, "OOS", oosSeries, cashOOS, rebalCountOOS),
    full: summarize(strat, "FULL", fullSeries, cashIS + cashOOS, rebalCountIS + rebalCountOOS),
  };
}

// ---------------------------------------------------------------- strategy weight functions
// 1a. Buy & hold BTC
function bhBTC(): WeightFn { return () => ({ BTC: 1 }); }

// 1b. Buy & hold equal-weight basket (all coins with price today)
function bhBasket(): WeightFn {
  return (idx, ctx) => {
    const avail = ctx.coins.filter((c) => priceAt(ctx, c, idx) !== undefined);
    const w = 1 / avail.length;
    const o: Record<string, number> = {}; for (const c of avail) o[c] = w; return o;
  };
}

// 2. Single-coin 50-day SMA trend follower — hold coin above its SMA, else cash. (per-coin)
function smaTrend(coin: string, win: number): WeightFn {
  return (idx, ctx) => {
    const above = smaAbove(ctx, coin, idx, win);
    return above ? { [coin]: 1 } : {};
  };
}

// Incumbent: BTC+ETH each 50% via 50-SMA (hold each half if above its own SMA, else that half cash)
function incumbentBtcEth(win: number): WeightFn {
  return (idx, ctx) => {
    const o: Record<string, number> = {};
    if (smaAbove(ctx, "BTC", idx, win)) o.BTC = 0.5;
    if (smaAbove(ctx, "ETH", idx, win)) o.ETH = 0.5;
    return o;
  };
}

// 3. Absolute momentum per coin (single coin): hold if trailing X-day return > 0 else cash.
function absMom(coin: string, win: number): WeightFn {
  return (idx, ctx) => {
    const r = trailingReturn(ctx, coin, idx, win);
    return r !== undefined && r > 0 ? { [coin]: 1 } : {};
  };
}

// 4. Relative momentum rotation: rank all coins by trailing X-day return, hold top N equal weight.
function relMom(win: number, topN: number): WeightFn {
  return (idx, ctx) => {
    const ranked: { c: string; r: number }[] = [];
    for (const c of ctx.coins) { const r = trailingReturn(ctx, c, idx, win); if (r !== undefined) ranked.push({ c, r }); }
    ranked.sort((a, b) => b.r - a.r);
    const picks = ranked.slice(0, topN);
    const w = picks.length ? 1 / picks.length : 0;
    const o: Record<string, number> = {}; for (const p of picks) o[p.c] = w; return o;
  };
}

// 5. Dual momentum: rank by trailing X-day return, take top N, but only fill a slot if that coin's
//    absolute momentum > 0 (else that fraction stays cash). Equal weight the N slots regardless
//    (so cash-filled slots reduce invested exposure).
function dualMom(win: number, topN: number): WeightFn {
  return (idx, ctx) => {
    const ranked: { c: string; r: number }[] = [];
    for (const c of ctx.coins) { const r = trailingReturn(ctx, c, idx, win); if (r !== undefined) ranked.push({ c, r }); }
    ranked.sort((a, b) => b.r - a.r);
    const picks = ranked.slice(0, topN);
    const slotW = 1 / topN;
    const o: Record<string, number> = {};
    for (const p of picks) if (p.r > 0) o[p.c] = slotW; // absolute filter; cash otherwise
    return o;
  };
}

// 6. Dual momentum + 200-SMA regime: same as dual, but a slot must ALSO be above its 200-day SMA.
function dualMomRegime(win: number, topN: number, smaWin: number): WeightFn {
  return (idx, ctx) => {
    const ranked: { c: string; r: number }[] = [];
    for (const c of ctx.coins) { const r = trailingReturn(ctx, c, idx, win); if (r !== undefined) ranked.push({ c, r }); }
    ranked.sort((a, b) => b.r - a.r);
    const picks = ranked.slice(0, topN);
    const slotW = 1 / topN;
    const o: Record<string, number> = {};
    for (const p of picks) { if (p.r > 0 && smaAbove(ctx, p.c, idx, smaWin) === true) o[p.c] = slotW; }
    return o;
  };
}

// ---------------------------------------------------------------- reporting
function fmt(n: number, d = 1): string { return (n >= 0 ? " " : "") + n.toFixed(d); }
function row(r: Result): string {
  return [
    r.strat.padEnd(34), r.period.padEnd(4),
    fmt(r.totalPct).padStart(8), fmt(r.cagr).padStart(7), fmt(r.vol).padStart(6),
    fmt(r.sharpe, 2).padStart(6), fmt(r.maxDD).padStart(7),
    r.pctCash.toFixed(0).padStart(5), r.rebalPerYr.toFixed(0).padStart(5), String(r.nDays).padStart(5),
  ].join(" ");
}
function header(): string {
  return ["strategy".padEnd(34), "per ".padEnd(4), "total%".padStart(8), "cagr%".padStart(7),
    "vol%".padStart(6), "sharp".padStart(6), "maxDD".padStart(7), "%cash".padStart(5),
    "rb/yr".padStart(5), "days".padStart(5)].join(" ");
}

// ---------------------------------------------------------------- main
async function main() {
  const data = await loadUniverse();
  const gotCoins = Object.keys(data);
  const ctx = buildGrid(data);

  // per-coin start dates
  console.log("=== DATA COVERAGE (Binance daily, vision mirror) ===");
  for (const c of gotCoins) {
    const s = data[c];
    const first = new Date(s[0].t).toISOString().slice(0, 10);
    const last = new Date(s[s.length - 1].t).toISOString().slice(0, 10);
    console.log(`${c.padEnd(6)} ${s.length} bars  ${first} .. ${last}`);
  }
  console.log(`\nGrid: ${ctx.dates.length} dates, ${new Date(ctx.dates[0]).toISOString().slice(0,10)} .. ${new Date(ctx.dates[ctx.dates.length-1]).toISOString().slice(0,10)}`);
  console.log(`OOS split: ${new Date(OOS_START).toISOString().slice(0,10)} | fee ${(FEE_PER_SIDE*100).toFixed(2)}%/side\n`);

  const warmup = 200; // need up to 200-day SMA / 120-day momentum
  const results: { is: Result; oos: Result; full: Result }[] = [];
  const push = (name: string, fn: WeightFn, rebal: number) => results.push(runStrategy(name, ctx, fn, rebal, warmup));

  // Benchmarks
  push("BH BTC", bhBTC(), 9999);
  push("BH basket(EW)", bhBasket(), 30);

  // Incumbent
  push("INCUMBENT BTC+ETH 50-SMA", incumbentBtcEth(50), 1);
  push("Single BTC 50-SMA", smaTrend("BTC", 50), 1);
  push("Single ETH 50-SMA", smaTrend("ETH", 50), 1);

  // Absolute momentum (single BTC, several windows) — representative
  for (const w of [30, 60, 90, 120]) push(`AbsMom BTC ${w}d`, absMom("BTC", w), 7);

  // Relative momentum rotation
  for (const w of [30, 60, 90]) for (const n of [1, 2, 3]) {
    push(`RelMom top${n} ${w}d wk`, relMom(w, n), 7);
    push(`RelMom top${n} ${w}d mo`, relMom(w, n), 30);
  }

  // Dual momentum (key candidate)
  for (const w of [30, 60, 90]) for (const n of [1, 2, 3]) {
    push(`DualMom top${n} ${w}d wk`, dualMom(w, n), 7);
    push(`DualMom top${n} ${w}d mo`, dualMom(w, n), 30);
  }

  // Dual momentum + 200-SMA regime
  for (const w of [60, 90]) for (const n of [2, 3]) {
    push(`DualMom+200SMA top${n} ${w}d wk`, dualMomRegime(w, n, 200), 7);
  }

  // print full table
  console.log("=== LEADERBOARD (net of fees) ===");
  console.log(header());
  for (const r of results) { console.log(row(r.is)); console.log(row(r.oos)); }

  // robust ranking: require positive OOS total AND positive IS total; rank by min(Sharpe_IS, Sharpe_OOS)
  console.log("\n=== ROBUST CANDIDATES (positive total in BOTH IS & OOS), ranked by min-Sharpe ===");
  const robust = results
    .filter((r) => r.is.totalPct > 0 && r.oos.totalPct > 0)
    .map((r) => ({ r, minSharpe: Math.min(r.is.sharpe, r.oos.sharpe), minCagr: Math.min(r.is.cagr, r.oos.cagr) }))
    .sort((a, b) => b.minSharpe - a.minSharpe);
  console.log(header().replace("strategy", "strategy [minSharpe]"));
  for (const { r, minSharpe } of robust.slice(0, 15)) {
    console.log(`min-Sharpe ${minSharpe.toFixed(2)}`);
    console.log(row(r.is));
    console.log(row(r.oos));
  }

  console.log(`\ncoins used (${gotCoins.length}): ${gotCoins.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
