/**
 * INDEX EDGE VALIDATION — both live index edges, engine-exact, session-by-session.
 *
 * Answers "is the gold session/direction finding only a gold thing?" and CORRECTS the bar-buffer
 * error in scripts/trend-long-validation.ts, which built RTH-only bars. The engine's onPrice()
 * (line 683-716) builds 5-min bars from every tick with NO session gate and keeps a rolling 200
 * (`if (b.bars5m.length > 200) b.bars5m.shift()`), so indicators run on ~16.7h of CONTINUOUS 24h
 * data. That is what this script reproduces.
 *
 * TWO EDGES, exactly as the registry gates them (src/lib/realtime-edges.ts):
 *   index_trend_long        trend_continuation + direction long           (line 2903-2928)
 *   index_overbought_short  extreme_rsi_bounce + short + RSI >= 80        (line 2718-2750)
 *   extreme_rsi_bounce LONG on an index matches NO registered edge -> never trades. Modelled.
 *
 * SESSIONS (getSizeMultiplier line 989-994) — LIVE index: morning/afternoon 1.0, midday 0.5,
 *   everything else 0 (the evening exception is metals-only; index overnight margin ~$2,657 is too
 *   heavy for this account). G_ALL_SESSIONS=1 tests the blocked hours as if enabled, to check
 *   whether there is index opportunity we simply never trade.
 *   NOTE trend_continuation additionally requires session morning|afternoon in its own condition,
 *   so midday can only ever produce RSI-bounce shorts.
 *
 * MANAGEMENT: 0.6R breakeven, 1.1R trail at 0.9*1.5 = 1.35x ATR (index), 65% profit-lock past 1R,
 *   30-min stale exit, flat when the tradeable window ends. 1 contract, no scale-out, no pyramid.
 *
 * KNOWN LIMITATION (this explains why this harness fires ~3x more than production): the engine
 *   evaluates gap_fill / or_breakout / failed_ib_breakout / ib_extension BEFORE trend_continuation
 *   and `return`s after any of them scores >= 75 — even when the edge gate then rejects the trade.
 *   Those setups therefore CONSUME bars that trend_continuation would otherwise have taken. They
 *   are not modelled here, so treat absolute counts and totals as an upper bound on activity.
 *   Relative comparisons (session vs session, direction vs direction) are unaffected.
 *
 * Usage: TL_DATA_DIR=data/live-window npx tsx scripts/index-edge-validation.ts ES
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const DATA_DIR = process.env.TL_DATA_DIR || "data";
const ALL_SESSIONS = process.env.G_ALL_SESSIONS === "1";
const SINCE = process.env.G_SINCE || "";

const SPEC: Record<string, { ptVal: number; tick: number; label: string }> = {
  ES: { ptVal: 5, tick: 0.25, label: "ES → MES ($5/pt)" },
  NQ: { ptVal: 2, tick: 0.25, label: "NQ → MNQ ($2/pt)" },
  YM: { ptVal: 0.5, tick: 1, label: "YM → MYM ($0.50/pt)" },
};
const COMMISSION = 2.02, VIX_STOP_MULT = 1.0;
const BREAKEVEN_R = 0.6, TRAIL_R = 1.1;
const STALE_MIN = process.env.G_STALE === "none" ? Infinity : (parseFloat(process.env.G_STALE || "") || 30);
const TRAIL_ATR_MULT = 0.9 * 1.5;   // index
const PROFIT_LOCK_FRAC = 0.65, BUFFER = 200;

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offCache = new Map<number, number>();
function etOffset(t: number): number {
  const hr = Math.floor(t / 3600000);
  const hit = offCache.get(hr); if (hit !== undefined) return hit;
  const p: any = {}; for (const x of etFmt.formatToParts(hr * 3600000)) p[x.type] = x.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  const off = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute) - hr * 3600000;
  offCache.set(hr, off); return off;
}
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; day: number; hour: number; dayISO: string; }
function sessionName(hour: number, dow: number): string {
  if (dow === 6 || (dow === 5 && hour >= 17) || (dow === 0 && hour < 18)) return "halt";
  if (hour >= 17 && hour < 18) return "halt";
  if (hour >= 9.5 && hour < 16) {
    const m = (hour - 9.5) * 60;
    if (m < 15) return "open";
    if (hour < 12) return "morning";
    if (hour < 14) return "midday";
    if (hour < 15.75) return "afternoon";
    return "close";
  }
  if ((hour >= 16 && hour < 17) || (hour >= 18 && hour < 22)) return "eth_evening";
  if (hour >= 22 || hour < 3) return "eth_asia";
  if (hour >= 3 && hour < 9) return "eth_europe";
  return "pre_market";
}
function indexSizeMult(s: string): number {
  if (s === "morning" || s === "afternoon") return 1.0;
  if (s === "midday") return 0.5;
  if (ALL_SESSIONS && s !== "halt") return 0.5;
  return 0;
}
function load(file: string) {
  const text = fs.readFileSync(new URL(file, ROOT), "utf8");
  const lines = text.split("\n");
  const m1: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i]; if (!r) continue;
    const f = r.split(","); const t = Date.parse(f[0]); const c = +f[7];
    if (!isFinite(t) || !isFinite(c) || c <= 0) continue;
    const etMs = t + etOffset(t); const day = Math.floor(etMs / 86400000);
    m1.push({ t, o: +f[4], h: +f[5], l: +f[6], c, v: +f[8] || 0, day, hour: (etMs - day * 86400000) / 3600000, dayISO: new Date(etMs).toISOString().slice(0, 10) });
  }
  const m5: Bar[] = []; let key = -1;
  for (const b of m1) {
    const k = Math.floor(b.t / 300000);
    if (k !== key) { key = k; m5.push({ ...b, t: k * 300000 }); }
    else { const j = m5.length - 1; if (b.h > m5[j].h) m5[j].h = b.h; if (b.l < m5[j].l) m5[j].l = b.l; m5[j].c = b.c; m5[j].v += b.v; }
  }
  return { m1, m5 };
}
function rsiOf(c: number[], p = 14) { if (c.length < p + 1) return 50; let g = 0, l = 0; for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + (g / p) / (l / p)); }
function atrOf(b: Bar[], p = 14) { if (b.length < p + 1) return 0; let s = 0; for (let i = b.length - p; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); return s / p; }
function emaLast(c: number[], period: number) { const k = 2 / (period + 1); let r = c[0]; for (let i = 1; i < c.length; i++) r = c[i] * k + r * (1 - k); return r; }
function trend15(buf: Bar[]): "up" | "down" | "flat" {
  const c15: number[] = []; for (let i = 0; i + 2 < buf.length; i += 3) c15.push(buf[i + 2].c);
  if (c15.length < 21) return "flat";
  const a = emaLast(c15, 9), b = emaLast(c15, 21); return a > b ? "up" : a < b ? "down" : "flat";
}

interface T { dayISO: string; session: string; edge: string; pnl: number; r: number; exit: string; }

function backtest(sym: string, m1: Bar[], m5: Bar[]): T[] {
  const S = SPEC[sym]; const trades: T[] = [];
  const dayHi = new Map<number, number>(), dayLo = new Map<number, number>();
  const orH = new Map<number, number>(), orL = new Map<number, number>(), orN = new Map<number, number>();
  for (const b of m5) {
    dayHi.set(b.day, Math.max(dayHi.get(b.day) ?? -Infinity, b.h));
    dayLo.set(b.day, Math.min(dayLo.get(b.day) ?? Infinity, b.l));
    if (b.hour >= 9.5 && (orN.get(b.day) ?? 0) < 12) {
      orH.set(b.day, Math.max(orH.get(b.day) ?? -Infinity, b.h));
      orL.set(b.day, Math.min(orL.get(b.day) ?? Infinity, b.l));
      orN.set(b.day, (orN.get(b.day) ?? 0) + 1);
    }
  }
  const dayList = [...new Set(m5.map(b => b.day))].sort((a, b) => a - b);
  const prevDay = new Map<number, number>(); for (let i = 1; i < dayList.length; i++) prevDay.set(dayList[i], dayList[i - 1]);
  let vwapDay = -1, cumPV = 0, cumV = 0, m1Cursor = 0;

  for (let i = BUFFER; i < m5.length; i++) {
    const bar = m5[i];
    if (bar.day !== vwapDay) { vwapDay = bar.day; cumPV = 0; cumV = 0; }
    const tp = (bar.h + bar.l + bar.c) / 3; cumPV += tp * bar.v; cumV += bar.v;
    const vwap = cumV > 0 ? cumPV / cumV : bar.c;
    const dow = new Date(bar.t + etOffset(bar.t)).getUTCDay();
    const session = sessionName(bar.hour, dow);
    const sizeMult = indexSizeMult(session);
    if (sizeMult <= 0) continue;

    const buf = m5.slice(i - BUFFER + 1, i + 1);
    const closes = buf.map(b => b.c);
    const rawATR = atrOf(buf); if (rawATR <= 0) continue;
    const currentATR = rawATR;                       // index atrScale = 1.0
    const adjustedATR = currentATR * VIX_STOP_MULT;
    const rsi = rsiOf(closes);
    const price = bar.c;
    let volSum = 0; for (let j = buf.length - 20; j < buf.length; j++) volSum += buf[j].v;  // engine includes the current bar
    const avgVol = volSum / 20;
    const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
    const volTrend = volRatio > 2 ? "surge" : volRatio < 0.6 ? "dry" : volRatio < 0.8 ? "declining" : "normal";
    const sessScore = sizeMult >= 1 ? 5 : sizeMult >= 0.5 ? 0 : -10;
    const t15 = trend15(buf);
    // Hoisted 2026-07-29 so SETUP 0 can use it too (was computed inside SETUP 2 only). Needed to test
    // whether the overbought SHORT is really a downtrend trade rather than a mean-reversion fade —
    // the demo scoreboard's 7-trade winning streak exited 6/7 on trail_stop, i.e. price kept falling.
    const ema200 = closes.length >= 200 ? emaLast(closes, 200) : Infinity;

    let edge = "", dir: "long" | "short" = "long", stopDist = 0, targetDist = 0;

    // SETUP 0 — extreme RSI bounce (evaluated first by the engine)
    if ((rsi < 25 || rsi > 75) && volTrend !== "surge") {
      const isOversold = rsi < 25;
      let sc = 70;
      if (volTrend === "declining") sc += 5; else if (volTrend === "dry") sc -= 5;
      sc += (isOversold ? t15 !== "down" : t15 !== "up") ? 10 : -10;
      sc += 3; sc += sessScore;
      // registry: index only permits the SHORT side, and only at RSI >= 80
      if (Math.max(0, Math.min(100, sc)) >= 75 && !isOversold && rsi >= 80) {
        edge = "index_overbought_short"; dir = "short";
        stopDist = adjustedATR * 1.5; targetDist = currentATR * 3.5;
        // REGIME SPLIT (2026-07-29). Disjoint, same pattern as index_trend_short_below200:
        //   _below200 = price BELOW the 200-EMA → shorting WITH the trend (a momentum short)
        //   the base row = price ABOVE it       → the true counter-trend overbought fade
        // Tests the hypothesis behind demo's 7-trade streak: those wins came in a hard down-market,
        // so if the edge is real it should live entirely in the below-200 bucket.
        if (price < ema200) edge = "index_overbought_short_below200";
      } else continue; // an extreme-RSI bar that fails the gate is consumed by the engine either way
    }

    // SETUP 2 — trend continuation (long only per the registry)
    if (!edge && (session === "morning" || session === "afternoon")) {
      const fastEMA = emaLast(closes, 9), slowEMA = emaLast(closes, 21);
      const first = orN.get(bar.day) ? orH.get(bar.day)! - orL.get(bar.day)! : 0;
      const pd = prevDay.get(bar.day);
      const pdH = pd != null ? dayHi.get(pd)! : 0, pdL = pd != null ? dayLo.get(pd)! : 0;
      const outside = (pdH > 0 && price > pdH) || (pdL > 0 && price < pdL);
      const dayType = outside || first > currentATR * 0.5 ? "trend" : "range";
      if (dayType === "trend" || Math.abs(fastEMA - slowEMA) / price > 0.001) {
        const nearEMA = Math.abs(price - fastEMA) / price < 0.003;
        if (nearEMA && fastEMA > slowEMA && price > slowEMA && price > ema200 && rsi > 35 && rsi < 65 && volTrend !== "surge") {
          let sc = 72;
          if (volTrend === "declining") sc += 5; else if (volTrend === "dry") sc -= 5;
          sc += t15 === "up" ? 10 : -10;
          if (price > vwap) sc += 3;
          sc += sessScore;
          if (Math.max(0, Math.min(100, sc)) >= 75) {
            edge = "index_trend_long"; dir = "long";
            stopDist = adjustedATR * 1.5; targetDist = adjustedATR * 4.0;
          }
        }
        // SHORT side — added 2026-07-29. The engine ALREADY generates these (futures-realtime.ts
        // isShort) and they are the only thing that fires on a down-trending morning, but no
        // registered edge matches trend_continuation/short so every one is default-denied. On
        // 2026-07-29 that meant ZERO live trades while the engine printed 9 short signals at 85-95%
        // confidence. Mirrors the engine exactly, including its ASYMMETRY: the long requires
        // price > 200-EMA, the short has NO 200-EMA filter.
        else if (nearEMA && fastEMA < slowEMA && price < slowEMA && rsi > 35 && rsi < 65 && volTrend !== "surge") {
          let sc = 72;
          if (volTrend === "declining") sc += 5; else if (volTrend === "dry") sc -= 5;
          sc += t15 === "down" ? 10 : -10;
          if (price < vwap) sc += 3;
          sc += sessScore;
          if (Math.max(0, Math.min(100, sc)) >= 75) {
            edge = "index_trend_short"; dir = "short";
            stopDist = adjustedATR * 1.5; targetDist = adjustedATR * 4.0;
            // Flag whether the SYMMETRIC 200-EMA filter would also have passed, so the report can
            // test "shorts only below the 200-EMA" without a second run.
            if (price < ema200) edge = "index_trend_short_below200";
          }
        }
      }
    }
    if (!edge) continue;

    const short = dir === "short";
    const entry = short ? price - S.tick : price + S.tick;
    const hardStop = short ? price + stopDist : price - stopDist;
    const target = short ? price - targetDist : price + targetDist;
    const riskDollars = stopDist * S.ptVal;
    const entryTime = bar.t + 300000;
    while (m1Cursor < m1.length && m1[m1Cursor].t < entryTime) m1Cursor++;

    let peak = 0, reachedBE = false, trail: number | null = null, atrNow = currentATR;
    let exited: { px: number; why: string; k: number } | null = null;

    for (let k = m1Cursor; k < m1.length && !exited; k++) {
      const b1 = m1[k];
      const s1 = sessionName(b1.hour, new Date(b1.t + etOffset(b1.t)).getUTCDay());
      const mins = (b1.t - entryTime) / 60000;
      if (indexSizeMult(s1) <= 0) { exited = { px: short ? b1.c + S.tick : b1.c - S.tick, why: "session_close", k }; break; }
      if (trail != null && (short ? b1.h >= trail : b1.l <= trail)) exited = { px: (short ? Math.max(trail, b1.o) + S.tick : Math.min(trail, b1.o) - S.tick), why: "trail_stop", k };
      else if (reachedBE && (short ? b1.h >= entry : b1.l <= entry)) exited = { px: short ? entry + S.tick : entry - S.tick, why: "breakeven", k };
      else if (short ? b1.h >= hardStop : b1.l <= hardStop) exited = { px: (short ? Math.max(hardStop, b1.o) + S.tick : Math.min(hardStop, b1.o) - S.tick), why: "stop_loss", k };
      if (!exited && (short ? b1.l <= target : b1.h >= target)) exited = { px: target, why: "target", k };
      if (exited) break;

      const diffBest = short ? entry - b1.l : b1.h - entry;
      if (diffBest > peak) peak = diffBest;
      if (!reachedBE && peak >= stopDist * BREAKEVEN_R) reachedBE = true;
      if (peak >= stopDist * TRAIL_R) {
        if (k % 5 === 0) { const j = Math.min(i + Math.floor(mins / 5), m5.length - 1); atrNow = atrOf(m5.slice(Math.max(0, j - BUFFER + 1), j + 1)) || atrNow; }
        let raw = short ? b1.l + atrNow * TRAIL_ATR_MULT : b1.h - atrNow * TRAIL_ATR_MULT;
        if (peak >= stopDist) { const lock = short ? entry - peak * PROFIT_LOCK_FRAC : entry + peak * PROFIT_LOCK_FRAC; raw = short ? Math.min(raw, lock) : Math.max(raw, lock); }
        if (trail == null || (short ? raw < trail : raw > trail)) trail = raw;
      }
      const diffNow = short ? entry - b1.c : b1.c - entry;
      if (mins >= STALE_MIN && diffNow < stopDist && !reachedBE) { exited = { px: short ? b1.c + S.tick : b1.c - S.tick, why: "time_exit", k }; break; }
    }
    if (!exited) break;
    const pnl = (short ? entry - exited.px : exited.px - entry) * S.ptVal - COMMISSION;
    trades.push({ dayISO: bar.dayISO, session, edge, pnl, r: pnl / riskDollars, exit: exited.why });
    const exitT = m1[Math.min(exited.k, m1.length - 1)].t;
    while (i + 1 < m5.length && m5[i + 1].t <= exitT) i++;
  }
  return trades;
}

function stats(ts: T[]) {
  if (!ts.length) return null;
  const w = ts.filter(t => t.pnl > 0), l = ts.filter(t => t.pnl <= 0);
  const gW = w.reduce((s, t) => s + t.pnl, 0), gL = -l.reduce((s, t) => s + t.pnl, 0);
  const net = ts.reduce((s, t) => s + t.pnl, 0);
  return { n: ts.length, wr: w.length / ts.length, pf: gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0), net, avg: net / ts.length };
}
const f = (s: ReturnType<typeof stats>) => s ? `n=${String(s.n).padStart(4)} win ${(s.wr * 100).toFixed(0).padStart(3)}% PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2).padStart(5)} avg$${(s.avg >= 0 ? "+" : "") + s.avg.toFixed(2)} net$${s.net.toFixed(0)}` : "n=0";

const syms = (process.argv[2] || "ES,NQ").split(",");
console.log("INDEX EDGES — engine-exact, 24h rolling 200-bar buffer (CORRECTED), full trade management");
console.log(`Sessions modelled: ${ALL_SESSIONS ? "ALL (incl. currently blocked)" : "live index only — morning/midday/afternoon"}\n`);
for (const sym of syms) {
  const { m1, m5 } = load(`${DATA_DIR}/${sym}_1m.csv`);
  const all = backtest(sym, m1, m5);
  const days = [...new Set(all.map(t => t.dayISO))].sort();
  if (!days.length) { console.log(`${sym}: no trades`); continue; }
  const cut = days[Math.floor(days.length * 0.6)];
  const half = (sub: T[]) => {
    const tr = stats(sub.filter(t => t.dayISO <= cut)), te = stats(sub.filter(t => t.dayISO > cut));
    return `| train PF ${tr ? (tr.pf === Infinity ? 99 : tr.pf).toFixed(2) : "—"} test PF ${te ? (te.pf === Infinity ? 99 : te.pf).toFixed(2) : "—"}` + (tr && te && tr.avg > 0 && te.avg > 0 ? "  <<< BOTH HALVES" : "");
  };
  console.log("═".repeat(120));
  console.log(`  ${SPEC[sym].label}   ${days[0]} → ${days[days.length - 1]}`);
  console.log("═".repeat(120));
  console.log("  ALL           " + f(stats(all)).padEnd(56) + half(all));
  // index_trend_short* added 2026-07-29: the short side the engine already generates but no edge
  // matches. "_below200" is the subset that ALSO passed a symmetric 200-EMA filter, so the two rows
  // together answer "does the short work, and does the regime filter help it?"
  const SHORTS = ["index_trend_short", "index_trend_short_below200"];
  const OBS = ["index_overbought_short", "index_overbought_short_below200"];
  for (const e of ["index_trend_long", ...OBS, "ALL_OBS", ...SHORTS, "ALL_TREND_SHORT"]) {
    if (e === "ALL_OBS") {
      const both = all.filter(t => OBS.includes(t.edge));
      if (both.length) console.log(`  ${"obs (both)".padEnd(13)} ` + f(stats(both)).padEnd(56) + half(both));
      continue;
    }
    if (e === "ALL_TREND_SHORT") {
      const both = all.filter(t => SHORTS.includes(t.edge));
      if (both.length) console.log(`  ${"trend_short (both)".padEnd(13)} ` + f(stats(both)).padEnd(56) + half(both));
      continue;
    }
    const sub = all.filter(t => t.edge === e);
    if (!sub.length) { console.log(`  ${e.padEnd(24)} n=0`); continue; }
    console.log(`  ${e.padEnd(13)} ` + f(stats(sub)).padEnd(56) + half(sub));
    for (const s of ["morning", "midday", "afternoon", "eth_evening", "eth_asia", "eth_europe", "open", "close", "pre_market"]) {
      const ss = sub.filter(t => t.session === s);
      if (ss.length < 15) continue;
      console.log(`     └ ${s.padEnd(11)} ` + f(stats(ss)).padEnd(54) + half(ss));
    }
  }
  if (SINCE) console.log(`  SINCE ${SINCE}: ` + f(stats(all.filter(t => t.dayISO >= SINCE))));
}
