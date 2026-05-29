/**
 * BACKTESTER — CRYPTO FUTURES variant. Same engine setup logic, configured for
 * MBT/MET/BFF/ETF (CME crypto micros).
 *
 * NOTE: this reuses the strategy logic verbatim from scripts/backtest.ts; only the
 * per-instrument config (multipliers, tick sizes, gap thresholds) and the symbol
 * universe change. We KEEP the same RTH session windows as equity futures even
 * though crypto trades nearly 24h — that's a deliberate first-cut choice to see
 * whether our engine's edge translates. Crypto-native sessions (Asia open, etc.)
 * are a follow-up refinement if results justify it.
 *
 * Run: npx tsx scripts/backtest-crypto.ts
 */
import fs from "node:fs";

// ===================== exact math (verbatim from scripts/backtest.ts) =====================
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
function scoreSetup(f: { baseConfidence: number; volTrend: string; volRatio: number; trend15Aligns: boolean; rsiExtreme: boolean; priceAboveVWAP: boolean; dayTypeMatch: boolean; sessionQuality: string }): number {
  let s = f.baseConfidence;
  if (f.volTrend === "surge" && f.volRatio > 2) s += 8;
  else if (f.volTrend === "declining") s += 5;
  else if (f.volTrend === "dry") s -= 5;
  s += f.trend15Aligns ? 10 : -10;
  if (f.rsiExtreme) s += 3;
  if (f.priceAboveVWAP) s += 3;
  if (f.sessionQuality === "prime") s += 5; else if (f.sessionQuality === "avoid") s -= 10;
  return Math.max(0, Math.min(100, s));
}

// ===================== CRYPTO config =====================
// MULT = $ per 1.00 price-point per contract.
// MBT/BFF underlying = BTC price; MET/ETF underlying = ETH price.
//   MBT 0.1 BTC  → $0.10 per $1 BTC move    | tick 5 BTC pts = $0.50/tick
//   MET 0.1 ETH  → $0.10 per $1 ETH move    | tick 0.50 ETH pts = $0.05/tick
//   BFF 0.01 BTC → $0.01 per $1 BTC move    | tick 5 BTC pts = $0.05/tick
//   ETF 0.1 ETH  → $0.10 per $1 ETH move    | tick 0.50 ETH pts = $0.05/tick (weekly)
const MULT: Record<string, number> = { MBT: 0.10, MET: 0.10, BFF: 0.01, ETF: 0.10 };
const TICK: Record<string, number> = { MBT: 5,    MET: 0.50, BFF: 5,    ETF: 0.50 };
// Gap thresholds in PRICE POINTS (BTC pts for MBT/BFF, ETH pts for MET/ETF)
const GAP_THRESHOLDS: Record<string, number> = { MBT: 3000, MET: 200, BFF: 3000, ETF: 200 };
// Crypto futures aren't "metals" — no extra ATR scale boost
const COMMISSION_PER_SIDE = 2.0;  // CME crypto micro commission estimate
const MAX_HOLD = 78;              // bars (~6.5h)

// ===================== load + aggregate =====================
function loadBars5m(sym: string): { bars: Bar[]; dates: Date[]; m1: Bar[] } {
  const path = new URL(`../data/${sym}_1m.csv`, import.meta.url);
  if (!fs.existsSync(path)) throw new Error(`missing data/${sym}_1m.csv — run dbn-fetch-crypto first`);
  const rows = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
  const m1: Bar[] = [];
  for (const r of rows) {
    const c = r.split(",");
    const t = new Date(c[0]).getTime();
    m1.push({ t, o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] });
  }
  const buckets = new Map<number, Bar>();
  for (const b of m1) {
    const key = Math.floor(b.t / 300000) * 300000;
    const ex = buckets.get(key);
    if (!ex) buckets.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; }
  }
  const bars = [...buckets.values()].sort((a, b) => a.t - b.t);
  m1.sort((a, b) => a.t - b.t);
  return { bars, dates: bars.map(b => new Date(b.t)), m1 };
}

