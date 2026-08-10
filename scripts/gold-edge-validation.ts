/**
 * GOLD RSI-BOUNCE VALIDATION — the live flagship edge, engine-exact, with full trade management.
 *
 * WHY: the earlier timeframe sweep tested gold with a FIXED stop/target and no trade management.
 * For the index trend-long edge that turned out to matter enormously (the trailing/profit-lock
 * machinery was where all the profit came from), so gold deserves the same honest treatment.
 * This also answers the practical question: WHICH SESSIONS is gold's edge actually in? The engine
 * lets gold trade RTH plus the evening, and concentrating on the good hours is the one lever that
 * increases return WITHOUT increasing risk per trade.
 *
 * FIDELITY — copied from src/services/futures-realtime.ts, line-checked:
 *
 *   BARS: onPrice() (line 683-716) builds 5-min bars from EVERY tick, with NO session gate, and
 *     keeps only the last 200 (`if (b.bars5m.length > 200) b.bars5m.shift()`). So indicators run on
 *     a rolling 200-bar window of CONTINUOUS 24h data — ~16.7 hours, not 2.5 RTH sessions. This
 *     script reproduces that rolling-window behaviour exactly, including ema() being re-seeded from
 *     the oldest bar in the buffer each time.
 *
 *   ENTRY — "SETUP 0: Extreme RSI Bounce" (line 2718-2750):
 *     RSI(14) < 25 -> long, > 75 -> short; volTrend !== "surge";
 *     scoreSetup base 70: +8 surge / +5 declining / -5 dry; trend15Aligns is
 *       oversold ? tf15 !== "down" : tf15 !== "up"  (+10 / -10); rsiExtreme +3;
 *       priceAboveVWAP hardcoded FALSE (+0); session prime +5 / good +0 / avoid -10. Gate: >= 75.
 *     stop = adjustedATR * 1.5 ; target = currentATR * 3.5   (note: target uses the UNadjusted ATR)
 *     GOLD ATR SCALE: currentATR = rawATR * 1.5 for metals (line 2634) — gold gets wider stops.
 *
 *   SESSIONS (getSizeMultiplier, line 976-995) — LIVE gold may trade where sizeMult > 0:
 *     morning 09:45-12:00 (1.0, "prime"), midday 12:00-14:00 (0.5, "good"),
 *     afternoon 14:00-15:45 (1.0, "prime"), eth_evening 16:00-17:00 & 18:00-22:00 (0.5, "good",
 *     requires equity >= $3,000 — currently true at $5,214).
 *     BLOCKED: open, close, eth_asia (22:00-03:00), eth_europe (03:00-09:00), pre_market, halt.
 *
 *   MANAGEMENT (line 1518-1745), 1 contract — no scale-out, no pyramid:
 *     0.6R breakeven, 1.1R trail at 1.0*1.5 = 1.5x ATR for METALS, 65% profit-lock once past 1R,
 *     30-min stale exit if under 1R and breakeven never reached, flat at the end of the gold window.
 *
 *   COSTS: MGC $10/pt, 0.1 tick ($1.00). 1 tick adverse on entry and on market-type exits, target
 *     filled exactly, $2.02 round-turn commission (measured from the live account).
 *
 * ASSUMPTIONS: VIX normal (stopMult 1.0). Macro-event blackouts, the vault anti-pattern gate and
 *   the pattern-memory auto-prune are not modelled. Intrabar: adverse extreme assumed first.
 *
 * Usage: TL_DATA_DIR=data/gold3y npx tsx scripts/gold-edge-validation.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const DATA_DIR = process.env.TL_DATA_DIR || "data/gold3y";
const SINCE = process.env.G_SINCE || "";
/** Test the sessions the engine currently BLOCKS (asia/europe/open/close) as if they were enabled
 *  at half size — answers "is there profitable gold time we are simply not trading?" */
