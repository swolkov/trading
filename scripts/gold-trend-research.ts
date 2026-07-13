/**
 * GOLD INTRADAY TREND-FOLLOWING RESEARCH
 *
 * Question: does a PROPERLY-built (regime-filtered, not-shorting-into-oversold) intraday
 * gold trend-continuation entry have a durable, tradeable edge — or is gold structurally
 * mean-reverting intraday?
 *
 * Math helpers (ema/rsi/atr/adx/calcVwap/get15mTrend) are copied VERBATIM from
 * scripts/backtest.ts (which itself ports them from src/services/futures-realtime.ts) so
 * indicators match the live engine. This script does NOT modify backtest.ts or any src/ file.
 *
 * Method:
 *  - Load GC 1m, resample to 5m. RTH = 13:30–20:00 UTC (9:30–16:00 ET). Also a near-24h variant.
 *  - Trend-continuation variants: baseline (no filter) vs regime-filtered (EMA align + ADX +
 *    VWAP extension + RSI NOT extreme + trend-day). Long AND short, in the trend direction.
 *  - Exits: engine convention. Primary 1.5*ATR stop / 3.5*ATR target; also 1.5/2.0.
 *    One position per direction at a time; 1m intrabar stop-first; time-exit after 24 5m bars.
 *  - IS = 2023-06..2025-03, OOS = 2025-04..2026-05. Edge counts only if positive in BOTH.
 *  - Cost: 1 tick (0.1pt) round-trip. Report gross and net (in R and $-micro MGC).
 *
 * Run: npx tsx scripts/gold-trend-research.ts
 */
import fs from "node:fs";
import readline from "node:readline";

// ===================== exact math (verbatim from backtest.ts / engine) =====================
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
function atr(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++)
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}
function adx(bars: Bar[], period = 14): number {
  if (bars.length < period * 2 + 1) return 0;
  const tr: number[] = [], pDM: number[] = [], nDM: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    pDM.push(up > dn && up > 0 ? up : 0);
    nDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  }
  const smooth = (arr: number[]) => { let s = arr.slice(0, period).reduce((a, b) => a + b, 0); const out = [s]; for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); } return out; };
  const trS = smooth(tr), pS = smooth(pDM), nS = smooth(nDM);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const pDI = 100 * pS[i] / (trS[i] || 1e-9), nDI = 100 * nS[i] / (trS[i] || 1e-9);
    dx.push(100 * Math.abs(pDI - nDI) / ((pDI + nDI) || 1e-9));
  }
  return dx.length < period ? (dx.length ? dx[dx.length - 1] : 0) : dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function calcVwap(bars: Bar[]): { vwap: number } {
  let cumPV = 0, cumV = 0;
  for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; cumPV += tp * b.v; cumV += b.v; }
  return { vwap: cumV > 0 ? cumPV / cumV : 0 };
}
function get15mTrend(bars5m: Bar[]): { trend: "up" | "down" | "flat" } {
  const b15: Bar[] = [];
  for (let i = 0; i + 2 < bars5m.length; i += 3)
    b15.push({ t: bars5m[i].t, o: bars5m[i].o, h: Math.max(bars5m[i].h, bars5m[i + 1].h, bars5m[i + 2].h), l: Math.min(bars5m[i].l, bars5m[i + 1].l, bars5m[i + 2].l), c: bars5m[i + 2].c, v: 0 });
  if (b15.length < 21) return { trend: "flat" };
  const cl = b15.map(b => b.c); const f = ema(cl, 9), s = ema(cl, 21);
  const ff = f[f.length - 1], ss = s[s.length - 1];
  return ff > ss ? { trend: "up" } : ff < ss ? { trend: "down" } : { trend: "flat" };
}

// ===================== config =====================
const TICK = 0.10;           // GC/MGC tick = 0.1 pt
const MGC_MULT = 10;         // micro gold $/pt (report $ in micro terms)
const COST_R_NOTE = "1 tick (0.1pt) round-trip";
const MAX_HOLD = 24;         // 5m bars time-exit (~2h)
const ATR_SCALE = 1.5;       // metals ATR scale (matches engine METALS treatment)

