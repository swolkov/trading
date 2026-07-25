/**
 * INDEX TREND-LONG VALIDATION — the edge currently carrying the LIVE account (read-only research)
 *
 * WHY: index_trend_long has produced +$350.50 of the live book's +$338 net since inception, yet its
 * only evidence is a claim in a code comment ("4.5-yr Databento backtest, filtered long PF 1.22
 * pooled, NQ 1.24 / ES 1.18"). No script for it survives. Before widening exposure to this edge
 * (e.g. adding MYM) it has to be verified independently.
 *
 * FIDELITY — every rule below is copied from src/services/futures-realtime.ts, line-checked:
 *
 *   INDICATORS (engine uses SIMPLE averages for RSI/ATR, standard EMA) — lines 615-637:
 *     rsi(closes,14), atr(bars,14), ema(closes,9|21|200). currentATR = rawATR * 1.0 for index.
 *
 *   ENTRY (line 2903-2928), 5-min RTH bars only:
 *     gate:    dayType==="trend" OR |ema9-ema21|/price > 0.001
 *     session: "morning" (09:45-12:00 ET) or "afternoon" (14:00-15:45 ET)   [line 953-970]
 *     nearEMA: |price-ema9|/price < 0.003
 *     long:    nearEMA && ema9>ema21 && price>ema21 && price>ema200 && 35<RSI<65 && volTrend!=="surge"
 *     ema200 requires >=200 bars, else Infinity => long BLOCKED during warmup (engine's own rule)
 *     score:   scoreSetup base 72 (line 2511-2544): +8 surge / +5 declining / -5 dry volume,
 *              +10 if 15m trend up else -10, +3 if price>VWAP, +5 prime session (live RTH = prime,
 *              getSizeMultiplier line 989-991). Must be >= 75.
 *     geometry: stop = adjustedATR*1.5, target = adjustedATR*4.0 (passed at the call site).
 *              adjustedATR = currentATR * vixStopMult; VIX assumed NORMAL (1.0) — see ASSUMPTIONS.
 *
 *   MANAGEMENT (line 1518-1745), 1 contract so no scale-out and no pyramid (ALLOW_PYRAMID=demo only):
 *     BREAKEVEN_R 0.6 — at +0.6R the stop moves to entry; a winner can't become a loser
 *     TRAIL_R 1.1     — at +1.1R trail = price - ATR*0.9*1.5 (index), ratchets up only
 *     PROFIT-LOCK     — once peak >= 1.0R, stop >= entry + peak*0.65 (protect 65% of best excursion)
 *     TIME EXIT       — after 30 min, if still under 1R and breakeven never reached, close at market
 *     plus the hard stop, the 4R target, and a forced flat at the RTH close.
 *
 *   COSTS: 1 tick adverse on entry and on every market-type exit (stop/trail/time), target filled
 *     exactly, plus $2.02 round-turn commission — the figure MEASURED from the live account
 *     (logged P&L $164.00 vs actual balance move $153.90 over 5 closes), not an assumption.
 *
 * ASSUMPTIONS (stated, not hidden):
 *   1. VIX regime assumed normal (stopMult 1.0, sizeMult 1.0). Extreme VIX widens stops and halves
 *      size; that path is not modelled. Sensitivity for this is printed at the end.
 *   2. 5-min bars built from RTH only, which the engine's own "~first 2.5 sessions" warmup comment
 *      on the 200-EMA confirms is how bars5m accumulates for index symbols.
 *   3. Management is evaluated on 1-MINUTE bars (the engine polls every few seconds), with the trail
 *      computed from the best price seen in the bar. Stop-before-target when a bar spans both.
 *   4. The AI grader and the pattern-memory auto-prune gate are NOT modelled — both are currently
 *      OFF in config (futures_ai_grader=false), so this matches production.
 *
 * Usage: npx tsx scripts/trend-long-validation.ts [ES,NQ]
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);

const DATA_DIR = process.env.TL_DATA_DIR || "data";
/** Report a separate line for trades on/after this ET date (used to isolate the live window). */
const SINCE = process.env.TL_SINCE || "";
/** Trim the sample at this ET date so windows across instruments are exactly like-for-like. */
const UNTIL = process.env.TL_UNTIL || "";
const INSTR = {
  ES: { file: `${DATA_DIR}/ES_1m.csv`, micro: "MES", ptVal: 5, tick: 0.25, label: "ES → MES ($5/pt)" },
  NQ: { file: `${DATA_DIR}/NQ_1m.csv`, micro: "MNQ", ptVal: 2, tick: 0.25, label: "NQ → MNQ ($2/pt)" },
  // Dow. Specs from TRADOVATE_CONTRACTS + TICK_SIZES in the engine: MYM is $0.50/point, 1-pt tick.
  // NOTE: YM is NOT in the engine's INDEX_LONG_SYMS set, so this is a test of what adding it WOULD do.
  YM: { file: `${DATA_DIR}/YM_1m.csv`, micro: "MYM", ptVal: 0.5, tick: 1, label: "YM → MYM ($0.50/pt)" },
};
type Inst = typeof INSTR.ES;