const ALL_SESSIONS = process.env.G_ALL_SESSIONS === "1";
/** Stale-exit timer sweep. The live value is 30 minutes and has never been tested; it currently
 *  closes ~half of all gold trades. "none" disables it. */
const STALE_OVERRIDE = process.env.G_STALE || "";

const PT_VAL = 10;        // MGC
const TICK = 0.1;
const COMMISSION = 2.02;
const ATR_SCALE_METALS = 1.5;
const VIX_STOP_MULT = 1.0;
const BREAKEVEN_R = 0.6, TRAIL_R = 1.1;
const STALE_MIN = process.env.G_STALE === "none" ? Infinity : (parseFloat(process.env.G_STALE || "") || 30);
const TRAIL_ATR_MULT = (parseFloat(process.env.G_TRAIL_ATR || "") || 1.0) * 1.5;   // metals
const PROFIT_LOCK_FRAC = parseFloat(process.env.G_LOCK || "") || 0.65;
const BUFFER = 200;                  // engine's bars5m cap

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const offCache = new Map<number, number>();
function etOffset(t: number): number {
  const hr = Math.floor(t / 3600000);
  const hit = offCache.get(hr);
  if (hit !== undefined) return hit;
  const p: any = {};
  for (const x of etFmt.formatToParts(hr * 3600000)) p[x.type] = x.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  const off = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute) - hr * 3600000;
  offCache.set(hr, off);
  return off;
}

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; day: number; hour: number; dayISO: string; }

/** Engine session names (getSessionName, line 953-970). */
function sessionName(hour: number, dow: number): string {
  if (dow === 6 || (dow === 5 && hour >= 17) || (dow === 0 && hour < 18)) return "halt";
  if (hour >= 17 && hour < 18) return "halt";
  if (hour >= 9.5 && hour < 16) {
    const mins = (hour - 9.5) * 60;
    if (mins < 15) return "open";
    if (hour < 12) return "morning";
    if (hour < 14) return "midday";
    if (hour < 15.75) return "afternoon";
    return "close";
  }
  if (hour >= 16 && hour < 17) return "eth_evening";
  if (hour >= 18 && hour < 22) return "eth_evening";
  if (hour >= 22 || hour < 3) return "eth_asia";
  if (hour >= 3 && hour < 9) return "eth_europe";
  return "pre_market";
}
/** getSizeMultiplier for LIVE gold (equity >= $3,000). 0 = the engine cannot trade that session.
 *  G_DEPLOYED=1 mirrors the CURRENT deployed engine (2026-07-28): eth_evening AND eth_europe both
 *  return 1.0, which makes them "prime" (+5 confluence) — so MORE marginal setups clear the >=75
 *  gate than the old 0.5/"good" model let through. Sizing is not cosmetic here; it changes which
 *  trades exist at all, so the backtest must match what is actually running. */
const DEPLOYED = process.env.G_DEPLOYED === "1";
function goldSizeMult(session: string): number {
  if (session === "morning" || session === "afternoon") return 1.0;
  if (session === "midday") return 0.5;
  if (session === "eth_evening") return DEPLOYED ? 1.0 : 0.5;
  if (DEPLOYED && session === "eth_europe") return 1.0;
  if (ALL_SESSIONS && session !== "halt") return 0.5; // hypothetical: enable the blocked sessions
  return 0;
}