// ===================== streamed load + resample to 5m =====================
async function loadBars5m(): Promise<{ bars5m: Bar[]; m1: Bar[] }> {
  const path = new URL("../data/GC_1m.csv", import.meta.url);
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  const m1: Bar[] = [];
  const buckets = new Map<number, Bar>();
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; } // header
    if (!line) continue;
    const c = line.split(",");
    const t = new Date(c[0]).getTime();
    const o = +c[4], h = +c[5], l = +c[6], cl = +c[7], v = +c[8];
    m1.push({ t, o, h, l, c: cl, v });
    const key = Math.floor(t / 300000) * 300000;
    const ex = buckets.get(key);
    if (!ex) buckets.set(key, { t: key, o, h, l, c: cl, v });
    else { ex.h = Math.max(ex.h, h); ex.l = Math.min(ex.l, l); ex.c = cl; ex.v += v; }
  }
  const bars5m = [...buckets.values()].sort((a, b) => a.t - b.t);
  m1.sort((a, b) => a.t - b.t);
  return { bars5m, m1 };
}

// ET session helpers (RTH gold = 9:30–16:00 ET)
function etInfo(d: Date) {
  const s = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" });
  const dow = s.slice(0, 3);
  const hm = s.match(/(\d{2}):(\d{2})/);
  const h = hm ? +hm[1] + +hm[2] / 60 : 0;
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return { etH: h, dow, dateStr, weekend: dow === "Sat" || dow === "Sun" };
}
function isRTH(d: Date): boolean {
  const { etH, weekend } = etInfo(d);
  return !weekend && etH >= 9.5 && etH < 16;
}
function isTradeable24h(d: Date): boolean {
  const { etH, weekend } = etInfo(d);
  if (weekend) return false;
  if (etH >= 17 && etH < 18) return false; // daily halt
  return true;
}

// ===================== trade model =====================
interface Trade { dir: "long" | "short"; entry: number; exit: number; grossR: number; netR: number; bars: number; outcome: string; entryTime: number; rsi: number; adx: number; }

function resolveExit(m1: Bar[], fromTime: number, dir: string, stop: number, target: number, maxTime: number): { px: number; outcome: string; exitTime: number; bars1m: number } {
  const long = dir === "long";
  let lo = 0, hi = m1.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m1[mid].t < fromTime) lo = mid + 1; else hi = mid; }
  let last = lo;
  for (let j = lo; j < m1.length && m1[j].t <= maxTime; j++) {
    last = j; const b = m1[j];
    const hitStop = long ? b.l <= stop : b.h >= stop;
    const hitTarget = long ? b.h >= target : b.l <= target;
    if (hitStop && hitTarget) return { px: stop, outcome: "stop", exitTime: b.t, bars1m: j - lo };
    if (hitStop) return { px: stop, outcome: "stop", exitTime: b.t, bars1m: j - lo };
    if (hitTarget) return { px: target, outcome: "target", exitTime: b.t, bars1m: j - lo };
  }
  return { px: m1[last]?.c ?? stop, outcome: "time", exitTime: m1[last]?.t ?? maxTime, bars1m: last - lo };
}

// ===================== variant definitions =====================
// A variant decides, given per-bar context, whether to enter and in which direction.
interface Ctx {
  price: number; rsiVal: number; fastEMA: number; slowEMA: number; adxVal: number;
  vwap: number; atrVal: number; tf15: "up" | "down" | "flat";
  sessRangeAtr: number; sessDirAtr: number; // |sessHi-sessLo|/atr, (price-sessOpen)/atr
  volRatio: number;
}
interface Variant { label: string; decide: (c: Ctx) => "long" | "short" | null; rr: "primary" | "conservative"; }

// Trend direction from EMA alignment
function emaDir(c: Ctx): "long" | "short" | null {
  if (c.fastEMA > c.slowEMA) return "long";
  if (c.fastEMA < c.slowEMA) return "short";
  return null;
}

