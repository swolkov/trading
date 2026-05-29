/**
 * EDGE SCAN — crypto futures.
 * Scans dozens of filtered subsets of the crypto backtest trades to hunt for any
 * statistically real edge. Bar: n≥50 in-sample AND ≥30 OOS, PF≥1.3 IN, PF≥1.2 OOS, +R OOS.
 *
 * Most subsets will look like noise — that's the point. Only flagged ✅ rows are real edges.
 *
 * Run: npx tsx scripts/edge-scan-crypto.ts
 */
import fs from "node:fs";

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
function ema(data: number[], period: number): number[] { if (!data.length) return []; const k = 2 / (period + 1); const r = [data[0]]; for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k)); return r; }
function rsi(closes: number[], period = 14): number | null { if (closes.length < period + 1) return null; const ch: number[] = []; for (let i = closes.length - period; i < closes.length; i++) ch.push(closes[i] - closes[i - 1]); const ag = ch.filter(c => c > 0).reduce((a, b) => a + b, 0) / period; const al = ch.filter(c => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period; return al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
function atr(bars: Bar[], period = 14): number { if (bars.length < period + 1) return 0; const trs: number[] = []; for (let i = bars.length - period; i < bars.length; i++) trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c))); return trs.reduce((a, b) => a + b, 0) / trs.length; }
function calcVwap(bars: Bar[]): { vwap: number } { let cumPV = 0, cumV = 0; for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; cumPV += tp * b.v; cumV += b.v; } return { vwap: cumV > 0 ? cumPV / cumV : 0 }; }
function get15mTrend(bars5m: Bar[]): { trend: "up" | "down" | "flat" } { const b15: Bar[] = []; for (let i = 0; i + 2 < bars5m.length; i += 3) b15.push({ t: bars5m[i].t, o: bars5m[i].o, h: Math.max(bars5m[i].h, bars5m[i + 1].h, bars5m[i + 2].h), l: Math.min(bars5m[i].l, bars5m[i + 1].l, bars5m[i + 2].l), c: bars5m[i + 2].c, v: 0 }); if (b15.length < 21) return { trend: "flat" }; const cl = b15.map(b => b.c); const f = ema(cl, 9), s = ema(cl, 21); const ff = f[f.length - 1], ss = s[s.length - 1]; return ff > ss ? { trend: "up" } : ff < ss ? { trend: "down" } : { trend: "flat" }; }

const MULT: Record<string, number> = { MBT: 0.10, MET: 0.10, BFF: 0.01 };
const TICK: Record<string, number> = { MBT: 5, MET: 0.50, BFF: 5 };
const COMM = 2.0;
const MAX_HOLD = 78;

function loadBars5m(sym: string): { bars: Bar[]; dates: Date[]; m1: Bar[] } {
  const path = new URL(`../data/${sym}_1m.csv`, import.meta.url);
  if (!fs.existsSync(path)) throw new Error(`missing data/${sym}_1m.csv`);
  const rows = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
  const m1: Bar[] = [];
  for (const r of rows) { const c = r.split(","); m1.push({ t: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] }); }
  const buckets = new Map<number, Bar>();
  for (const b of m1) { const key = Math.floor(b.t / 300000) * 300000; const ex = buckets.get(key); if (!ex) buckets.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; } }
  const bars = [...buckets.values()].sort((a, b) => a.t - b.t);
  m1.sort((a, b) => a.t - b.t);
  return { bars, dates: bars.map(b => new Date(b.t)), m1 };
}

function etInfo(d: Date) { const s = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }); const dow = s.slice(0, 3); const hm = s.match(/(\d{2}):(\d{2})/); const h = hm ? +hm[1] + +hm[2] / 60 : 0; const dateStr = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); return { etH: h, dow, dateStr }; }

// New session map — crypto-NATIVE, 24h-aware:
// asia       = 20:00–02:00 ET  (Asia day session)
// eu_open    = 02:00–07:00 ET  (Europe open)
// us_premkt  = 07:00–09:30 ET  (US pre-market)
// us_morn    = 09:30–12:00 ET  (US morning)
// us_aft     = 12:00–16:00 ET  (US afternoon)
// us_late    = 16:00–17:00 ET  (US close into halt)
// halt       = 17:00–18:00 ET  (CME maintenance)
// us_eve     = 18:00–20:00 ET  (US evening)
function cryptoSession(d: Date): string {
  const { etH, dow } = etInfo(d);
  const weekend = dow === "Sat" || dow === "Sun";
  if (weekend) return "weekend";
  if (etH >= 17 && etH < 18) return "halt";
  if (etH >= 20 || etH < 2) return "asia";
  if (etH < 7) return "eu_open";
  if (etH < 9.5) return "us_premkt";
  if (etH < 12) return "us_morn";
  if (etH < 16) return "us_aft";
  if (etH < 17) return "us_late";
  return "us_eve";
}

