/**
 * TIMEFRAME SWEEP for the RSI-extreme mean-reversion edge (read-only research)
 *
 * QUESTION: the live engine trades this edge on 5-MINUTE bars. The same edge on DAILY bars is
 * strongly durable (26-yr gold test, PF ~1.58). Is 5-min simply the wrong bar size? Sweep
 * 1 / 3 / 5 / 15 / 30 / 60-minute bars and see where (if anywhere) the edge pays after real costs.
 *
 * FIDELITY — indicators are copied from the LIVE engine (src/services/futures-realtime.ts:623-637),
 *   which uses SIMPLE (not Wilder) averages for both RSI and ATR. Verified line-by-line.
 *   Signal (futures-realtime ~2716): RSI(14) < 25 -> long, > 75 -> short; skip when the bar's
 *   volume > 2x the trailing 20-bar average (the engine treats a volume surge as capitulation).
 *   Entry at the close of the signal bar. One position at a time (engine gates one per symbol).
 *
 * EXITS — two parameter sets:
 *   LIVE   : stop 1.4 x ATR(14), target 5.0 x ATR(14)  <- what the engine is configured with TODAY
 *            (DB: futures_atr_stop_multiplier=1.4, futures_atr_target_multiplier=5)
 *   CLASSIC: stop 1.5 x ATR(14), target 3.5 x ATR(14)  <- the older documented setting, for contrast
 *
 * HOLD REGIMES — reported separately, they are different businesses:
 *   A) INTRADAY (engine-faithful): bars built ONLY from the session window the engine trades
 *      (gold 08:20-18:00 ET, index RTH 09:30-16:00 ET) and every trade force-closed at session end.
 *   B) SWING: bars built from ALL hours (continuous), entries still only inside the session window,
 *      but a trade may be held across sessions for up to MAX_HOLD_DAYS. This needs overnight margin
 *      and carries gap risk -- flagged in the output, not assumed away.
 *
 * FILL REALISM (per micro contract):
 *   - entry: 1 tick adverse
 *   - stop:  1 tick adverse; if the next bar OPENS beyond the stop, fill at that open (gap-through)
 *   - target: filled at the target; if a bar opens beyond it, fill at the open
 *   - a bar that spans both stop and target is counted as the STOP (conservative)
 *   - commission: $1.30 round-turn. Micro $/pt: MGC 10, MNQ 2, MES 5.
 *
 * SPLIT: train = first 60% of trading dates, test = last 40%. A timeframe only "works" if it is
 *   positive in BOTH halves -- one good half is variance, not an edge.
 *
 * Usage: npx tsx scripts/timeframe-sweep.ts [GC,NQ,ES]
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);

const INSTR = {
  GC: { file: "data/GC_1m.csv", ptVal: 10, tick: 0.1, comm: 1.30, sessStart: 8 + 20 / 60, sessEnd: 18.0, label: "GOLD (MGC)" },
  NQ: { file: "data/NQ_1m.csv", ptVal: 2, tick: 0.25, comm: 1.30, sessStart: 9.5, sessEnd: 16.0, label: "INDEX NQ (MNQ)" },
  ES: { file: "data/ES_1m.csv", ptVal: 5, tick: 0.25, comm: 1.30, sessStart: 9.5, sessEnd: 16.0, label: "INDEX ES (MES)" },
};
type Inst = typeof INSTR.GC;

const TIMEFRAMES = [1, 3, 5, 15, 30, 60];
const PARAM_SETS = [
  { name: "LIVE   (stop 1.4 / target 5.0)", stop: 1.4, target: 5.0 },
  { name: "CLASSIC(stop 1.5 / target 3.5)", stop: 1.5, target: 3.5 },
];
const MAX_HOLD_DAYS = 5; // swing regime only

// ── Raw 1-minute load into compact parallel arrays (1M+ rows per instrument) ──

interface Raw { n: number; ms: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array; }

function loadRaw(file: string): Raw {
  const text = fs.readFileSync(new URL(file, ROOT), "utf8");
  const lines = text.split("\n");
  const cap = lines.length;
  const ms = new Float64Array(cap), o = new Float64Array(cap), h = new Float64Array(cap);
  const l = new Float64Array(cap), c = new Float64Array(cap), v = new Float64Array(cap);
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row) continue;
    const f = row.split(",");
    const t = Date.parse(f[0]);
    const cl = +f[7];
    if (!isFinite(t) || !isFinite(cl) || cl <= 0) continue;
    ms[n] = t; o[n] = +f[4]; h[n] = +f[5]; l[n] = +f[6]; c[n] = cl; v[n] = +f[8] || 0;
    n++;
  }
  return { n, ms, o, h, l, c, v };
}

// ── ET conversion: resolve the UTC offset once per UTC hour (exact across DST) ──

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const offsetCache = new Map<number, number>(); // utcHourIndex -> offset ms (ET - UTC, negative)
function etOffsetMs(t: number): number {
  const hourIdx = Math.floor(t / 3600000);
  const hit = offsetCache.get(hourIdx);
  if (hit !== undefined) return hit;
  const p: any = {};
  for (const part of etFmt.formatToParts(hourIdx * 3600000)) p[part.type] = part.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute);
  const off = asUtc - hourIdx * 3600000;
  offsetCache.set(hourIdx, off);
  return off;
}

// ── Aggregate 1-minute rows into N-minute bars ──
// sessionOnly=true keeps ONLY bars inside [sessStart, sessEnd) ET (engine-faithful intraday series).
// sessionOnly=false keeps every bar (continuous series used by the swing regime).

interface Series {
  n: number;
  ms: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array;
  day: Int32Array;   // ET day index (days since epoch in ET)
  hour: Float64Array; // ET hour-of-day, fractional
}

function aggregate(raw: Raw, tfMin: number, sessStart: number, sessEnd: number, sessionOnly: boolean): Series {
  const bucketMs = tfMin * 60000;
  const cap = Math.ceil(raw.n / tfMin) + 16;
  const ms = new Float64Array(cap), o = new Float64Array(cap), h = new Float64Array(cap);
  const l = new Float64Array(cap), c = new Float64Array(cap), v = new Float64Array(cap);
  const day = new Int32Array(cap), hour = new Float64Array(cap);
  let n = 0, curKey = -1;

  for (let i = 0; i < raw.n; i++) {
    const t = raw.ms[i];
    const etMs = t + etOffsetMs(t);
    const etDay = Math.floor(etMs / 86400000);
    const etHour = (etMs - etDay * 86400000) / 3600000;
    if (sessionOnly && (etHour < sessStart || etHour >= sessEnd)) continue;

    const key = Math.floor(t / bucketMs);
    if (key !== curKey) {
      curKey = key;
      ms[n] = key * bucketMs; o[n] = raw.o[i]; h[n] = raw.h[i]; l[n] = raw.l[i]; c[n] = raw.c[i]; v[n] = raw.v[i];
      day[n] = etDay; hour[n] = etHour;
      n++;
    } else {
      const j = n - 1;
      if (raw.h[i] > h[j]) h[j] = raw.h[i];
      if (raw.l[i] < l[j]) l[j] = raw.l[i];
      c[j] = raw.c[i]; v[j] += raw.v[i];
    }
  }
  return { n, ms, o, h, l, c, v, day, hour };
}

// ── Indicators — copied from the live engine (simple averages, NOT Wilder) ──

function rsiAt(c: Float64Array, i: number, p = 14): number {
  if (i < p) return 50;
  let g = 0, l = 0;
  for (let j = i - p + 1; j <= i; j++) { const d = c[j] - c[j - 1]; if (d > 0) g += d; else l -= d; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function atrAt(s: Series, i: number, p = 14): number {
  if (i < p) return 0;
  let sum = 0;
  for (let j = i - p + 1; j <= i; j++) {
    const tr = Math.max(s.h[j] - s.l[j], Math.abs(s.h[j] - s.c[j - 1]), Math.abs(s.l[j] - s.c[j - 1]));
    sum += tr;
  }
  return sum / p;
}
function volSurge(s: Series, i: number): boolean {
  if (i < 20) return false;
  let sum = 0;
  for (let j = i - 20; j < i; j++) sum += s.v[j];
  const avg = sum / 20;
  return avg > 0 && s.v[i] > avg * 2;
}

// ── Backtest ──

interface Trade { day: number; pnl: number; r: number; win: boolean; outcome: string; bars: number; }

function backtest(inst: Inst, s: Series, stopMult: number, targetMult: number, swing: boolean): Trade[] {
  const trades: Trade[] = [];
  const tick = inst.tick;
  let nextFreeIdx = 0;

  for (let i = 30; i < s.n; i++) {
    if (i < nextFreeIdx) continue;
    // entries only inside the session window (matters for the continuous swing series)
    if (swing && (s.hour[i] < inst.sessStart || s.hour[i] >= inst.sessEnd)) continue;

    const r = rsiAt(s.c, i);
    if (!(r < 25 || r > 75)) continue;
    const atr = atrAt(s, i);
    if (atr <= 0) continue;
    if (volSurge(s, i)) continue;

    const short = r > 75;
    const entry = s.c[i];
    const fill = short ? entry - tick : entry + tick;      // 1 tick adverse
    const stop = short ? entry + atr * stopMult : entry - atr * stopMult;
    const target = short ? entry - atr * targetMult : entry + atr * targetMult;
    const riskDollars = atr * stopMult * inst.ptVal;
    const pnlAt = (px: number) => (short ? fill - px : px - fill) * inst.ptVal - inst.comm;

    let done = false;
    for (let j = i + 1; j < s.n; j++) {
      // ── time-based exits ──
      if (!swing && s.day[j] !== s.day[i]) {            // intraday: flat at session end
        const pnl = pnlAt(s.c[j - 1]);
        trades.push({ day: s.day[i], pnl, r: pnl / riskDollars, win: pnl > 0, outcome: "eod", bars: j - i });
        nextFreeIdx = j; done = true; break;
      }
      if (swing && s.day[j] - s.day[i] > MAX_HOLD_DAYS) { // swing: max-hold
        const pnl = pnlAt(s.c[j]);
        trades.push({ day: s.day[i], pnl, r: pnl / riskDollars, win: pnl > 0, outcome: "maxhold", bars: j - i });
        nextFreeIdx = j; done = true; break;
      }

      // ── gap-through: this bar OPENED beyond a level -> that open is the fill ──
      const openBeyondStop = short ? s.o[j] >= stop : s.o[j] <= stop;
      if (openBeyondStop) {
        const pnl = pnlAt(s.o[j]);
        trades.push({ day: s.day[i], pnl, r: pnl / riskDollars, win: pnl > 0, outcome: "stop_gap", bars: j - i });
        nextFreeIdx = j; done = true; break;
      }
      const openBeyondTgt = short ? s.o[j] <= target : s.o[j] >= target;
      if (openBeyondTgt) {
        const pnl = pnlAt(s.o[j]);
        trades.push({ day: s.day[i], pnl, r: pnl / riskDollars, win: pnl > 0, outcome: "target_gap", bars: j - i });
        nextFreeIdx = j; done = true; break;
      }

      // ── intrabar: stop first when a bar spans both (conservative) ──
      const stopHit = short ? s.h[j] >= stop : s.l[j] <= stop;
      if (stopHit) {
        const px = short ? stop + tick : stop - tick;
        const pnl = pnlAt(px);
        trades.push({ day: s.day[i], pnl, r: pnl / riskDollars, win: pnl > 0, outcome: "stop", bars: j - i });
        nextFreeIdx = j; done = true; break;
      }
      const tgtHit = short ? s.l[j] <= target : s.h[j] >= target;
      if (tgtHit) {
        const pnl = pnlAt(target);
        trades.push({ day: s.day[i], pnl, r: pnl / riskDollars, win: pnl > 0, outcome: "target", bars: j - i });
        nextFreeIdx = j; done = true; break;
      }
    }
    if (!done) break; // ran out of data mid-trade
  }
  return trades;
}

// ── Stats ──

function stats(ts: Trade[]) {
  if (!ts.length) return null;
  const wins = ts.filter(t => t.win), losses = ts.filter(t => !t.win);
  const gW = wins.reduce((s, t) => s + t.pnl, 0);
  const gL = -losses.reduce((s, t) => s + t.pnl, 0);
  const net = ts.reduce((s, t) => s + t.pnl, 0);
  return {
    n: ts.length,
    wr: wins.length / ts.length,
    pf: gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0),
    net,
    avg: net / ts.length,
    expR: ts.reduce((s, t) => s + t.r, 0) / ts.length,
    avgRisk: 0,
    avgBars: ts.reduce((s, t) => s + t.bars, 0) / ts.length,
  };
}
const f = (s: ReturnType<typeof stats>) =>
  s ? `n=${String(s.n).padStart(5)} win ${(s.wr * 100).toFixed(0).padStart(2)}% PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2)} avg$${(s.avg >= 0 ? "+" : "") + s.avg.toFixed(2)} expR ${(s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)} net$${s.net.toFixed(0)}`
    : "n=0";

function run(key: keyof typeof INSTR) {
  const inst = INSTR[key];
  process.stderr.write(`loading ${inst.file} ...\n`);
  const raw = loadRaw(inst.file);
  const W = 132;

  for (const swing of [false, true]) {
    console.log("\n" + "═".repeat(W));
    console.log(`  ${inst.label}  —  RSI-extreme mean-reversion  —  ${swing ? `SWING (hold up to ${MAX_HOLD_DAYS} days, needs overnight margin + gap risk)` : "INTRADAY (flat at session end — what the engine does today)"}`);
    console.log("═".repeat(W));

    for (const ps of PARAM_SETS) {
      console.log(`\n  ${ps.name}`);
      console.log("  " + "TF".padEnd(6) + "| " + "TRAIN (first 60% of dates)".padEnd(58) + "| TEST (last 40%)");
      for (const tf of TIMEFRAMES) {
        const s = aggregate(raw, tf, inst.sessStart, inst.sessEnd, !swing);
        const all = backtest(inst, s, ps.stop, ps.target, swing);
        if (!all.length) { console.log("  " + `${tf}m`.padEnd(6) + "| no trades"); continue; }
        const days = [...new Set(all.map(t => t.day))].sort((a, b) => a - b);
        const cut = days[Math.floor(days.length * 0.6)];
        const train = all.filter(t => t.day <= cut), test = all.filter(t => t.day > cut);
        const st = stats(train), se = stats(test);
        const both = st && se && st.avg > 0 && se.avg > 0;
        console.log("  " + `${tf}m`.padEnd(6) + "| " + f(st).padEnd(58) + "| " + f(se) + (both ? "   <<< POSITIVE IN BOTH" : ""));
      }
    }
  }
}

const which = (process.argv[2] || "GC,NQ,ES").split(",") as (keyof typeof INSTR)[];
console.log("RSI-extreme mean-reversion — TIMEFRAME SWEEP");
console.log("Engine-exact signal (simple RSI/ATR, vol-surge filter), 1 tick adverse entry, gap-through fills, $1.30 RT commission.");
console.log("A timeframe only counts as an edge if avg$/trade is POSITIVE IN BOTH the train and the test half.");
for (const k of which) run(k);
console.log("\nNOTE: SWING rows assume the account can hold 1 micro overnight (margin) and eat gap risk. INTRADAY rows do not.");