// ===================== sessions (same RTH map as equity futures) =====================
function etInfo(d: Date) {
  const s = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" });
  const dow = s.slice(0, 3);
  const hm = s.match(/(\d{2}):(\d{2})/);
  const h = hm ? +hm[1] + +hm[2] / 60 : 0;
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return { etH: h, dow, dateStr, weekend: dow === "Sat" || dow === "Sun" };
}
function sessionName(d: Date): string {
  const { etH, weekend } = etInfo(d);
  if (weekend || (etH >= 17 && etH < 18)) return "halt";
  if (etH >= 9.5 && etH < 16) {
    if ((etH - 9.5) * 60 < 15) return "open";
    if (etH < 12) return "morning";
    if (etH < 14) return "midday";
    if (etH < 15.75) return "afternoon";
    return "close";
  }
  return "eth";
}

// ===================== setup detection (ported line-for-line from backtest.ts) =====================
interface Setup { dir: "long" | "short"; stopDist: number; targetDist: number; score: number; type: string; }

function detectSetup(sym: string, bars: Bar[], st: { sessionBars: Bar[]; barCount: number; orHigh: number; orLow: number; prevDayClose: number; prevDayHigh: number; prevDayLow: number; session: string }): Setup | null {
  if (bars.length < 25) return null;
  const closes = bars.map(x => x.c);
  const price = bars[bars.length - 1].c;
  const rawATR = atr(bars);
  if (rawATR <= 0) return null;
  const adjustedATR = rawATR; // no metals scale, no VIX scale
  const currentATR = rawATR;
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
  const orSize = st.orHigh - st.orLow;
  const outsideRange = (st.prevDayHigh > 0 && price > st.prevDayHigh) || (st.prevDayLow > 0 && price < st.prevDayLow);
  const dayType = outsideRange || orSize > currentATR * 0.5 ? "trend" : "range";
  const session = st.session;
  const sizeMult = (session === "morning" || session === "afternoon") ? 1.0 : session === "midday" ? 0.5 : session === "eth" ? 0.5 : session === "open" ? 0.5 : 0;
  if (sizeMult <= 0) return null;
  const sessionQuality = sizeMult >= 1 ? "prime" : sizeMult >= 0.5 ? "good" : "avoid";

  // SETUP 0: Extreme RSI bounce
  if ((currentRSI < 25 || currentRSI > 75) && volTrend !== "surge") {
    const isOversold = currentRSI < 25;
    const dir = isOversold ? "long" : "short";
    const score = scoreSetup({ baseConfidence: 70, volTrend, volRatio, trend15Aligns: isOversold ? tf15.trend !== "down" : tf15.trend !== "up", rsiExtreme: true, priceAboveVWAP: false, dayTypeMatch: true, sessionQuality });
    if (score >= 75) return { dir, stopDist: adjustedATR * 1.5, targetDist: currentATR * 3.5, score, type: "RSI bounce" };
  }
  // GAP FILL
  if (st.barCount >= 1 && st.barCount <= 6 && st.prevDayClose > 0 && (session === "open" || session === "morning")) {
    const gap = st.sessionBars.length > 0 ? st.sessionBars[0].o - st.prevDayClose : 0;
    const absGap = Math.abs(gap), maxGap = GAP_THRESHOLDS[sym] || 10;
    if (absGap > 1 && absGap < maxGap) {
      const dir = gap > 0 ? "short" : "long";
      const gapTarget = Math.abs(price - st.prevDayClose) * 0.8, gapStop = absGap * 1.5;
      if (gapTarget > currentATR * 0.3) {
        const score = scoreSetup({ baseConfidence: 75, volTrend, volRatio, trend15Aligns: true, rsiExtreme: false, priceAboveVWAP: false, dayTypeMatch: true, sessionQuality });
        if (score >= 75) return { dir, stopDist: gapStop, targetDist: gapTarget, score, type: "gap fill" };
      }
    }
  }
  // OR BREAKOUT
  const isMorningSession = session === "morning";
  if (dayType === "trend" && isMorningSession && st.barCount >= 12 && st.orHigh > 0 && orSize > currentATR * 0.3) {
    const isLong = price > st.orHigh && volRatio > 1.5, isShort = price < st.orLow && volRatio > 1.5;
    if (isLong || isShort) {
      const dir = isLong ? "long" : "short";
      const score = scoreSetup({ baseConfidence: 65, volTrend, volRatio, trend15Aligns: isLong ? tf15.trend === "up" : tf15.trend === "down", rsiExtreme: false, priceAboveVWAP: isLong ? price > vwap : price < vwap, dayTypeMatch: true, sessionQuality });
      if (score >= 75) return { dir, stopDist: Math.max(orSize * 0.5, adjustedATR), targetDist: orSize * 2.5, score, type: "OR breakout" };
    }
  }
  // FAILED IB BREAKOUT
  if (st.barCount >= 13 && st.orHigh > 0 && (session === "morning" || session === "midday" || session === "afternoon")) {
    const recent = bars.slice(-6);
    const testedHigh = recent.some(x => x.h > st.orHigh), testedLow = recent.some(x => x.l < st.orLow);
    const backInRange = price < st.orHigh && price > st.orLow;
    if (backInRange && (testedHigh || testedLow) && volTrend !== "surge") {
      const dir = testedHigh ? "short" : "long";
      const ibMid = (st.orHigh + st.orLow) / 2;
      const failTarget = Math.abs(price - ibMid);
      const failStop = testedHigh ? Math.abs(st.orHigh - price) + currentATR * 0.5 : Math.abs(price - st.orLow) + currentATR * 0.5;
      if (failTarget / failStop >= 2.0) {
        const score = scoreSetup({ baseConfidence: 73, volTrend, volRatio, trend15Aligns: dir === "short" ? tf15.trend === "down" : tf15.trend === "up", rsiExtreme: testedHigh ? currentRSI > 65 : currentRSI < 35, priceAboveVWAP: dir === "short" ? price > vwap : price < vwap, dayTypeMatch: true, sessionQuality });
        if (score >= 75) return { dir, stopDist: failStop, targetDist: failTarget, score, type: "failed IB" };
      }
    }
  }
  // IB EXTENSION
  if (st.barCount >= 12 && st.barCount <= 36 && st.orHigh > 0 && orSize > currentATR * 0.4 && (session === "morning" || session === "midday")) {
    const ext15 = orSize * 1.5;
    const breakAbove = price > st.orHigh && price < st.orHigh + ext15, breakBelow = price < st.orLow && price > st.orLow - ext15;
    if ((breakAbove || breakBelow) && volRatio > 1.2) {
      const dir = breakAbove ? "long" : "short";
      const targetLevel = breakAbove ? st.orHigh + ext15 : st.orLow - ext15;
      const distToTarget = Math.abs(price - targetLevel);
      if (distToTarget > currentATR * 0.5) {
        const score = scoreSetup({ baseConfidence: 72, volTrend, volRatio, trend15Aligns: breakAbove ? tf15.trend === "up" : tf15.trend === "down", rsiExtreme: false, priceAboveVWAP: breakAbove ? price > vwap : price < vwap, dayTypeMatch: dayType === "trend", sessionQuality });
        if (score >= 72) return { dir, stopDist: Math.max(orSize * 0.5, adjustedATR), targetDist: distToTarget, score, type: "IB extension" };
      }
    }
  }
  // TREND CONTINUATION
  if ((dayType === "trend" || Math.abs(fastEMA - slowEMA) / price > 0.001) && (session === "morning" || session === "afternoon")) {
    const nearEMA = Math.abs(price - fastEMA) / price < 0.003;
    const isLong = nearEMA && fastEMA > slowEMA && price > slowEMA && currentRSI > 35 && currentRSI < 65 && volTrend !== "surge";
    const isShort = nearEMA && fastEMA < slowEMA && price < slowEMA && currentRSI > 35 && currentRSI < 65 && volTrend !== "surge";
    if (isLong || isShort) {
      const dir = isLong ? "long" : "short";
      const score = scoreSetup({ baseConfidence: 72, volTrend, volRatio, trend15Aligns: isLong ? tf15.trend === "up" : tf15.trend === "down", rsiExtreme: false, priceAboveVWAP: isLong ? price > vwap : price < vwap, dayTypeMatch: dayType === "trend", sessionQuality });
      if (score >= 75) return { dir, stopDist: adjustedATR * 1.5, targetDist: adjustedATR * 4.0, score, type: "trend continuation" };
    }
  }
  return null;
}