// =================== Setup detection — crypto-tuned (different ATR mults) ===================
// Tested with a wider range of stop/target multipliers since crypto vol is 3-5x equity vol.
interface Setup { dir: "long" | "short"; stopDist: number; targetDist: number; score: number; type: string; }

interface St { sessionBars: Bar[]; barCount: number; orHigh: number; orLow: number; prevDayClose: number; prevDayHigh: number; prevDayLow: number; session: string }

// We generate MULTIPLE candidate strategies per bar — each with its own ATR multiplier
// for stop/target — to hunt for the right calibration.
function detectAllSetups(sym: string, bars: Bar[], st: St): Setup[] {
  const out: Setup[] = [];
  if (bars.length < 25) return out;
  const closes = bars.map(x => x.c);
  const price = bars[bars.length - 1].c;
  const rawATR = atr(bars);
  if (rawATR <= 0) return out;
  const currentRSI = rsi(closes) ?? 50;
  const fast = ema(closes, 9), slow = ema(closes, 21);
  const fastEMA = fast[fast.length - 1], slowEMA = slow[slow.length - 1];
  const vwap = (st.sessionBars.length >= 3 ? calcVwap(st.sessionBars) : calcVwap(bars.slice(-78))).vwap;
  const last20 = bars.slice(-20);
  const avgVol = last20.reduce((s, x) => s + x.v, 0) / 20;
  const bar = bars[bars.length - 1];
  const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
  const volTrend = volRatio > 2 ? "surge" : volRatio < 0.6 ? "dry" : volRatio < 0.8 ? "declining" : "normal";
  const tf15 = get15mTrend(bars);

  // —— RSI extreme bounce, with wider stops calibrated for crypto vol ——
  // Crypto vol burns through 1.5×ATR stops; try 2.5× and 3.5×.
  if (currentRSI < 25 || currentRSI > 75) {
    const isOversold = currentRSI < 25;
    const dir = isOversold ? "long" : "short";
    // Two stop widths; two reward multiples
    for (const stopMult of [2.5, 3.5]) {
      for (const targetMult of [2.5, 4.5]) {
        out.push({ dir, stopDist: rawATR * stopMult, targetDist: rawATR * targetMult, score: 0, type: `RSI${stopMult}x${targetMult}` });
      }
    }
  }
  // —— Trend continuation (with crypto-wider stops) ——
  const nearEMA = Math.abs(price - fastEMA) / price < 0.005; // wider than 0.003 for crypto
  if (nearEMA && (currentRSI > 35 && currentRSI < 65)) {
    const isLong = fastEMA > slowEMA && price > slowEMA;
    const isShort = fastEMA < slowEMA && price < slowEMA;
    if (isLong || isShort) {
      out.push({ dir: isLong ? "long" : "short", stopDist: rawATR * 2.5, targetDist: rawATR * 5.0, score: 0, type: "trend2.5x5" });
    }
  }
  // —— Mean reversion to VWAP — crypto often respects session VWAP ——
  if (st.sessionBars.length >= 12) {
    const vwapDist = (price - vwap) / vwap;
    if (Math.abs(vwapDist) > 0.01) { // >1% from VWAP
      const dir = vwapDist > 0 ? "short" : "long";
      out.push({ dir, stopDist: rawATR * 2.0, targetDist: Math.abs(price - vwap) * 0.8, score: 0, type: "vwap_revert" });
    }
  }
  // —— Higher-timeframe trend pullback (15m trend aligned) ——
  if (tf15.trend === "up" && currentRSI < 40 && volTrend !== "surge") {
    out.push({ dir: "long", stopDist: rawATR * 3.0, targetDist: rawATR * 5.0, score: 0, type: "trend_pullback_long" });
  }
  if (tf15.trend === "down" && currentRSI > 60 && volTrend !== "surge") {
    out.push({ dir: "short", stopDist: rawATR * 3.0, targetDist: rawATR * 5.0, score: 0, type: "trend_pullback_short" });
  }
  // —— Volume surge fade (crypto-specific — surges often mark exhaustion) ——
  if (volTrend === "surge" && volRatio > 3) {
    // Fade in direction opposite to bar direction
    const barDir = bar.c > bar.o ? "long" : "short";
    out.push({ dir: barDir === "long" ? "short" : "long", stopDist: rawATR * 2.5, targetDist: rawATR * 3.5, score: 0, type: "vol_surge_fade" });
  }
  return out;
}