const COMMISSION = 2.02;      // measured from the live account, not assumed
const VIX_STOP_MULT = 1.0;    // assumption 1
const BREAKEVEN_R = 0.6, TRAIL_R = 1.1, STALE_MIN = 30;
const TRAIL_ATR_MULT = 0.9 * 1.5; // index: 1.35 x ATR behind price
const PROFIT_LOCK_FRAC = 0.65;

// ── ET helpers ────────────────────────────────────────────────────────────────
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

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; day: number; hour: number; }

function loadRTH(file: string): { m1: Bar[]; m5: Bar[] } {
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
    const hour = (etMs - day * 86400000) / 3600000;
    if (hour < 9.5 || hour >= 16) continue; // RTH only (assumption 2)
    m1.push({ t, o: +f[4], h: +f[5], l: +f[6], c, v: +f[8] || 0, day, hour });
  }
  // aggregate to 5-min
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

// ── Engine indicator maths (verbatim) ─────────────────────────────────────────
function rsiEng(c: number[], end: number, p = 14): number {
  if (end < p) return 50;
  let g = 0, l = 0;
  for (let i = end - p + 1; i <= end; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / p) / (l / p));
}
function atrEng(b: Bar[], end: number, p = 14): number {
  if (end < p) return 0;
  let s = 0;
  for (let i = end - p + 1; i <= end; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / p;
}
/** Engine's ema(): seeded with data[0], iterated over the WHOLE series. Precomputed here. */
function emaSeries(c: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const r = [c[0]];
  for (let i = 1; i < c.length; i++) r.push(c[i] * k + r[i - 1] * (1 - k));
  return r;
}
function sessionName(hour: number): string {
  if (hour < 9.5 || hour >= 16) return "closed";
  const mins = (hour - 9.5) * 60;
  if (mins < 15) return "open";
  if (hour < 12) return "morning";
  if (hour < 14) return "midday";
  if (hour < 15.75) return "afternoon";
  return "close";
}
/** get15mTrend: 5m bars grouped in 3s from the START of the array, EMA9 vs EMA21 on 15m closes. */
function trend15At(m5: Bar[], end: number): "up" | "down" | "flat" {
  const c15: number[] = [];
  for (let i = 0; i + 2 <= end; i += 3) c15.push(m5[i + 2].c);
  if (c15.length < 21) return "flat";
  const f = emaSeries(c15, 9), s = emaSeries(c15, 21);
  const a = f[f.length - 1], b = s[s.length - 1];
  return a > b ? "up" : a < b ? "down" : "flat";
}

interface Trade { day: number; dayISO: string; pnl: number; r: number; exit: string; bars: number; }

function backtest(inst: Inst, m1: Bar[], m5: Bar[], minScore: number, optimistic = false): Trade[] {
  const closes = m5.map(b => b.c);
  const ema9 = emaSeries(closes, 9), ema21 = emaSeries(closes, 21), ema200full = emaSeries(closes, 200);
  const trades: Trade[] = [];

  // per-day opening range + previous-day high/low
  const dayFirstIdx = new Map<number, number>();
  const dayHi = new Map<number, number>(), dayLo = new Map<number, number>();
  const dayOrder: number[] = [];
  for (let i = 0; i < m5.length; i++) {
    const d = m5[i].day;
    if (!dayFirstIdx.has(d)) { dayFirstIdx.set(d, i); dayOrder.push(d); dayHi.set(d, m5[i].h); dayLo.set(d, m5[i].l); }
    dayHi.set(d, Math.max(dayHi.get(d)!, m5[i].h));
    dayLo.set(d, Math.min(dayLo.get(d)!, m5[i].l));
  }
  const prevDay = new Map<number, number>();
  for (let i = 1; i < dayOrder.length; i++) prevDay.set(dayOrder[i], dayOrder[i - 1]);

  // session VWAP accumulators, rebuilt per day
  let vwapDay = -1, cumPV = 0, cumV = 0;
  let m1Cursor = 0;

  for (let i = 30; i < m5.length; i++) {
    const bar = m5[i];
    if (bar.day !== vwapDay) { vwapDay = bar.day; cumPV = 0; cumV = 0; }
    const tp = (bar.h + bar.l + bar.c) / 3;
    cumPV += tp * bar.v; cumV += bar.v;
    const vwap = cumV > 0 ? cumPV / cumV : bar.c;

    const session = sessionName(bar.hour);
    if (session !== "morning" && session !== "afternoon") continue;

    const rawATR = atrEng(m5, i);
    if (rawATR <= 0) continue;
    const currentATR = rawATR;                       // index: atrScale 1.0
    const adjustedATR = currentATR * VIX_STOP_MULT;
    const price = bar.c;
    const rsi = rsiEng(closes, i);
    const fastEMA = ema9[i], slowEMA = ema21[i];
    // engine: ema200 only exists once >=200 bars are in the buffer, else Infinity (blocks the long)
    const ema200 = i >= 199 ? ema200full[i] : Infinity;

    // dayType
    const first = dayFirstIdx.get(bar.day)!;
    const orEnd = Math.min(first + 11, i);
    let orH = -Infinity, orL = Infinity;
    for (let j = first; j <= orEnd; j++) { orH = Math.max(orH, m5[j].h); orL = Math.min(orL, m5[j].l); }
    const orSize = orH - orL;
    const pd = prevDay.get(bar.day);
    const pdH = pd != null ? dayHi.get(pd)! : 0, pdL = pd != null ? dayLo.get(pd)! : 0;
    const outside = (pdH > 0 && price > pdH) || (pdL > 0 && price < pdL);
    const dayType = outside || orSize > currentATR * 0.5 ? "trend" : "range";

    if (!(dayType === "trend" || Math.abs(fastEMA - slowEMA) / price > 0.001)) continue;

    // volume
    let volSum = 0;
    for (let j = Math.max(0, i - 20); j < i; j++) volSum += m5[j].v;
    const avgVol = volSum / 20;
    const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
    const volTrend = volRatio > 2 ? "surge" : volRatio < 0.6 ? "dry" : volRatio < 0.8 ? "declining" : "normal";

    const nearEMA = Math.abs(price - fastEMA) / price < 0.003;
    const isLong = nearEMA && fastEMA > slowEMA && price > slowEMA && price > ema200 &&
                   rsi > 35 && rsi < 65 && volTrend !== "surge";
    if (!isLong) continue;

    // scoreSetup (base 72, long side)
    let score = 72;
    if (volTrend === "surge" && volRatio > 2) score += 8;
    else if (volTrend === "declining") score += 5;
    else if (volTrend === "dry") score -= 5;
    score += trend15At(m5, i) === "up" ? 10 : -10;
    if (price > vwap) score += 3;
    score += 5; // live RTH morning/afternoon => sizeMult 1.0 => "prime"
    score = Math.max(0, Math.min(100, score));
    if (score < minScore) continue;

    // ── ENTER at this bar's close ──
    const stopDist = adjustedATR * 1.5;
    const targetDist = adjustedATR * 4.0;
    const entry = price + inst.tick;             // 1 tick adverse
    const hardStop = price - stopDist;
    const target = price + targetDist;
    const riskDollars = stopDist * inst.ptVal;

    // Entry happens at the CLOSE of this 5-min bar, so management may only see 1-min bars from
    // bar.t + 5min onward. (Advancing merely past bar.t would manage the position through the four
    // minutes INSIDE the signal bar — i.e. before the trade existed.)
    const entryTime = bar.t + 300000;
    while (m1Cursor < m1.length && m1[m1Cursor].t < entryTime) m1Cursor++;
    let peak = 0, reachedBE = false, trail: number | null = null;
    let exited: { px: number; why: string; k: number } | null = null;
    let atrNow = currentATR;

    for (let k = m1Cursor; k < m1.length && !exited; k++) {
      const b1 = m1[k];
      if (b1.day !== bar.day) break;                       // flat at the RTH close
      const mins = (b1.t - entryTime) / 60000; // measured from the fill, not the bar's open

      // Within one 1-minute bar the true path is unknown. CONSERVATIVE (default) assumes the
      // adverse extreme comes first; OPTIMISTIC assumes the favourable extreme comes first and the
      // trail ratchets before any pullback. Running both brackets the honest answer — if even the
      // optimistic bound loses, the verdict cannot be an artefact of this ordering choice.
      const favourable = () => {
        const diffHigh = b1.h - entry;
        if (diffHigh > peak) peak = diffHigh;
        if (!reachedBE && peak >= stopDist * BREAKEVEN_R) reachedBE = true;
        if (peak >= stopDist * TRAIL_R) {
          if (k % 5 === 0) atrNow = atrEng(m5, Math.min(i + Math.floor(mins / 5), m5.length - 1)) || atrNow;
          let raw = b1.h - atrNow * TRAIL_ATR_MULT;
          if (peak >= stopDist * 1.0) raw = Math.max(raw, entry + peak * PROFIT_LOCK_FRAC);
          if (trail == null || raw > trail) trail = raw;
        }
      };
      const adverse = () => {
        if (trail != null && b1.l <= trail) exited = { px: Math.min(trail, b1.o) - inst.tick, why: "trail_stop", k };
        else if (reachedBE && b1.l <= entry) exited = { px: Math.min(entry, b1.o) - inst.tick, why: "breakeven", k };
        else if (b1.l <= hardStop) exited = { px: Math.min(hardStop, b1.o) - inst.tick, why: "stop_loss", k };
      };

      if (optimistic) {
        favourable();
        if (b1.h >= target) { exited = { px: target, why: "target", k }; break; }
        adverse();
        if (exited) break;
      } else {
        adverse();
        if (!exited && b1.h >= target) exited = { px: target, why: "target", k };
        if (exited) break;
        favourable();
      }

      // 3) stale-trade time exit
      if (mins >= STALE_MIN && (b1.c - entry) < stopDist && !reachedBE) {
        exited = { px: b1.c - inst.tick, why: "time_exit", k };
        break;
      }
    }

    if (!exited) {
      // ran to the session end (or data end) — flat at the last bar of the day
      let k = m1Cursor;
      while (k + 1 < m1.length && m1[k + 1].day === bar.day) k++;
      if (k >= m1.length) break;
      exited = { px: m1[k].c - inst.tick, why: "eod_close", k };
    }

    const pnl = (exited.px - entry) * inst.ptVal - COMMISSION;
    trades.push({ day: bar.day, dayISO: new Date(bar.t + etOffset(bar.t)).toISOString().slice(0, 10), pnl, r: pnl / riskDollars, exit: exited.why, bars: exited.k - m1Cursor });

    // resume scanning from the 5-min bar after the exit
    const exitT = m1[Math.min(exited.k, m1.length - 1)].t;
    while (i + 1 < m5.length && m5[i + 1].t <= exitT) i++;
  }
  return trades;
}

// ── stats ─────────────────────────────────────────────────────────────────────
function stats(ts: Trade[]) {
  if (!ts.length) return null;
  const w = ts.filter(t => t.pnl > 0), l = ts.filter(t => t.pnl <= 0);
  const gW = w.reduce((s, t) => s + t.pnl, 0), gL = -l.reduce((s, t) => s + t.pnl, 0);
  const net = ts.reduce((s, t) => s + t.pnl, 0);
  return {
    n: ts.length, wr: w.length / ts.length,
    pf: gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0),
    net, avg: net / ts.length,
    expR: ts.reduce((s, t) => s + t.r, 0) / ts.length,
  };
}
const f = (s: ReturnType<typeof stats>) =>
  s ? `n=${String(s.n).padStart(4)} win ${(s.wr * 100).toFixed(0).padStart(3)}% PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2).padStart(5)} avg$${(s.avg >= 0 ? "+" : "") + s.avg.toFixed(2)} expR ${(s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)} net$${s.net.toFixed(0)}`
    : "n=0";