// ===================== backtest loop =====================
interface Trade { sym: string; type: string; dir: string; entry: number; exit: number; pnl: number; r: number; bars: number; outcome: string; entryTime: number; rsi: number; session: string; }

function resolveExit(m1: Bar[], fromTime: number, dir: string, stop: number, target: number, maxTime: number): { px: number; outcome: string; exitTime: number; bars1m: number } {
  const long = dir === "long";
  let lo = 0, hi = m1.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m1[mid].t < fromTime) lo = mid + 1; else hi = mid; }
  let last = lo;
  for (let j = lo; j < m1.length && m1[j].t <= maxTime; j++) {
    last = j; const b = m1[j];
    const hitStop = long ? b.l <= stop : b.h >= stop;
    const hitTarget = long ? b.h >= target : b.l <= target;
    if (hitStop && hitTarget) return { px: stop, outcome: "stop(1m-ambig)", exitTime: b.t, bars1m: j - lo };
    if (hitStop) return { px: stop, outcome: "stop", exitTime: b.t, bars1m: j - lo };
    if (hitTarget) return { px: target, outcome: "target", exitTime: b.t, bars1m: j - lo };
  }
  return { px: m1[last]?.c ?? stop, outcome: "time", exitTime: m1[last]?.t ?? maxTime, bars1m: last - lo };
}