// =================== Walk one symbol — emit ALL candidate trades ===================
interface Trade { sym: string; type: string; dir: string; entry: number; exit: number; pnl: number; r: number; outcome: string; entryTime: number; rsi: number; session: string; dow: string; }

function resolveExit(m1: Bar[], fromTime: number, dir: string, stop: number, target: number, maxTime: number): { px: number; outcome: string; exitTime: number } {
  const long = dir === "long";
  let lo = 0, hi = m1.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m1[mid].t < fromTime) lo = mid + 1; else hi = mid; }
  let last = lo;
  for (let j = lo; j < m1.length && m1[j].t <= maxTime; j++) {
    last = j; const b = m1[j];
    const hitStop = long ? b.l <= stop : b.h >= stop;
    const hitTarget = long ? b.h >= target : b.l <= target;
    if (hitStop && hitTarget) return { px: stop, outcome: "stop_ambig", exitTime: b.t };
    if (hitStop) return { px: stop, outcome: "stop", exitTime: b.t };
    if (hitTarget) return { px: target, outcome: "target", exitTime: b.t };
  }
  return { px: m1[last]?.c ?? stop, outcome: "time", exitTime: m1[last]?.t ?? maxTime };
}

function walk(sym: string): Trade[] {
  const { bars, dates, m1 } = loadBars5m(sym);
  const mult = MULT[sym], tick = TICK[sym];
  const trades: Trade[] = [];
  const st: St = { sessionBars: [], barCount: 0, orHigh: 0, orLow: 0, prevDayClose: 0, prevDayHigh: 0, prevDayLow: 0, session: "halt" };
  let lastDate = "";
  // Track open positions per setup type so we don't double-enter (one per type at a time)
  const blockedUntil: Record<string, number> = {};

  for (let i = 0; i < bars.length; i++) {
    const d = dates[i], info = etInfo(d), session = cryptoSession(d);
    st.session = session;
    if (info.dateStr !== lastDate) {
      if (st.sessionBars.length) {
        st.prevDayClose = st.sessionBars[st.sessionBars.length - 1].c;
        st.prevDayHigh = Math.max(...st.sessionBars.map(b => b.h));
        st.prevDayLow = Math.min(...st.sessionBars.map(b => b.l));
      }
      st.sessionBars = []; st.orHigh = 0; st.orLow = 0; st.barCount = 0;
      lastDate = info.dateStr;
    }
    st.sessionBars.push(bars[i]); st.barCount++;
    if (st.barCount <= 12) { st.orHigh = Math.max(st.orHigh, bars[i].h); st.orLow = st.orLow === 0 ? bars[i].l : Math.min(st.orLow, bars[i].l); }

    if (session === "halt" || session === "weekend") continue;
    const slice = bars.slice(Math.max(0, i - 199), i + 1);
    const setups = detectAllSetups(sym, slice, st);
    for (const setup of setups) {
      const key = setup.type;
      if (bars[i].t < (blockedUntil[key] || 0)) continue;
      const long = setup.dir === "long";
      const entry = long ? bars[i].c + tick : bars[i].c - tick;
      const stop = long ? entry - setup.stopDist : entry + setup.stopDist;
      const target = long ? entry + setup.targetDist : entry - setup.targetDist;
      const entryTime = bars[i].t + 300000;
      const ex = resolveExit(m1, entryTime, setup.dir, stop, target, entryTime + MAX_HOLD * 300000);
      const exitPx = long ? ex.px - tick : ex.px + tick;
      const pnl = (long ? exitPx - entry : entry - exitPx) * mult - COMM * 2;
      const riskDollars = setup.stopDist * mult;
      const entryRsi = rsi(slice.map(b => b.c)) ?? 50;
      trades.push({ sym, type: setup.type, dir: setup.dir, entry, exit: exitPx, pnl, r: riskDollars > 0 ? pnl / riskDollars : 0, outcome: ex.outcome, entryTime: bars[i].t, rsi: entryRsi, session: st.session, dow: info.dow });
      blockedUntil[key] = ex.exitTime;
    }
  }
  return trades;
}