function buildVariants(): Variant[] {
  const V: Variant[] = [];
  // near-EMA pullback proximity (engine uses <0.3% of price)
  const nearEMA = (c: Ctx) => Math.abs(c.price - c.fastEMA) / c.price < 0.003;

  // a. BASELINE (bad): momentum in EMA direction, NO regime filter, no RSI guard.
  V.push({ label: "a. BASELINE momentum (no filter)", rr: "primary", decide: c => emaDir(c) });

  // Engine-style trend_continuation (the gated-off loser) — replicate for reference.
  V.push({ label: "a2. ENGINE trend_cont (near-EMA,RSI35-65)", rr: "primary", decide: c => {
    const d = emaDir(c); if (!d) return null;
    if (!nearEMA(c)) return null;
    if (!(c.rsiVal > 35 && c.rsiVal < 65)) return null;
    if (d === "long" && !(c.price > c.slowEMA)) return null;
    if (d === "short" && !(c.price < c.slowEMA)) return null;
    return d;
  }});

  // b. REGIME-FILTERED family. Enter WITH trend, ADX confirms, price extended past VWAP in
  //    trend dir, RSI NOT extreme AND on the correct side (short only when 40-65, long 35-60).
  const rsiOk = (c: Ctx, d: "long" | "short") =>
    d === "long" ? (c.rsiVal >= 35 && c.rsiVal <= 60) : (c.rsiVal >= 40 && c.rsiVal <= 65);
  const vwapExt = (c: Ctx, d: "long" | "short") =>
    d === "long" ? c.price > c.vwap : c.price < c.vwap;

  for (const adxMin of [20, 25]) {
    V.push({ label: `b. REGIME EMA+ADX${adxMin}+VWAP+RSIok`, rr: "primary", decide: c => {
      const d = emaDir(c); if (!d) return null;
      if (c.adxVal < adxMin) return null;
      if (!vwapExt(c, d)) return null;
      if (!rsiOk(c, d)) return null;
      if (c.tf15 !== (d === "long" ? "up" : "down")) return null; // higher-TF confirms
      return d;
    }});
  }

  // b2. Same but require a PULLBACK entry (near EMA) — buy dips in uptrend, sell rips in downtrend.
  V.push({ label: "b2. REGIME ADX25 + pullback-to-EMA", rr: "primary", decide: c => {
    const d = emaDir(c); if (!d) return null;
    if (c.adxVal < 25) return null;
    if (!nearEMA(c)) return null;
    if (!rsiOk(c, d)) return null;
    if (c.tf15 !== (d === "long" ? "up" : "down")) return null;
    return d;
  }});

  // c. TREND-DAY only: session has already expanded > 1.5 ATR AND directional drive.
  V.push({ label: "c. TREND-DAY (range>1.5ATR + drive) + ADX25", rr: "primary", decide: c => {
    const d = emaDir(c); if (!d) return null;
    if (c.adxVal < 25) return null;
    if (c.sessRangeAtr < 1.5) return null;
    if (d === "long" && c.sessDirAtr < 0.75) return null;   // day is driving up
    if (d === "short" && c.sessDirAtr > -0.75) return null;  // day is driving down
    if (!rsiOk(c, d)) return null;
    if (!vwapExt(c, d)) return null;
    return d;
  }});

  // c2. Opening-drive breakout continuation: strong directional day + ADX, no RSI-extreme.
  V.push({ label: "c2. TREND-DAY strict (range>2ATR,drive>1)", rr: "primary", decide: c => {
    const d = emaDir(c); if (!d) return null;
    if (c.adxVal < 25) return null;
    if (c.sessRangeAtr < 2.0) return null;
    if (d === "long" && c.sessDirAtr < 1.0) return null;
    if (d === "short" && c.sessDirAtr > -1.0) return null;
    if (!rsiOk(c, d)) return null;
    return d;
  }});

  return V;
}

// conservative-RR clones of every variant (1.5 stop / 2.0 target)
function withConservative(vars: Variant[]): Variant[] {
  const out: Variant[] = [];
  for (const v of vars) out.push(v);
  for (const v of vars) out.push({ label: v.label + " [2R]", decide: v.decide, rr: "conservative" });
  return out;
}

