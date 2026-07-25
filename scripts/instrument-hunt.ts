/**
 * INSTRUMENT HUNT — is there an UNCORRELATED intraday edge we aren't trading?
 *
 * WHY: the live book is really two bets (equity index + gold). Adding more of the same makes
 * returns less consistent, not more. The only thing that genuinely improves consistency is an edge
 * in something uncorrelated. Earlier instrument sweeps used a FIXED stop/target with no trade
 * management — and this session proved twice (index trend-long, gold) that the management machinery
 * changes the answer materially. So this re-runs the hunt with the engine's real management.
 *
 * SETUP: the engine's extreme_rsi_bounce (the most general one) — RSI(14) < 25 long / > 75 short,
 *   volTrend !== "surge", scoreSetup base 70 (+5 declining / -5 dry volume; +10/-10 15m-trend
 *   alignment; +3 rsiExtreme; +5 prime session) gated at >= 75.
 *   stop = 1.5 x ATR, target = 3.5 x ATR, on a rolling 200-bar 24h buffer — same as production.
 *
 * MANAGEMENT: 0.6R breakeven, 1.1R trail at 1.35 x ATR, 65% profit-lock past 1R, 30-min stale exit,
 *   flat when the tradeable window closes. 1 contract, no scale-out, no pyramid.
 *
 * COSTS — unit-free and MEASURED, so no contract specs have to be invented. Live micros cost
 *   ~$2.02 commission + 2 ticks slippage on ~$37-41k of notional = ~0.011% of price per round turn.
 *   That figure is applied as a fraction of price, which is conservative for full-size contracts
 *   (bigger notional, same fee => smaller %). Results are reported in PROFIT FACTOR and R-multiples,
 *   both scale-invariant, so nothing depends on a guessed point value or tick size.
 *
 * VERDICT RULE: an instrument only counts if it is positive in BOTH halves.
 *
 * Usage: npx tsx scripts/instrument-hunt.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const COST_PCT = 0.00011;          // round-turn, measured from the live micro book
const BREAKEVEN_R = 0.6, TRAIL_R = 1.1, STALE_MIN = 30;
const TRAIL_ATR_MULT = 0.9 * 1.5, PROFIT_LOCK_FRAC = 0.65, BUFFER = 200;

const UNIVERSE: { sym: string; file: string; group: string }[] = [
  { sym: "SI", file: "data/SI_1m.csv", group: "metals" },
  { sym: "HG", file: "data/HG_1m.csv", group: "metals" },
  { sym: "PL", file: "data/PL_1m.csv", group: "metals" },
  { sym: "PA", file: "data/PA_1m.csv", group: "metals" },
  { sym: "CL", file: "data/CL_1m.csv", group: "energy" },
  { sym: "NG", file: "data/NG_1m.csv", group: "energy" },
  { sym: "HO", file: "data/intraday/HO_1m.csv", group: "energy" },
  { sym: "RB", file: "data/intraday/RB_1m.csv", group: "energy" },
  { sym: "6E", file: "data/intraday/6E_1m.csv", group: "fx" },
  { sym: "6B", file: "data/intraday/6B_1m.csv", group: "fx" },
  { sym: "6A", file: "data/intraday/6A_1m.csv", group: "fx" },
  { sym: "ZS", file: "data/intraday/ZS_1m.csv", group: "grain" },
  { sym: "ZC", file: "data/intraday/ZC_1m.csv", group: "grain" },
  { sym: "ZW", file: "data/intraday/ZW_1m.csv", group: "grain" },
  { sym: "MBT", file: "data/MBT_1m.csv", group: "crypto" },
  { sym: "MET", file: "data/MET_1m.csv", group: "crypto" },
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
function sizeMult(s: string): number {
  if (s === "morning" || s === "afternoon") return 1.0;
  if (s === "midday") return 0.5;
  if (s === "halt") return 0;
  return 0.5;   // ETH — evaluated so the session table can show where any edge lives
}
function load(file: string) {
  const text = fs.readFileSync(new URL(file, ROOT), "utf8");
  const lines = text.split("\n");
  const m1: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i]; if (!r) continue;
    const f = r.split(","); const t = Date.parse(f[0]); const c = +f[7];
    if (!isFinite(t) || !isFinite(c) || c <= 0) continue;
    const o = +f[4], h = +f[5], l = +f[6];
    if (!(o > 0 && h > 0 && l > 0)) continue;
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

interface T { dayISO: string; session: string; dir: "long" | "short"; r: number; retPct: number; }

function backtest(m1: Bar[], m5: Bar[]): T[] {
  const trades: T[] = []; let m1Cursor = 0;
  for (let i = BUFFER; i < m5.length; i++) {
    const bar = m5[i];
    const dow = new Date(bar.t + etOffset(bar.t)).getUTCDay();
    const session = sessionName(bar.hour, dow);
    const sm = sizeMult(session); if (sm <= 0) continue;
    const buf = m5.slice(i - BUFFER + 1, i + 1);
    const closes = buf.map(b => b.c);
    const atr = atrOf(buf); if (atr <= 0) continue;
    const rsi = rsiOf(closes); if (!(rsi < 25 || rsi > 75)) continue;
    let volSum = 0; for (let j = buf.length - 20; j < buf.length; j++) volSum += buf[j].v;
    const avgVol = volSum / 20;
    const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
    const volTrend = volRatio > 2 ? "surge" : volRatio < 0.6 ? "dry" : volRatio < 0.8 ? "declining" : "normal";
    if (volTrend === "surge") continue;
    const isOversold = rsi < 25;
    const t15 = trend15(buf);
    let sc = 70;
    if (volTrend === "declining") sc += 5; else if (volTrend === "dry") sc -= 5;
    sc += (isOversold ? t15 !== "down" : t15 !== "up") ? 10 : -10;
    sc += 3; sc += sm >= 1 ? 5 : 0;
    if (Math.max(0, Math.min(100, sc)) < 75) continue;

    const short = !isOversold;
    const price = bar.c;
    const stopDist = atr * 1.5, targetDist = atr * 3.5;
    const entry = price;                                  // slippage is inside COST_PCT
    const hardStop = short ? price + stopDist : price - stopDist;
    const target = short ? price - targetDist : price + targetDist;
    const entryTime = bar.t + 300000;
    while (m1Cursor < m1.length && m1[m1Cursor].t < entryTime) m1Cursor++;
    let peak = 0, reachedBE = false, trail: number | null = null, atrNow = atr;
    let exited: { px: number; k: number } | null = null;

    for (let k = m1Cursor; k < m1.length && !exited; k++) {
      const b1 = m1[k];
      const s1 = sessionName(b1.hour, new Date(b1.t + etOffset(b1.t)).getUTCDay());
      const mins = (b1.t - entryTime) / 60000;
      if (sizeMult(s1) <= 0) { exited = { px: b1.c, k }; break; }
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
    trades.push({ dayISO: bar.dayISO, session, dir: short ? "short" : "long", r: net / stopDist, retPct: net / entry });
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
const f = (s: ReturnType<typeof stats>) => s ? `n=${String(s.n).padStart(4)} win ${(s.wr * 100).toFixed(0).padStart(3)}% PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2).padStart(5)} expR ${(s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)}` : "n=   0";

console.log("INSTRUMENT HUNT — extreme RSI-bounce with FULL trade management, unit-free (PF / R)");
console.log(`Cost: ${(COST_PCT * 100).toFixed(3)}% of price per round turn, derived from the measured live micro book.`);
console.log("An instrument only counts if it is positive in BOTH halves.\n");
console.log("  SYM   grp     " + "FULL".padEnd(42) + "| TRAIN".padEnd(44) + "| TEST");
console.log("  " + "─".repeat(134));
const winners: string[] = [];
for (const u of UNIVERSE) {
  let data;
  try { data = load(u.file); } catch { console.log(`  ${u.sym.padEnd(6)}${u.group.padEnd(8)}(no data)`); continue; }
  if (data.m5.length < 5000) { console.log(`  ${u.sym.padEnd(6)}${u.group.padEnd(8)}(only ${data.m5.length} bars)`); continue; }
  const all = backtest(data.m1, data.m5);
  if (all.length < 100) { console.log(`  ${u.sym.padEnd(6)}${u.group.padEnd(8)}n=${all.length} — too few`); continue; }
  const days = [...new Set(all.map(t => t.dayISO))].sort();
  const cut = days[Math.floor(days.length * 0.6)];
  const tr = stats(all.filter(t => t.dayISO <= cut)), te = stats(all.filter(t => t.dayISO > cut));
  const both = !!(tr && te && tr.expR > 0 && te.expR > 0);
  if (both) winners.push(u.sym);
  console.log(`  ${u.sym.padEnd(6)}${u.group.padEnd(8)}${f(stats(all)).padEnd(42)}| ${f(tr).padEnd(42)}| ${f(te)}${both ? "   <<< BOTH HALVES" : ""}`);
  // direction split only for anything that looks alive
  const sa = stats(all);
  if (both || (sa && sa.pf > 1.0)) {
    for (const d of ["long", "short"] as const) {
      const sub = all.filter(t => t.dir === d);
      if (sub.length < 50) continue;
      const dtr = stats(sub.filter(t => t.dayISO <= cut)), dte = stats(sub.filter(t => t.dayISO > cut));
      console.log(`     └ ${d.padEnd(4)}       ${f(stats(sub)).padEnd(42)}| ${f(dtr).padEnd(42)}| ${f(dte)}${dtr && dte && dtr.expR > 0 && dte.expR > 0 ? "   <<< BOTH" : ""}`);
    }
  }
}
console.log("\n  Positive in both halves: " + (winners.length ? winners.join(", ") : "NONE"));