function load(file: string): { m1: Bar[]; m5: Bar[] } {
  const text = fs.readFileSync(new URL(file, ROOT), "utf8");
  const lines = text.split("\n");
  const m1: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row) continue;
    const f = row.split(",");
    const t = Date.parse(f[0]);
    const c = +f[7];
    if (!isFinite(t) || !isFinite(c) || c <= 0) continue;
    const etMs = t + etOffset(t);
    const day = Math.floor(etMs / 86400000);
    const d = new Date(etMs);
    m1.push({
      t, o: +f[4], h: +f[5], l: +f[6], c, v: +f[8] || 0, day,
      hour: (etMs - day * 86400000) / 3600000,
      dayISO: d.toISOString().slice(0, 10),
    });
  }
  const m5: Bar[] = [];
  let key = -1;
  for (const b of m1) {
    const k = Math.floor(b.t / 300000);
    if (k !== key) { key = k; m5.push({ ...b, t: k * 300000 }); }
    else {
      const j = m5.length - 1;
      if (b.h > m5[j].h) m5[j].h = b.h;
      if (b.l < m5[j].l) m5[j].l = b.l;
      m5[j].c = b.c; m5[j].v += b.v;
    }
  }
  return { m1, m5 };
}

// ── engine indicator maths, applied to the rolling buffer ──
function rsiOf(c: number[], p = 14): number {
  if (c.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / p) / (l / p));
}
function atrOf(b: Bar[], p = 14): number {
  if (b.length < p + 1) return 0;
  let s = 0;
  for (let i = b.length - p; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / p;
}
function emaLast(c: number[], period: number): number {
  const k = 2 / (period + 1);
  let r = c[0];
  for (let i = 1; i < c.length; i++) r = c[i] * k + r * (1 - k);
  return r;
}
/** get15mTrend on the buffer: group 5m bars in 3s from the start, EMA9 vs EMA21 of 15m closes. */
function trend15(buf: Bar[]): "up" | "down" | "flat" {
  const c15: number[] = [];
  for (let i = 0; i + 2 < buf.length; i += 3) c15.push(buf[i + 2].c);
  if (c15.length < 21) return "flat";
  const a = emaLast(c15, 9), b = emaLast(c15, 21);
  return a > b ? "up" : a < b ? "down" : "flat";
}

interface T { dayISO: string; session: string; dir: "long" | "short"; pnl: number; r: number; exit: string; hour: number; }

function backtest(m1: Bar[], m5: Bar[]): T[] {
  const trades: T[] = [];
  // per-ET-day high/low for dayType, and the daily opening range (first 12 RTH bars)
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
  // session VWAP (resets each ET day)
  let vwapDay = -1, cumPV = 0, cumV = 0;
  let m1Cursor = 0;

  for (let i = BUFFER; i < m5.length; i++) {
    const bar = m5[i];
    if (bar.day !== vwapDay) { vwapDay = bar.day; cumPV = 0; cumV = 0; }
    const tp = (bar.h + bar.l + bar.c) / 3;
    cumPV += tp * bar.v; cumV += bar.v;

    const dow = new Date(bar.t + etOffset(bar.t)).getUTCDay();
    const session = sessionName(bar.hour, dow);
    const sizeMult = goldSizeMult(session);
    if (sizeMult <= 0) continue;                       // engine cannot trade this session

    // rolling 200-bar buffer — exactly what the engine holds
    const buf = m5.slice(i - BUFFER + 1, i + 1);
    const closes = buf.map(b => b.c);
    const rawATR = atrOf(buf);
    if (rawATR <= 0) continue;
    const currentATR = rawATR * ATR_SCALE_METALS;
    const adjustedATR = currentATR * VIX_STOP_MULT;
    const rsi = rsiOf(closes);
    if (!(rsi < 25 || rsi > 75)) continue;

    let volSum = 0;
    for (let j = buf.length - 21; j < buf.length - 1; j++) volSum += buf[j].v;
    const avgVol = volSum / 20;
    const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
    const volTrend = volRatio > 2 ? "surge" : volRatio < 0.6 ? "dry" : volRatio < 0.8 ? "declining" : "normal";
    if (volTrend === "surge") continue;

    const isOversold = rsi < 25;
    const dir: "long" | "short" = isOversold ? "long" : "short";
    const t15 = trend15(buf);
    const aligns = isOversold ? t15 !== "down" : t15 !== "up";

    let score = 70;
    if (volTrend === "declining") score += 5;
    else if (volTrend === "dry") score -= 5;
    score += aligns ? 10 : -10;
    score += 3;                                        // rsiExtreme
    score += sizeMult >= 1 ? 5 : sizeMult >= 0.5 ? 0 : -10;
    if (Math.max(0, Math.min(100, score)) < 75) continue;

    const price = bar.c;
    const stopDist = adjustedATR * 1.5;
    const targetDist = currentATR * 3.5;               // engine uses the UNadjusted ATR here
    const short = dir === "short";
    const entry = short ? price - TICK : price + TICK;
    const hardStop = short ? price + stopDist : price - stopDist;
    const target = short ? price - targetDist : price + targetDist;
    const riskDollars = stopDist * PT_VAL;

    const entryTime = bar.t + 300000;
    while (m1Cursor < m1.length && m1[m1Cursor].t < entryTime) m1Cursor++;

    let peak = 0, reachedBE = false, trail: number | null = null;
    let exited: { px: number; why: string; k: number } | null = null;
    let atrNow = currentATR;

    for (let k = m1Cursor; k < m1.length && !exited; k++) {
      const b1 = m1[k];
      const dow1 = new Date(b1.t + etOffset(b1.t)).getUTCDay();
      const s1 = sessionName(b1.hour, dow1);
      const mins = (b1.t - entryTime) / 60000;
      // flat when gold's tradeable window ends (engine holds no position into blocked sessions)
      if (goldSizeMult(s1) <= 0 && s1 !== "close") {
        exited = { px: short ? b1.c + TICK : b1.c - TICK, why: "session_close", k };
        break;
      }
      const adverse = () => {
        if (trail != null && (short ? b1.h >= trail : b1.l <= trail))
          exited = { px: (short ? Math.max(trail, b1.o) + TICK : Math.min(trail, b1.o) - TICK), why: "trail_stop", k };
        else if (reachedBE && (short ? b1.h >= entry : b1.l <= entry))
          exited = { px: short ? entry + TICK : entry - TICK, why: "breakeven", k };
        else if (short ? b1.h >= hardStop : b1.l <= hardStop)
          exited = { px: (short ? Math.max(hardStop, b1.o) + TICK : Math.min(hardStop, b1.o) - TICK), why: "stop_loss", k };
      };
      adverse();
      if (!exited && (short ? b1.l <= target : b1.h >= target)) exited = { px: target, why: "target", k };
      if (exited) break;

      const diffBest = short ? entry - b1.l : b1.h - entry;
      if (diffBest > peak) peak = diffBest;
      if (!reachedBE && peak >= stopDist * BREAKEVEN_R) reachedBE = true;
      if (peak >= stopDist * TRAIL_R) {
        if (k % 5 === 0) { const j = Math.min(i + Math.floor(mins / 5), m5.length - 1); atrNow = (atrOf(m5.slice(Math.max(0, j - BUFFER + 1), j + 1)) * ATR_SCALE_METALS) || atrNow; }
        let raw = short ? b1.l + atrNow * TRAIL_ATR_MULT : b1.h - atrNow * TRAIL_ATR_MULT;
        if (peak >= stopDist) {
          const lock = short ? entry - peak * PROFIT_LOCK_FRAC : entry + peak * PROFIT_LOCK_FRAC;
          raw = short ? Math.min(raw, lock) : Math.max(raw, lock);
        }
        if (trail == null || (short ? raw < trail : raw > trail)) trail = raw;
      }
      const diffNow = short ? entry - b1.c : b1.c - entry;
      if (mins >= STALE_MIN && diffNow < stopDist && !reachedBE) {
        exited = { px: short ? b1.c + TICK : b1.c - TICK, why: "time_exit", k };
        break;
      }
    }
    if (!exited) break;

    const pnl = (short ? entry - exited.px : exited.px - entry) * PT_VAL - COMMISSION;
    trades.push({ dayISO: bar.dayISO, session, dir, pnl, r: pnl / riskDollars, exit: exited.why, hour: bar.hour });

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
  return { n: ts.length, wr: w.length / ts.length, pf: gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0), net, avg: net / ts.length, expR: ts.reduce((s, t) => s + t.r, 0) / ts.length };
}
const f = (s: ReturnType<typeof stats>) =>
  s ? `n=${String(s.n).padStart(4)} win ${(s.wr * 100).toFixed(0).padStart(3)}% PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2).padStart(5)} avg$${(s.avg >= 0 ? "+" : "") + s.avg.toFixed(2)} net$${s.net.toFixed(0)}` : "n=0";

const { m1, m5 } = load(`${DATA_DIR}/GC_1m.csv`);
const all = backtest(m1, m5);
(globalThis as any).__allTrades = all;
const days = [...new Set(all.map(t => t.dayISO))].sort();
const cut = days[Math.floor(days.length * 0.6)];
const W = 116;
console.log("GOLD RSI-BOUNCE (MGC) — engine-exact, FULL trade management, 24h rolling 200-bar buffer");
console.log(`Sessions the live engine allows gold: morning, midday, afternoon, eth_evening. ${m5.length} 5-min bars, ${days[0]} → ${days[days.length - 1]}`);
console.log(`Costs: 1 tick ($1.00) adverse entry + 1 tick on market exits + $${COMMISSION} round-turn.\n`);
console.log("═".repeat(W));
console.log("  OVERALL");
console.log("═".repeat(W));
console.log("  FULL : " + f(stats(all)));
console.log("  TRAIN: " + f(stats(all.filter(t => t.dayISO <= cut))));
console.log("  TEST : " + f(stats(all.filter(t => t.dayISO > cut))) +
  (stats(all.filter(t => t.dayISO <= cut))!.avg > 0 && stats(all.filter(t => t.dayISO > cut))!.avg > 0 ? "   <<< POSITIVE IN BOTH HALVES" : "   <<< fails both-halves"));
if (SINCE) console.log(`  SINCE ${SINCE}: ` + f(stats(all.filter(t => t.dayISO >= SINCE))));

console.log("\n" + "═".repeat(W));
console.log("  BY SESSION — where the edge actually lives (the lever that costs no extra risk)");
console.log("═".repeat(W));
for (const s of ["morning", "midday", "afternoon", "eth_evening", "eth_asia", "eth_europe", "open", "close", "pre_market"]) {
  const sub = all.filter(t => t.session === s);
  if (!sub.length) continue;
  const tr = stats(sub.filter(t => t.dayISO <= cut)), te = stats(sub.filter(t => t.dayISO > cut));
  console.log(`  ${s.padEnd(12)} ` + f(stats(sub)).padEnd(58) +
    `| train PF ${tr ? (tr.pf === Infinity ? 99 : tr.pf).toFixed(2) : "—"} test PF ${te ? (te.pf === Infinity ? 99 : te.pf).toFixed(2) : "—"}` +
    (tr && te && tr.avg > 0 && te.avg > 0 ? "  <<< BOTH HALVES" : ""));
}
console.log("\n" + "═".repeat(W));
console.log("  BY DIRECTION");
console.log("═".repeat(W));
for (const d of ["long", "short"] as const) {
  const sub = all.filter(t => t.dir === d);
  const tr = stats(sub.filter(t => t.dayISO <= cut)), te = stats(sub.filter(t => t.dayISO > cut));
  console.log(`  ${d.padEnd(12)} ` + f(stats(sub)).padEnd(58) +
    `| train PF ${tr ? (tr.pf === Infinity ? 99 : tr.pf).toFixed(2) : "—"} test PF ${te ? (te.pf === Infinity ? 99 : te.pf).toFixed(2) : "—"}` +
    (tr && te && tr.avg > 0 && te.avg > 0 ? "  <<< BOTH HALVES" : ""));
}
console.log("\n  SESSION x DIRECTION");
for (const s of ["morning", "midday", "afternoon", "eth_evening", "eth_europe", "eth_asia"]) {
  for (const d of ["long", "short"] as const) {
    const sub = all.filter(t => t.session === s && t.dir === d);
    if (sub.length < 20) { console.log(`  ${(s + " " + d).padEnd(26)} n=${sub.length} — too few to judge`); continue; }
    const tr = stats(sub.filter(t => t.dayISO <= cut)), te = stats(sub.filter(t => t.dayISO > cut));
    console.log(`  ${(s + " " + d).padEnd(26)} ` + f(stats(sub)).padEnd(58) +
      `| train PF ${tr ? (tr.pf === Infinity ? 99 : tr.pf).toFixed(2) : "—"} test PF ${te ? (te.pf === Infinity ? 99 : te.pf).toFixed(2) : "—"}` +
      (tr && te && tr.avg > 0 && te.avg > 0 ? "  <<< BOTH HALVES" : ""));
  }
}
const byExit: Record<string, { n: number; net: number }> = {};
for (const t of all) { byExit[t.exit] ??= { n: 0, net: 0 }; byExit[t.exit].n++; byExit[t.exit].net += t.pnl; }
console.log("\n  exits: " + Object.entries(byExit).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ${v.n} ($${v.net.toFixed(0)})`).join(" | "));

// ── G_HOURLY=1: the 8:30 landmine check (2026-08-10). CPI/NFP release at 8:30 ET sits INSIDE the
// London gold window (03:00-09:00). Buckets London LONGS by entry half-hour; then splits the
// 08:00-09:00 entries into NFP days (first Friday of month — computable offline) vs all others.
// CPI dates are not derivable offline, so the 8:30 bucket's all-days row is the primary evidence.
if (process.env.G_HOURLY === "1") {
  const lon = (globalThis as any).__allTrades?.filter((t: T) => t.dir === "long" && t.hour >= 3 && t.hour < 9) ?? [];
  console.log(`\nLONDON GOLD LONGS BY ENTRY HALF-HOUR (n=${lon.length})`);
  const pfOf = (a: T[]) => { const g = a.filter(t => t.pnl > 0).reduce((x, t) => x + t.pnl, 0), l = Math.abs(a.filter(t => t.pnl <= 0).reduce((x, t) => x + t.pnl, 0)); return l > 0 ? g / l : Infinity; };
  for (let h = 3; h < 9; h += 0.5) {
    const b = lon.filter((t: T) => t.hour >= h && t.hour < h + 0.5);
    if (b.length < 3) continue;
    const net = b.reduce((x: number, t: T) => x + t.pnl, 0);
    const win = b.filter((t: T) => t.pnl > 0).length / b.length;
    console.log(`  ${String(h).padStart(4)}-${h + 0.5}  n=${String(b.length).padStart(3)}  win ${(win * 100).toFixed(0).padStart(3)}%  PF ${pfOf(b).toFixed(2).padStart(5)}  net $${net.toFixed(0).padStart(6)}${h === 8 || h === 8.5 ? "  <- release window" : ""}`);
  }
  const isNFP = (iso: string) => { const d = new Date(iso + "T12:00:00Z"); return d.getUTCDay() === 5 && d.getUTCDate() <= 7; };
  const late = lon.filter((t: T) => t.hour >= 8);
  const nfp = late.filter((t: T) => isNFP(t.dayISO)), other = late.filter((t: T) => !isNFP(t.dayISO));
  console.log(`  08:00-09:00 split — NFP days: n=${nfp.length} net $${nfp.reduce((x: number, t: T) => x + t.pnl, 0).toFixed(0)}  |  non-NFP: n=${other.length} net $${other.reduce((x: number, t: T) => x + t.pnl, 0).toFixed(0)}`);
}