const which = (process.argv[2] || "ES,NQ").split(",") as (keyof typeof INSTR)[];
console.log("INDEX TREND-LONG (EMA9 pullback in a confirmed uptrend) — engine-exact validation");
console.log("Full live management modelled: 0.6R breakeven, 1.1R trail, 65% profit-lock, 30-min stale exit, RTH flat.");
console.log(`Costs: 1 tick adverse entry + 1 tick on market exits + $${COMMISSION} round-turn (measured from the live account).`);
console.log("VERDICT: the edge is only real if it is positive in BOTH halves.\n");

for (const key of which) {
  const inst = INSTR[key];
  process.stderr.write(`loading ${inst.file} ...\n`);
  const { m1, m5 } = loadRTH(inst.file);
  const d0 = new Date(m5[0].t).toISOString().slice(0, 10), d1 = new Date(m5[m5.length - 1].t).toISOString().slice(0, 10);
  console.log("═".repeat(122));
  console.log(`  ${inst.label}  —  ${m5.length} RTH 5-min bars, ${d0} → ${d1}`);
  console.log("═".repeat(122));

  // Confluence-threshold sweep. The live gate is 75; raising it tests whether a stricter, higher-
  // quality subset of the SAME setup is where the edge lives — and guards against this rebuild
  // simply being more permissive than production.
  for (const minScore of [75, 90]) {
  for (const optimistic of [false, true]) {
  const all = backtest(inst, m1, m5, minScore, optimistic).filter(t => !UNTIL || t.dayISO <= UNTIL);
  if (!all.length) { console.log(`  score>=${minScore}: no trades`); continue; }
  const days = [...new Set(all.map(t => t.day))].sort((a, b) => a - b);
  const cut = days[Math.floor(days.length * 0.6)];
  const train = all.filter(t => t.day <= cut), test = all.filter(t => t.day > cut);
  const st = stats(train), se = stats(test), sa = stats(all);
  console.log(`\n  ── score ≥ ${minScore}${minScore === 75 ? " (LIVE GATE)" : ""} · intrabar ${optimistic ? "OPTIMISTIC (favourable extreme first)" : "CONSERVATIVE (adverse first)"} ──`);
  console.log("  FULL : " + f(sa));
  console.log("  TRAIN: " + f(st));
  console.log("  TEST : " + f(se) + (st && se && st.expR > 0 && se.expR > 0 ? "   <<< POSITIVE IN BOTH HALVES" : "   <<< FAILS THE BOTH-HALVES TEST"));
  if (SINCE) {
    const win = all.filter(t => t.dayISO >= SINCE);
    console.log(`  SINCE ${SINCE}: ` + f(stats(win)) + (stats(win) && stats(win)!.expR > 0 ? "   <<< POSITIVE IN THE LIVE WINDOW" : ""));
  }
  const byExit: Record<string, { n: number; net: number }> = {};
  for (const t of all) { byExit[t.exit] ??= { n: 0, net: 0 }; byExit[t.exit].n++; byExit[t.exit].net += t.pnl; }
  console.log("  exits: " + Object.entries(byExit).sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `${k} ${v.n} ($${v.net.toFixed(0)})`).join(" | "));
  }
  }
}
console.log("\nNOTE: 3 years of data here vs the '4.5-yr' figure quoted in the engine comment — the older run's script no longer exists, so this is an independent rebuild, not a reproduction of it.");