// ===================== run a variant over a session-set =====================
function runVariant(v: Variant, bars5m: Bar[], m1: Bar[], sessionOk: (d: Date) => boolean): Trade[] {
  const trades: Trade[] = [];
  const stopMult = 1.5;
  const targetMult = v.rr === "conservative" ? 2.0 : 3.5;
  let blockedLong = 0, blockedShort = 0;
  let lastDate = "";
  let sessOpen = 0; const sessBars: Bar[] = [];

  for (let i = 25; i < bars5m.length; i++) {
    const d = new Date(bars5m[i].t);
    if (!sessionOk(d)) continue;
    const info = etInfo(d);
    if (info.dateStr !== lastDate) { sessBars.length = 0; sessOpen = bars5m[i].o; lastDate = info.dateStr; }
    sessBars.push(bars5m[i]);

    const slice = bars5m.slice(Math.max(0, i - 199), i + 1);
    const closes = slice.map(b => b.c);
    const rawATR = atr(slice); if (rawATR <= 0) continue;
    const atrVal = rawATR * ATR_SCALE;
    const rsiVal = rsi(closes) ?? 50;
    const fast = ema(closes, 9), slow = ema(closes, 21);
    const fastEMA = fast[fast.length - 1], slowEMA = slow[slow.length - 1];
    const vwap = calcVwap(sessBars).vwap || calcVwap(slice.slice(-78)).vwap;
    const adxVal = adx(slice);
    const tf15 = get15mTrend(slice).trend;
    const price = bars5m[i].c;
    const last20 = slice.slice(-20);
    const avgVol = last20.reduce((s, x) => s + x.v, 0) / 20;
    const volRatio = avgVol > 0 ? bars5m[i].v / avgVol : 1;
    const sessHi = Math.max(...sessBars.map(b => b.h)), sessLo = Math.min(...sessBars.map(b => b.l));
    const baseAtr = atr(slice) || 1e-9;
    const sessRangeAtr = (sessHi - sessLo) / baseAtr;
    const sessDirAtr = (price - sessOpen) / baseAtr;

    const ctx: Ctx = { price, rsiVal, fastEMA, slowEMA, adxVal, vwap, atrVal, tf15, sessRangeAtr, sessDirAtr, volRatio };
    const dir = v.decide(ctx);
    if (!dir) continue;
    if (dir === "long" && bars5m[i].t < blockedLong) continue;
    if (dir === "short" && bars5m[i].t < blockedShort) continue;

    const long = dir === "long";
    const stopDist = atrVal * stopMult, targetDist = atrVal * targetMult;
    const entry = long ? price + TICK : price - TICK;
    const stop = long ? entry - stopDist : entry + stopDist;
    const target = long ? entry + targetDist : entry - targetDist;
    const entryTime = bars5m[i].t + 300000;
    const ex = resolveExit(m1, entryTime, dir, stop, target, entryTime + MAX_HOLD * 300000);
    const exitPx = long ? ex.px - TICK : ex.px + TICK;
    const pts = long ? exitPx - entry : entry - exitPx;
    const riskPts = stopDist;
    const grossPts = long ? ex.px - price : price - ex.px; // gross of the 1-tick entry+exit cost
    const grossR = grossPts / riskPts;
    const netR = pts / riskPts;                             // already includes 1-tick each side
    if (dir === "long") blockedLong = ex.exitTime; else blockedShort = ex.exitTime;
    trades.push({ dir, entry, exit: exitPx, grossR, netR, bars: ex.bars1m, outcome: ex.outcome, entryTime: bars5m[i].t, rsi: rsiVal, adx: adxVal });
  }
  return trades;
}

// ===================== metrics =====================
function stats(trades: Trade[], useNet = true) {
  const n = trades.length; if (!n) return null;
  const R = (t: Trade) => useNet ? t.netR : t.grossR;
  const wins = trades.filter(t => R(t) > 0), losses = trades.filter(t => R(t) < 0);
  const gw = wins.reduce((s, t) => s + R(t), 0), gl = Math.abs(losses.reduce((s, t) => s + R(t), 0));
  const totalR = trades.reduce((s, t) => s + R(t), 0);
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades) { cum += R(t); peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n, wr: wins.length / n, pf: gl ? gw / gl : (gw > 0 ? Infinity : 0), avgR: totalR / n, totalR, dd };
}
const IS_START = new Date("2023-06-01").getTime();
const IS_END = new Date("2025-04-01").getTime();   // IS: 2023-06 .. 2025-03
const OOS_END = new Date("2026-06-01").getTime();  // OOS: 2025-04 .. 2026-05
function period(trades: Trade[], which: "IS" | "OOS") {
  return trades.filter(t => which === "IS"
    ? t.entryTime >= IS_START && t.entryTime < IS_END
    : t.entryTime >= IS_END && t.entryTime < OOS_END);
}
function fmt(s: ReturnType<typeof stats>) {
  if (!s) return "n=0".padEnd(52);
  return `n=${String(s.n).padStart(4)} WR ${(s.wr * 100).toFixed(0).padStart(3)}% PF ${(s.pf === Infinity ? "INF" : s.pf.toFixed(2)).padStart(5)} avgR ${(s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(3)} totR ${(s.totalR >= 0 ? "+" : "") + s.totalR.toFixed(1)} DD ${s.dd.toFixed(1)}`.padEnd(52);
}