function backtest(sym: string): Trade[] {
  const { bars, dates, m1 } = loadBars5m(sym);
  const mult = MULT[sym], tick = TICK[sym];
  const trades: Trade[] = [];
  const st = { sessionBars: [] as Bar[], barCount: 0, orHigh: 0, orLow: 0, prevDayClose: 0, prevDayHigh: 0, prevDayLow: 0, session: "halt" };
  let lastDate = "";
  let blockedUntil = 0;

  for (let i = 0; i < bars.length; i++) {
    const d = dates[i], info = etInfo(d), session = sessionName(d);
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

    if (bars[i].t < blockedUntil) continue;
    const slice = bars.slice(Math.max(0, i - 199), i + 1);
    const setup = detectSetup(sym, slice, st);
    if (setup) {
      const long = setup.dir === "long";
      const entry = long ? bars[i].c + tick : bars[i].c - tick;
      const stop = long ? entry - setup.stopDist : entry + setup.stopDist;
      const target = long ? entry + setup.targetDist : entry - setup.targetDist;
      const entryTime = bars[i].t + 300000;
      const ex = resolveExit(m1, entryTime, setup.dir, stop, target, entryTime + MAX_HOLD * 300000);
      const exitPx = long ? ex.px - tick : ex.px + tick;
      const pnl = (long ? exitPx - entry : entry - exitPx) * mult - COMMISSION_PER_SIDE * 2;
      const riskDollars = setup.stopDist * mult;
      const entryRsi = rsi(slice.map(b => b.c)) ?? 50;
      trades.push({ sym, type: setup.type, dir: setup.dir, entry, exit: exitPx, pnl, r: riskDollars > 0 ? pnl / riskDollars : 0, bars: ex.bars1m, outcome: ex.outcome, entryTime: bars[i].t, rsi: entryRsi, session: st.session });
      blockedUntil = ex.exitTime;
    }
  }
  return trades;
}

