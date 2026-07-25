/**
 * RSI-BOUNCE TARGET-WIDTH SWEEP (read-only research)
 *
 * Question: on the LIVE extreme_rsi_bounce edge (the flagship gold trade, plus index), does a
 * WIDER profit target ("hold winners longer") net more per trade, or does mean-reversion give the
 * gains back? Keep the STOP fixed (1.5*ATR) and vary ONLY the target: 2 / 3 / 3.5(current) / 4 / 5 *ATR.
 *
 * FIDELITY — the entry logic is ported from src/services/futures-realtime.ts (~line 2716):
 *   RSI(14) < 25 -> long ; RSI(14) > 75 -> short. Volume must NOT be surging (exhaustion, not
 *   capitulation). Stop = 1.5*ATR(14). Live target = 3.5*ATR. Entry at close of signal 5m bar.
 *   Wilder RSI/ATR, standard EMA — same math as the engine.
 *
 * DATA: cached Databento 1-min bars in data/<SYM>_1m.csv (GLBX.MDP3 continuous front month),
 *   aggregated to 5-min. GC = gold (May 2023 -> May 2026, ~3yr). NQ/ES = index.
 *   Gold session window = COMEX prime + evening the engine actually trades (08:20-18:00 ET).
 *   Index = RTH only (09:30-16:00 ET), matching the live engine's RTH-only index rule.
 *
 * FILLS (realistic micro): 1-tick adverse entry, 1-tick adverse on stop, +commission round-turn.
 *   Micro contract $/pt: MGC $10, MNQ $2, MES $5. Force-close at session end (no overnight hold).
 *
 * SPLIT: train = first 60% of trading dates, test = last 40%. An improvement is only REAL if it
 *   beats the current 3.5x target in BOTH halves. Better in one half = curve-fit / variance.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);

const INSTR = {
  GC: { file: "data/GC_1m.csv", ptVal: 10, tick: 0.1, comm: 1.30, sessStart: 8 + 20 / 60, sessEnd: 18.0, label: "GOLD (MGC)" },
  NQ: { file: "data/NQ_1m.csv", ptVal: 2, tick: 0.25, comm: 1.30, sessStart: 9.5, sessEnd: 16.0, label: "INDEX NQ (MNQ)" },
  ES: { file: "data/ES_1m.csv", ptVal: 5, tick: 0.25, comm: 1.30, sessStart: 9.5, sessEnd: 16.0, label: "INDEX ES (MES)" },
};
const TARGET_MULTS = [2.0, 3.0, 3.5, 4.0, 5.0]; // *ATR ; stop fixed 1.5*ATR
const STOP_MULT = 1.5;

interface Bar { ms: number; etDate: string; etH: number; o: number; h: number; l: number; c: number; v: number; idxInDay: number; }

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function etParts(ms: number) {
  const p: any = {}; for (const x of etFmt.formatToParts(ms)) p[x.type] = x.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  return { date: `${p.year}-${p.month}-${p.day}`, h: hh + parseInt(p.minute) / 60 };
}

// Load 1m CSV -> aggregate to 5m RTH/session bars. Columns: ts_event(0),...,open(4),high(5),low(6),close(7),volume(8)
function load5m(file: string, sessStart: number, sessEnd: number): Bar[] {
  const text = fs.readFileSync(new URL(file, ROOT), "utf8");
  const rows = text.split("\n"); // skip header
  const buckets = new Map<number, { ms: number; o: number; h: number; l: number; c: number; v: number }>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const c = r.split(",");
    const ms = new Date(c[0]).getTime();
    const o = +c[4], h = +c[5], l = +c[6], cl = +c[7], v = +c[8];
    if (!isFinite(ms) || !isFinite(cl) || cl <= 0) continue;
    const key = Math.floor(ms / 300000);
    const b = buckets.get(key);
    if (!b) buckets.set(key, { ms: key * 300000, o, h, l, c: cl, v });
    else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); b.c = cl; b.v += v; }
  }
  const all = [...buckets.values()].sort((a, b) => a.ms - b.ms);
  const out: Bar[] = []; let curDate = "", idx = 0;
  for (const b of all) {
    const { date, h } = etParts(b.ms);
    if (h < sessStart || h >= sessEnd) continue;
    if (date !== curDate) { curDate = date; idx = 0; }
    idx++;
    out.push({ ms: b.ms, etDate: date, etH: h, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, idxInDay: idx });
  }
  return out;
}

// ── indicators: Wilder RSI/ATR (match engine) ──
function rsiAt(closes: number[], i: number, p = 14): number {
  if (i < p) return 50; let g = 0, l = 0;
  for (let j = i - p + 1; j <= i; j++) { const d = closes[j] - closes[j - 1]; if (d > 0) g += d; else l -= d; }
  const rs = l === 0 ? 100 : g / l; return 100 - 100 / (1 + rs);
}
function atrAt(bars: Bar[], i: number, p = 14): number {
  if (i < p) return 0; let s = 0;
  for (let j = i - p + 1; j <= i; j++) { const tr = Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c)); s += tr; }
  return s / p;
}
// volume "surge" = current bar volume > 2x the trailing 20-bar average (engine treats surge = capitulation, skip)
function volSurge(bars: Bar[], i: number): boolean {
  if (i < 20) return false;
  let s = 0; for (let j = i - 20; j < i; j++) s += bars[j].v; const avg = s / 20;
  return avg > 0 && bars[i].v > avg * 2;
}

type Trade = { date: string; ms: number; dir: "long" | "short"; pnl$: number; rMult: number; win: boolean; outcome: string };

// One backtest pass for a given target multiplier. One position at a time (matches live: inPosition gate).
function backtest(inst: typeof INSTR.GC, bars: Bar[], targetMult: number): Trade[] {
  const closes = bars.map(b => b.c);
  const trades: Trade[] = [];
  const tickSlip = inst.tick;
  let openUntilMs = 0; // don't open a new trade until the current one has resolved (by time)

  for (let i = 30; i < bars.length; i++) {
    const b = bars[i];
    if (b.ms < openUntilMs) continue;
    const rsi = rsiAt(closes, i);
    if (!(rsi < 25 || rsi > 75)) continue;
    const atr = atrAt(bars, i); if (atr <= 0) continue;
    if (volSurge(bars, i)) continue; // exhaustion filter

    const dir: "long" | "short" = rsi < 25 ? "long" : "short";
    const entry = b.c;
    const stopDist = atr * STOP_MULT;
    const targetDist = atr * targetMult;
    const short = dir === "short";
    const fillEntry = short ? entry - tickSlip : entry + tickSlip; // 1 tick adverse
    const stop = short ? entry + stopDist : entry - stopDist;
    const target = short ? entry - targetDist : entry + targetDist;
    const riskDollars = stopDist * inst.ptVal; // per-contract risk in $ (for R-multiple)
    const pnlAt = (px: number) => (short ? fillEntry - px : px - fillEntry) * inst.ptVal - inst.comm;

    // walk forward on 5m bars; stop-first if a bar spans both. Force close at session end (date change).
    let resolved = false;
    for (let j = i + 1; j < bars.length; j++) {
      if (bars[j].etDate !== b.etDate) {
        const pnl = pnlAt(bars[j - 1].c);
        trades.push({ date: b.etDate, ms: b.ms, dir, pnl$: pnl, rMult: pnl / riskDollars, win: pnl > 0, outcome: "eod" });
        openUntilMs = bars[j - 1].ms; resolved = true; break;
      }
      const stopHit = short ? bars[j].h >= stop : bars[j].l <= stop;
      const tgtHit = short ? bars[j].l <= target : bars[j].h >= target;
      if (stopHit) {
        const px = short ? stop + tickSlip : stop - tickSlip; const pnl = pnlAt(px);
        trades.push({ date: b.etDate, ms: b.ms, dir, pnl$: pnl, rMult: pnl / riskDollars, win: false, outcome: "stop" });
        openUntilMs = bars[j].ms; resolved = true; break;
      }
      if (tgtHit) {
        const pnl = pnlAt(target);
        trades.push({ date: b.etDate, ms: b.ms, dir, pnl$: pnl, rMult: pnl / riskDollars, win: pnl > 0, outcome: "target" });
        openUntilMs = bars[j].ms; resolved = true; break;
      }
    }
    if (!resolved) break; // ran out of data
  }
  return trades;
}

function stats(ts: Trade[]) {
  if (!ts.length) return null;
  const n = ts.length;
  const wins = ts.filter(t => t.win), losses = ts.filter(t => !t.win);
  const gW = wins.reduce((s, t) => s + t.pnl$, 0), gL = -losses.reduce((s, t) => s + t.pnl$, 0);
  const net = ts.reduce((s, t) => s + t.pnl$, 0);
  const expR = ts.reduce((s, t) => s + t.rMult, 0) / n;
  const avgWin = wins.length ? gW / wins.length : 0, avgLoss = losses.length ? gL / losses.length : 0;
  return { n, wr: wins.length / n, pf: gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0), net, avgTrade: net / n, expR, avgWin, avgLoss };
}
function fmt(s: ReturnType<typeof stats>) {
  return s ? `n=${String(s.n).padStart(4)} | win ${(s.wr * 100).toFixed(0)}% | avg/trade $${s.avgTrade >= 0 ? "+" : ""}${s.avgTrade.toFixed(2)} | expR ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(3)} | PF ${s.pf === Infinity ? "INF" : s.pf.toFixed(2)} | net $${s.net.toFixed(0)} | avgWin $${s.avgWin.toFixed(0)} avgLoss $${s.avgLoss.toFixed(0)}`
    : "n=0";
}

function run(key: keyof typeof INSTR) {
  const inst = INSTR[key];
  const bars = load5m(inst.file, inst.sessStart, inst.sessEnd);
  const dates = [...new Set(bars.map(b => b.etDate))].sort();
  const cut = dates[Math.floor(dates.length * 0.6)];
  const W = 118;
  console.log("\n" + "═".repeat(W));
  console.log(`  ${inst.label}  —  extreme_rsi_bounce target-width sweep  (stop fixed ${STOP_MULT}*ATR)`);
  console.log(`  ${bars.length} 5m bars, ${dates.length} sessions, ${dates[0]} → ${dates[dates.length - 1]} | TRAIN ≤ ${cut} < TEST`);
  console.log("═".repeat(W));
  console.log("  target".padEnd(10) + "| " + "FULL SAMPLE".padEnd(0));
  for (const m of TARGET_MULTS) {
    const all = backtest(inst, bars, m);
    const train = all.filter(t => t.date <= cut), test = all.filter(t => t.date > cut);
    const tag = m === 3.5 ? " (LIVE)" : "";
    console.log("  " + `${m}xATR${tag}`.padEnd(14));
    console.log("     ALL  : " + fmt(stats(all)));
    console.log("     TRAIN: " + fmt(stats(train)));
    console.log("     TEST : " + fmt(stats(test)));
  }
}

const which = (process.argv[2] || "GC,NQ,ES").split(",") as (keyof typeof INSTR)[];
for (const k of which) run(k);
console.log("\nEDGE TEST: a wider target only wins if avg/trade AND expR beat the 3.5xATR baseline in BOTH train and test.");