async function main() {
  console.log("Loading + resampling GC 1m → 5m (streaming)…");
  const { bars5m, m1 } = await loadBars5m();
  console.log(`Loaded ${m1.length} 1m bars, ${bars5m.length} 5m bars. Range ${new Date(bars5m[0].t).toISOString().slice(0,10)} → ${new Date(bars5m[bars5m.length-1].t).toISOString().slice(0,10)}`);

  const variants = withConservative(buildVariants());

  for (const [sessLabel, sessionOk] of [["RTH (9:30-16:00 ET)", isRTH], ["Near-24h", isTradeable24h]] as [string, (d: Date) => boolean][]) {
    console.log("\n" + "═".repeat(120));
    console.log(`  SESSION: ${sessLabel}   |  exits: 1.5xATR stop, target 3.5xATR (primary) or 2.0xATR ([2R]).  Cost: ${COST_R_NOTE} (netR).`);
    console.log("═".repeat(120));
    console.log(`  ${"VARIANT".padEnd(42)} ${"PERIOD".padEnd(4)} ${"NET (after cost)".padEnd(52)} GROSS`);
    console.log("  " + "─".repeat(116));

    type Row = { v: Variant; isS: ReturnType<typeof stats>; oosS: ReturnType<typeof stats>; isG: ReturnType<typeof stats>; oosG: ReturnType<typeof stats> };
    const rows: Row[] = [];
    for (const v of variants) {
      const trades = runVariant(v, bars5m, m1, sessionOk);
      const isT = period(trades, "IS"), oosT = period(trades, "OOS");
      rows.push({ v, isS: stats(isT, true), oosS: stats(oosT, true), isG: stats(isT, false), oosG: stats(oosT, false) });
    }
    for (const r of rows) {
      const passNet = r.isS && r.oosS && r.isS.avgR > 0 && r.oosS.avgR > 0 && r.isS.pf >= 1.1 && r.oosS.pf >= 1.1;
      console.log(`  ${(passNet ? "✅ " : "   ") + r.v.label.padEnd(39)} ${"IS".padEnd(4)} ${fmt(r.isS)} ${fmt(r.isG).trim()}`);
      console.log(`  ${" ".padEnd(42)} ${"OOS".padEnd(4)} ${fmt(r.oosS)} ${fmt(r.oosG).trim()}`);
    }
  }

  // ---- coin-flip sanity baseline: random long/short every N bars, RTH, primary RR ----
  console.log("\n" + "═".repeat(120));
  console.log("  SANITY: random-entry coin-flip (RTH, primary RR) — should be ~breakeven gross, negative net");
  const flip: Variant = { label: "coin-flip", rr: "primary", decide: () => (Math.random() < 0.5 ? "long" : "short") };
  // throttle coin-flip so it isn't every bar: only ~1% of bars
  const flipThrottled: Variant = { label: "coin-flip", rr: "primary", decide: () => (Math.random() < 0.01 ? (Math.random() < 0.5 ? "long" : "short") : null) };
  const ft = runVariant(flipThrottled, bars5m, m1, isRTH);
  console.log(`  ALL   NET  ${fmt(stats(ft, true))}  GROSS ${fmt(stats(ft, false)).trim()}`);
  console.log(`  IS    NET  ${fmt(stats(period(ft, "IS"), true))}`);
  console.log(`  OOS   NET  ${fmt(stats(period(ft, "OOS"), true))}`);

  console.log("\n  Note: ✅ = positive avgR AND PF>=1.1 in BOTH IS and OOS, NET of cost. That is the bar for 'durable'.");
  console.log("  MGC $ per R ≈ stopDist(pts) x $10. Report is R-primary so multiplier is informational.\n");
}
main().catch(e => { console.error(e); process.exit(1); });