// =================== Stats + scan ===================
function stats(trades: Trade[]) {
  const n = trades.length; if (!n) return null;
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return { n, wr: wins.length / n, exp: net / n, expR: trades.reduce((s, t) => s + t.r, 0) / n, pf: gl ? gw / gl : (gw > 0 ? Infinity : 0), net };
}
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(0)}`;
const sf = (s: ReturnType<typeof stats>) => s ? `n=${String(s.n).padStart(3)} PF ${(s.pf === Infinity ? "INF" : s.pf.toFixed(2)).padStart(5)} ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)}R net ${money(s.net).padStart(7)}` : "n=0";

async function main() {
  console.log("\n" + "═".repeat(110));
  console.log("  EDGE SCAN — crypto futures, broad filter scan");
  console.log("  Real edge bar: n≥50 IN AND n≥30 OUT, PF≥1.30 IN AND PF≥1.20 OUT, +R OOS");
  console.log("═".repeat(110));

  const all: Trade[] = [];
  for (const sym of ["MBT", "MET", "BFF"]) {
    try { all.push(...walk(sym)); console.log(`  ${sym} loaded`); } catch (e) { console.log(`  ${sym}: ${e instanceof Error ? e.message : e}`); }
  }
  console.log(`\nTotal candidate trades scanned: ${all.length}`);

  const SPLIT = new Date("2026-01-01").getTime();
  type F = { label: string; fn: (t: Trade) => boolean };

  const filters: F[] = [];
  // ALL setups by symbol
  for (const s of ["MBT", "MET", "BFF"]) filters.push({ label: `${s} ALL`, fn: t => t.sym === s });

  // By setup type per symbol
  const types = [...new Set(all.map(t => t.type))];
  for (const s of ["MBT", "MET", "BFF"]) {
    for (const ty of types) {
      filters.push({ label: `${s} ${ty}`, fn: t => t.sym === s && t.type === ty });
      filters.push({ label: `${s} ${ty} LONG`, fn: t => t.sym === s && t.type === ty && t.dir === "long" });
      filters.push({ label: `${s} ${ty} SHORT`, fn: t => t.sym === s && t.type === ty && t.dir === "short" });
    }
  }
  // By session (crypto-native sessions)
  const sessions = ["asia", "eu_open", "us_premkt", "us_morn", "us_aft", "us_late", "us_eve"];
  for (const s of ["MBT", "MET", "BFF"]) {
    for (const sess of sessions) {
      filters.push({ label: `${s} ALL in ${sess}`, fn: t => t.sym === s && t.session === sess });
    }
  }
  // By day of week (BFF specifically — weekly expiry Fri)
  for (const dow of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
    filters.push({ label: `BFF ${dow}`, fn: t => t.sym === "BFF" && t.dow === dow });
  }
  // RSI sub-bands for RSI strategies
  for (const s of ["MBT", "MET", "BFF"]) {
    filters.push({ label: `${s} RSI LONG rsi<15`, fn: t => t.sym === s && t.type.startsWith("RSI") && t.dir === "long" && t.rsi < 15 });
    filters.push({ label: `${s} RSI LONG rsi<20`, fn: t => t.sym === s && t.type.startsWith("RSI") && t.dir === "long" && t.rsi < 20 });
    filters.push({ label: `${s} RSI SHORT rsi>80`, fn: t => t.sym === s && t.type.startsWith("RSI") && t.dir === "short" && t.rsi > 80 });
    filters.push({ label: `${s} RSI SHORT rsi>85`, fn: t => t.sym === s && t.type.startsWith("RSI") && t.dir === "short" && t.rsi > 85 });
  }

  const scanned = filters.map(f => {
    const ts = all.filter(f.fn);
    return { f, si: stats(ts.filter(t => t.entryTime < SPLIT)), so: stats(ts.filter(t => t.entryTime >= SPLIT)) };
  }).filter(r => r.si && r.so && r.si.n >= 30 && r.so.n >= 20).sort((a, b) => (b.so!.expR) - (a.so!.expR));

  console.log("\n— TOP 30 BY OOS EXPECTANCY —\n");
  let robustCount = 0;
  for (const r of scanned.slice(0, 30)) {
    const robust = r.si!.pf >= 1.30 && r.si!.expR > 0 && r.so!.pf >= 1.20 && r.so!.expR >= 0.10 && r.si!.n >= 50 && r.so!.n >= 30;
    if (robust) robustCount++;
    console.log(`  ${robust ? "✅" : "  "} ${r.f.label.padEnd(34)} IN ${sf(r.si).padEnd(38)} | OUT ${sf(r.so)}`);
  }
  console.log(`\n— ROBUST EDGES FOUND: ${robustCount} —`);
  if (robustCount === 0) {
    console.log("  No subset cleared the bar. The strategy does not have a crypto futures edge.");
  } else {
    console.log("  Re-run with bigger sample and validate vs live execution before any wiring.");
  }
  console.log("═".repeat(110) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