// ===================== metrics + report =====================
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(0)}`;
function stats(trades: Trade[]) {
  const n = trades.length; if (!n) return null;
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades) { cum += t.pnl; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n, wr: wins.length / n, avgW: wins.length ? gw / wins.length : 0, avgL: losses.length ? gl / losses.length : 0,
    exp: net / n, expR: trades.reduce((s, t) => s + t.r, 0) / n, pf: gl ? gw / gl : (gw > 0 ? Infinity : 0), net, dd };
}
function printStats(label: string, trades: Trade[]) {
  const s = stats(trades);
  if (!s) { console.log(`  ${label}: 0 trades`); return; }
  console.log(`  ${label.padEnd(22)} n=${String(s.n).padStart(4)} | win ${(s.wr * 100).toFixed(0)}% | exp ${money(s.exp).padStart(7)}/trade (${s.expR.toFixed(2)}R) | PF ${s.pf === Infinity ? "INF" : s.pf.toFixed(2)} | net ${money(s.net).padStart(8)} | maxDD ${money(s.dd)}`);
}

async function main() {
  console.log("\n" + "═".repeat(78));
  console.log("  CRYPTO BACKTEST — engine logic over Databento crypto futures history");
  console.log("═".repeat(78));
  const all: Trade[] = [];
  const SYMBOLS = ["MBT", "MET", "BFF", "ETF"];
  for (const sym of SYMBOLS) {
    try {
      const t = backtest(sym);
      all.push(...t);
      const { bars } = loadBars5m(sym);
      console.log(`\n${sym} (${bars.length} 5m bars):`);
      printStats("ALL", t);
      for (const type of [...new Set(t.map(x => x.type))]) printStats("• " + type, t.filter(x => x.type === type));
    } catch (e) {
      console.log(`\n${sym}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("\n" + "─".repeat(78));
  console.log("COMBINED (all crypto symbols):"); printStats("ALL SETUPS", all);
  for (const type of [...new Set(all.map(x => x.type))]) printStats("• " + type, all.filter(x => x.type === type));

  // ---- WALK-FORWARD: in-sample vs OOS ----
  const SPLIT = new Date("2026-01-01").getTime();
  const fmt = (s: ReturnType<typeof stats>) => s ? `n=${String(s.n).padStart(4)} PF ${s.pf === Infinity ? "INF" : s.pf.toFixed(2)} net ${money(s.net).padStart(8)} ${(s.wr * 100).toFixed(0)}%w` : "n=0";
  const wf = (label: string, ts: Trade[]) => console.log(`  ${label.padEnd(24)} IN: ${fmt(stats(ts.filter(t => t.entryTime < SPLIT))).padEnd(42)} | OUT: ${fmt(stats(ts.filter(t => t.entryTime >= SPLIT)))}`);
  console.log("\n── WALK-FORWARD — IN-sample (pre-2026) vs OUT-OF-SAMPLE (2026+) ──");
  wf("ALL", all);
  for (const sym of SYMBOLS) wf(sym, all.filter(t => t.sym === sym));

  // ---- BY YEAR ----
  const yearOf = (t: Trade) => new Date(t.entryTime).getUTCFullYear();
  const years = [...new Set(all.map(yearOf))].sort();
  const yr = (label: string, ts: Trade[]) => {
    const parts = years.map(y => { const s = stats(ts.filter(t => yearOf(t) === y)); return s ? `${y} PF${(s.pf === Infinity ? "INF" : s.pf.toFixed(2))} ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)}R/${s.n}` : `${y} —`; });
    console.log(`  ${label.padEnd(24)} ${parts.join("  ")}`);
  };
  console.log("\n── BY YEAR — does the edge hold up across regimes? ──");
  yr("ALL", all);
  for (const sym of SYMBOLS) yr(sym, all.filter(t => t.sym === sym));

  // ---- $1K LIVE FEASIBILITY ----
  // Per-symbol notional and ATR-based risk: is the per-contract risk meaningful for a $1K acct?
  console.log("\n── $1K LIVE FEASIBILITY (per-contract sensitivity vs $50 risk budget) ──");
  for (const sym of SYMBOLS) {
    const t = all.filter(x => x.sym === sym);
    if (!t.length) { console.log(`  ${sym.padEnd(4)} no trades`); continue; }
    const avgRiskDollars = t.reduce((s, x) => s + Math.abs(x.pnl - x.r), 0) / t.length; // rough
    // Better: median stop-distance × multiplier
    const stops = t.map(x => Math.abs(x.entry - x.exit) || 1).sort((a, b) => a - b);
    const medStop = stops[Math.floor(stops.length / 2)];
    const dollarRiskPerContract = medStop * MULT[sym];
    const fitsOnRiskBudget = dollarRiskPerContract <= 50;
    const contractsToHit50Risk = Math.max(1, Math.round(50 / Math.max(dollarRiskPerContract, 0.01)));
    console.log(`  ${sym.padEnd(4)} median stop ~${medStop.toFixed(1)} pts → $${dollarRiskPerContract.toFixed(2)}/contract risk  ${fitsOnRiskBudget ? "✓ fits 1-contract" : `→ need ${contractsToHit50Risk} contracts to hit $50 risk`}`);
  }

  console.log("\n⚠️  Caveats: technical setups only (no AI overlay); RTH sessions used (crypto trades nearly 24h);");
  console.log("    1-tick slippage + $2.00/side commission; min sample for confidence = 100 trades.");
  console.log("═".repeat(78) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
