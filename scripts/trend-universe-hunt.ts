/**
 * TREND-CONTINUATION UNIVERSE HUNT — long AND short, every instrument we have 1-minute data for.
 *
 * WHY: the RSI-bounce setup has now been tested on 19 instruments (empty). Trend-continuation —
 * the setup actually producing the live account's profit — had only ever been tested on ES, NQ and
 * YM. This closes that gap, and tests the SHORT side, which the engine computes but has never had a
 * registered edge (so it has never traded and has never been measured).
 *
 * THREE VARIANTS per instrument (engine source, futures-realtime.ts:2903-2928):
 *   LONG           nearEMA && ema9>ema21 && price>ema21 && price>ema200 && 35<RSI<65 && !volSurge
 *   SHORT (engine) nearEMA && ema9<ema21 && price<ema21 && 35<RSI<65 && !volSurge
 *                  ^ note: the engine's short has NO 200-EMA filter. That asymmetry is real code.
 *   SHORT (symm)   the same short WITH price<ema200 added — the principled mirror of the long,
 *                  since the regime filter is supposedly what makes the long work.
 *
 * Shared gate: (dayType==="trend" || |ema9-ema21|/price > 0.001) && session in {morning, afternoon}
 * Score: base 72, +5 declining/-5 dry volume, +10/-10 15m-trend alignment, +3 price-vs-VWAP the
 *   right side, +5 prime session, +? dayTypeMatch. Gate >= 75.
 * Geometry: stop 1.5 x ATR, target 4.0 x ATR. Indicators on the engine's rolling 200-bar 24h buffer.
 * Management: 0.6R breakeven, 1.1R trail at 1.35 x ATR, 65% profit-lock past 1R, 30-min stale exit.
 *
 * COSTS: 0.011% of price per round turn, derived from the measured live micro book. Every
 *   instrument below is a FULL-SIZE contract ($50k-150k notional), where a real $4-5 commission
 *   plus a tick or two is comfortably UNDER 0.011% — so this is conservative for all of them.
 *   Crypto micros (MBT/MET/BFF) are deliberately EXCLUDED: their notional is a few hundred dollars,
 *   so a percentage-of-price cost understates their real fee by ~50x and produces fake winners.
 *
 * STATISTICAL BAR — this runs ~57 tests. A plain "positive in both halves" screen would throw up
 *   roughly 14 false positives by chance alone. So a result only counts here if it clears ALL of:
 *      positive in BOTH halves  AND  full-sample PF >= 1.10  AND  n >= 200.
 *   Anything short of that is reported but explicitly labelled noise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const COST_PCT = 0.00011;
const BREAKEVEN_R = 0.6, TRAIL_R = 1.1, STALE_MIN = 30;
const TRAIL_ATR_MULT = 0.9 * 1.5, PROFIT_LOCK_FRAC = 0.65, BUFFER = 200;
const MIN_N = 200, MIN_PF = 1.10;

const UNIVERSE: { sym: string; file: string; grp: string }[] = [
  { sym: "ES", file: "data/ES_1m.csv", grp: "index" },
  { sym: "NQ", file: "data/NQ_1m.csv", grp: "index" },
  { sym: "YM", file: "data/ym3y/YM_1m.csv", grp: "index" },
  { sym: "GC", file: "data/gold3y/GC_1m.csv", grp: "metals" },
  { sym: "SI", file: "data/SI_1m.csv", grp: "metals" },
  { sym: "HG", file: "data/HG_1m.csv", grp: "metals" },
  { sym: "PL", file: "data/PL_1m.csv", grp: "metals" },
  { sym: "PA", file: "data/PA_1m.csv", grp: "metals" },
  { sym: "CL", file: "data/CL_1m.csv", grp: "energy" },
  { sym: "NG", file: "data/NG_1m.csv", grp: "energy" },
  { sym: "HO", file: "data/intraday/HO_1m.csv", grp: "energy" },
  { sym: "RB", file: "data/intraday/RB_1m.csv", grp: "energy" },
  { sym: "6E", file: "data/intraday/6E_1m.csv", grp: "fx" },
  { sym: "6B", file: "data/intraday/6B_1m.csv", grp: "fx" },
  { sym: "6A", file: "data/intraday/6A_1m.csv", grp: "fx" },
  { sym: "6C", file: "data/intraday/6C_1m.csv", grp: "fx" },
  { sym: "ZS", file: "data/intraday/ZS_1m.csv", grp: "grain" },
  { sym: "ZC", file: "data/intraday/ZC_1m.csv", grp: "grain" },
  { sym: "ZW", file: "data/intraday/ZW_1m.csv", grp: "grain" },
];

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
function sessionOf(hour: number, dow: number): string {
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
function load(file: string) {
  const text = fs.readFileSync(new URL(file, ROOT), "utf8");
  const lines = text.split("\n");
  const m1: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i]; if (!r) continue;
    const f = r.split(","); const t = Date.parse(f[0]); const c = +f[7];
    const o = +f[4], h = +f[5], l = +f[6];
    if (!isFinite(t) || !(c > 0) || !(o > 0) || !(h > 0) || !(l > 0)) continue;
    const etMs = t + etOffset(t); const day = Math.floor(etMs / 86400000);
    m1.push({ t, o, h, l, c, v: +f[8] || 0, day, hour: (etMs - day * 86400000) / 3600000, dayISO: new Date(etMs).toISOString().slice(0, 10) });
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
type Variant = "long" | "short_engine" | "short_symmetric";
interface T { dayISO: string; session: string; r: number; }

function backtest(m1: Bar[], m5: Bar[], variant: Variant): T[] {
  const trades: T[] = []; let m1Cursor = 0;
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
  let vwapDay = -1, cumPV = 0, cumV = 0;

  for (let i = BUFFER; i < m5.length; i++) {
    const bar = m5[i];
    if (bar.day !== vwapDay) { vwapDay = bar.day; cumPV = 0; cumV = 0; }
    cumPV += ((bar.h + bar.l + bar.c) / 3) * bar.v; cumV += bar.v;
    const vwap = cumV > 0 ? cumPV / cumV : bar.c;
    const dow = new Date(bar.t + etOffset(bar.t)).getUTCDay();
    const session = sessionOf(bar.hour, dow);
    if (session !== "morning" && session !== "afternoon") continue;

    const buf = m5.slice(i - BUFFER + 1, i + 1);
    const closes = buf.map(b => b.c);
    const atr = atrOf(buf); if (atr <= 0) continue;
    const price = bar.c;
    const ema9 = emaLast(closes, 9), ema21 = emaLast(closes, 21), ema200 = emaLast(closes, 200);
    if (!(dayTypeTrend() || Math.abs(ema9 - ema21) / price > 0.001)) continue;
    function dayTypeTrend() {
      const pd = prevDay.get(bar.day);
      const pdH = pd != null ? dayHi.get(pd)! : 0, pdL = pd != null ? dayLo.get(pd)! : 0;
      const outside = (pdH > 0 && price > pdH) || (pdL > 0 && price < pdL);
      const orSize = (orH.get(bar.day) ?? 0) - (orL.get(bar.day) ?? 0);
      return outside || orSize > atr * 0.5;
    }
    const rsi = rsiOf(closes);
    if (!(rsi > 35 && rsi < 65)) continue;
    let volSum = 0; for (let j = buf.length - 20; j < buf.length; j++) volSum += buf[j].v;
    const avgVol = volSum / 20;
    const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
    const volTrend = volRatio > 2 ? "surge" : volRatio < 0.6 ? "dry" : volRatio < 0.8 ? "declining" : "normal";
    if (volTrend === "surge") continue;
    const nearEMA = Math.abs(price - ema9) / price < 0.003;
    if (!nearEMA) continue;

    let ok = false, short = false;
    if (variant === "long") { ok = ema9 > ema21 && price > ema21 && price > ema200; short = false; }
    else if (variant === "short_engine") { ok = ema9 < ema21 && price < ema21; short = true; }
    else { ok = ema9 < ema21 && price < ema21 && price < ema200; short = true; }
    if (!ok) continue;

    const t15 = trend15(buf);
    let sc = 72;
    if (volTrend === "declining") sc += 5; else if (volTrend === "dry") sc -= 5;
    sc += (short ? t15 === "down" : t15 === "up") ? 10 : -10;
    if (short ? price < vwap : price > vwap) sc += 3;
    sc += 5; // morning/afternoon = prime for a live engine
    if (Math.max(0, Math.min(100, sc)) < 75) continue;

    const stopDist = atr * 1.5, targetDist = atr * 4.0;
    const entry = price;
    const hardStop = short ? price + stopDist : price - stopDist;
    const target = short ? price - targetDist : price + targetDist;
    const entryTime = bar.t + 300000;
    while (m1Cursor < m1.length && m1[m1Cursor].t < entryTime) m1Cursor++;
    let peak = 0, reachedBE = false, trail: number | null = null, atrNow = atr;
    let exited: { px: number; k: number } | null = null;

    for (let k = m1Cursor; k < m1.length && !exited; k++) {
      const b1 = m1[k];
      const s1 = sessionOf(b1.hour, new Date(b1.t + etOffset(b1.t)).getUTCDay());
      const mins = (b1.t - entryTime) / 60000;
      if (s1 !== "morning" && s1 !== "afternoon" && s1 !== "midday") { exited = { px: b1.c, k }; break; }
      if (trail != null && (short ? b1.h >= trail : b1.l <= trail)) exited = { px: short ? Math.max(trail, b1.o) : Math.min(trail, b1.o), k };
      else if (reachedBE && (short ? b1.h >= entry : b1.l <= entry)) exited = { px: entry, k };
      else if (short ? b1.h >= hardStop : b1.l <= hardStop) exited = { px: short ? Math.max(hardStop, b1.o) : Math.min(hardStop, b1.o), k };
      if (!exited && (short ? b1.l <= target : b1.h >= target)) exited = { px: target, k };
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
      if (mins >= STALE_MIN && diffNow < stopDist && !reachedBE) { exited = { px: b1.c, k }; break; }
    }
    if (!exited) break;
    const gross = short ? entry - exited.px : exited.px - entry;
    const net = gross - entry * COST_PCT;
    trades.push({ dayISO: bar.dayISO, session, r: net / stopDist });
    const exitT = m1[Math.min(exited.k, m1.length - 1)].t;
    while (i + 1 < m5.length && m5[i + 1].t <= exitT) i++;
  }
  return trades;
}
function stats(ts: T[]) {
  if (!ts.length) return null;
  const w = ts.filter(t => t.r > 0), l = ts.filter(t => t.r <= 0);
  const gW = w.reduce((s, t) => s + t.r, 0), gL = -l.reduce((s, t) => s + t.r, 0);
  return { n: ts.length, wr: w.length / ts.length, pf: gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0), expR: ts.reduce((s, t) => s + t.r, 0) / ts.length };
}
const f = (s: ReturnType<typeof stats>) => s ? `n=${String(s.n).padStart(4)} win ${(s.wr * 100).toFixed(0).padStart(3)}% PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2).padStart(5)}` : "n=   0            ";

console.log("TREND-CONTINUATION UNIVERSE HUNT — long + short, engine-exact, full trade management");
console.log(`Bar: a result counts only if BOTH halves positive AND full PF >= ${MIN_PF} AND n >= ${MIN_N}.`);
console.log("~57 tests: a plain both-halves screen would produce ~14 false positives by chance.\n");
console.log("  SYM  grp     variant          FULL                 | TRAIN                | TEST                 | morning/afternoon");
console.log("  " + "─".repeat(126));
const passed: string[] = [];
for (const u of UNIVERSE) {
  let d; try { d = load(u.file); } catch { console.log(`  ${u.sym.padEnd(5)}${u.grp.padEnd(8)}(no data)`); continue; }
  if (d.m5.length < 5000) { console.log(`  ${u.sym.padEnd(5)}${u.grp.padEnd(8)}(short series)`); continue; }
  for (const v of ["long", "short_engine", "short_symmetric"] as Variant[]) {
    const all = backtest(d.m1, d.m5, v);
    if (all.length < 50) { console.log(`  ${u.sym.padEnd(5)}${u.grp.padEnd(8)}${v.padEnd(17)}n=${all.length} — too few`); continue; }
    const days = [...new Set(all.map(t => t.dayISO))].sort();
    const cut = days[Math.floor(days.length * 0.6)];
    const sa = stats(all), tr = stats(all.filter(t => t.dayISO <= cut)), te = stats(all.filter(t => t.dayISO > cut));
    const am = stats(all.filter(t => t.session === "morning")), pm = stats(all.filter(t => t.session === "afternoon"));
    const bothPos = !!(tr && te && tr.expR > 0 && te.expR > 0);
    const clears = bothPos && !!sa && sa.pf >= MIN_PF && sa.n >= MIN_N;
    if (clears) passed.push(`${u.sym}/${v}`);
    const tag = clears ? "   <<<< CLEARS THE BAR" : bothPos ? "   (both halves, but under the bar = noise)" : "";
    console.log(`  ${u.sym.padEnd(5)}${u.grp.padEnd(8)}${v.padEnd(17)}${f(sa)} | ${f(tr)} | ${f(te)} | am ${am ? (am.pf === Infinity ? 99 : am.pf).toFixed(2) : "—"} pm ${pm ? (pm.pf === Infinity ? 99 : pm.pf).toFixed(2) : "—"}${tag}`);
  }
}
console.log("\n  CLEARS THE BAR: " + (passed.length ? passed.join(", ") : "NONE"));
