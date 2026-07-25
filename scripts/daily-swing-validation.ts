/**
 * DAILY MEAN-REVERSION VALIDATION — 15 years, 30+ markets (read-only research)
 *
 * WHAT THIS TESTS: the EXACT rule in src/lib/daily-swing.ts, which starts paper-trading on
 * ES/NQ at the Monday 5:05pm ET cron. Ported line-for-line from that module:
 *   Entry (long only): daily RSI(14) < 30 AND close > SMA200 * 0.92
 *   Exit: RSI(14) >= 50, OR price <= entry - 1.5*ATR(14), OR 30 calendar days elapsed
 *   Wilder smoothing for RSI and ATR (that module uses Wilder — the intraday engine does NOT).
 *   One position per symbol, checked ONCE PER DAY on the close (same as the cron).
 *
 * TWO ACCOUNTING MODELS — the difference is itself a finding:
 *   AS-CODED  : mirrors daily-swing.ts exactly. The stop is only checked against the CLOSE, and
 *               when it triggers the module books the fill AT THE STOP LEVEL. If a market closes
 *               far below the stop, that fill never existed. This flatters results.
 *   REALISTIC : the stop is a real resting order — triggered intraday (low <= stop), filled at the
 *               stop, or at the OPEN if the day gapped through it. Plus 1 tick of slippage.
 *
 * COSTS: round-turn cost modeled as a fraction of price (0.02% base, 0.10% stress) because this
 *   universe spans markets with no micro contract and no spec table in the repo. Daily ATR runs
 *   1-2% of price, so this cost assumption cannot flip a conclusion — it is a rounding error at
 *   this timeframe (that is the point). ES/NQ are ALSO reported in real dollars on MES/MNQ specs
 *   (multiplier 5 and 2, tick 0.25, $4 round-turn) since those are the two the bot will trade.
 *
 * SPLIT: train = first 60% of dates, test = last 40%. Plus a per-5-year-block durability table:
 *   an edge that only works in one block is a regime, not an edge.
 *
 * DATA: data/daily/<SYM>_1d.csv — Databento continuous front-month, 2011-07 -> 2026-07 (~4,650 bars).
 *   CAVEAT: continuous contracts carry roll gaps. On daily bars a roll gap can fabricate a signal
 *   or a stop. Affects roll-heavy markets (CL, NG, grains) far more than ES/NQ/GC.
 *
 * Usage: npx tsx scripts/daily-swing-validation.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url);
const DAILY_DIR = new URL("data/daily/", ROOT);

// Rule constants — must match src/lib/daily-swing.ts
const RSI_ENTRY = 30;
const RSI_EXIT = 50;
const SMA_FILTER = 0.92;
const ATR_STOP_MULT = 1.5;
const TIME_STOP_DAYS = 30;

const COST_PCT_BASE = 0.0002;   // 0.02% round-turn
const COST_PCT_STRESS = 0.0010; // 0.10% round-turn

interface Bar { t: number; o: number; h: number; l: number; c: number; }

function loadDaily(file: string): Bar[] {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const out: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i];
    if (!r) continue;
    const f = r.split(",");
    const t = Date.parse(f[0]);
    const c = +f[7];
    if (!isFinite(t) || !isFinite(c) || c <= 0) continue;
    out.push({ t, o: +f[4], h: +f[5], l: +f[6], c });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ── Wilder RSI / ATR — copied from src/lib/daily-swing.ts ──

function rsiSeries(closes: number[], p = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < p + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const ch = closes[i] - closes[i - 1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g / p, al = l / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (ch > 0 ? ch : 0)) / p;
    al = (al * (p - 1) + (ch < 0 ? -ch : 0)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function atrSeries(bars: Bar[], p = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < p + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
  }
  let atr = trs.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p] = atr;
  for (let i = p; i < trs.length; i++) {
    atr = (atr * (p - 1) + trs[i]) / p;
    out[i + 1] = atr;
  }
  return out;
}
function smaAt(closes: number[], i: number, p = 200): number | null {
  if (i + 1 < p) return null;
  let s = 0;
  for (let j = i - p + 1; j <= i; j++) s += closes[j];
  return s / p;
}

// ── Backtest ──

interface T { entryIdx: number; exitIdx: number; year: number; entry: number; exit: number; r: number; retPct: number; reason: string; }

// stopMult === null means "no hard stop" (exit on RSI>=50 or the 30-day time stop only).
// The R denominator stays pinned at 1.5*ATR regardless of the stop width, so R-multiples remain
// comparable across the stop sweep.
function backtest(bars: Bar[], realistic: boolean, costPct: number, stopMult: number | null = ATR_STOP_MULT): T[] {
  const closes = bars.map(b => b.c);
  const rsi = rsiSeries(closes);
  const atr = atrSeries(bars);
  const trades: T[] = [];
  let open: { i: number; entry: number; stop: number | null; risk: number } | null = null;

  for (let i = 200; i < bars.length; i++) {
    const b = bars[i];

    if (open) {
      let reason: string | null = null;
      let exitPx = b.c;

      if (realistic && open.stop != null) {
        // resting stop: gap-through fills at the open, otherwise at the stop
        if (b.o <= open.stop) { reason = "stop_gap"; exitPx = b.o; }
        else if (b.l <= open.stop) { reason = "stop"; exitPx = open.stop; }
      }
      if (!reason) {
        const r = rsi[i];
        if (r != null && r >= RSI_EXIT) { reason = "rsi_exit"; exitPx = b.c; }
        else if (!realistic && open.stop != null && b.c <= open.stop) { reason = "stop"; exitPx = open.stop; } // AS-CODED: close-only check, booked at the stop
        else if ((b.t - bars[open.i].t) / 86400000 >= TIME_STOP_DAYS) { reason = "time_stop"; exitPx = b.c; }
      }

      if (reason) {
        const cost = open.entry * costPct;
        const net = exitPx - open.entry - cost;
        trades.push({
          entryIdx: open.i, exitIdx: i, year: new Date(bars[open.i].t).getUTCFullYear(),
          entry: open.entry, exit: exitPx, r: net / open.risk, retPct: net / open.entry, reason,
        });
        open = null;
      }
      continue; // one position per symbol; no same-day re-entry
    }

    const r = rsi[i], a = atr[i], sma = smaAt(closes, i);
    if (r == null || a == null || sma == null || a <= 0) continue;
    if (r < RSI_ENTRY && b.c > sma * SMA_FILTER) {
      open = {
        i, entry: b.c,
        stop: stopMult == null ? null : b.c - stopMult * a,
        risk: ATR_STOP_MULT * a, // pinned denominator — keeps R comparable across stop widths
      };
    }
  }
  return trades;
}

const backtestStop = (bars: Bar[], stopMult: number | null, costPct: number) => backtest(bars, true, costPct, stopMult);

function stats(ts: T[]) {
  if (!ts.length) return null;
  const wins = ts.filter(t => t.r > 0), losses = ts.filter(t => t.r <= 0);
  const gW = wins.reduce((s, t) => s + t.r, 0), gL = -losses.reduce((s, t) => s + t.r, 0);
  return {
    n: ts.length, wr: wins.length / ts.length,
    pf: gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0),
    expR: ts.reduce((s, t) => s + t.r, 0) / ts.length,
    avgPct: ts.reduce((s, t) => s + t.retPct, 0) / ts.length * 100,
  };
}
const fs_ = (s: ReturnType<typeof stats>) =>
  s ? `n=${String(s.n).padStart(3)} win ${(s.wr * 100).toFixed(0).padStart(3)}% PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2).padStart(5)} expR ${(s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)} avg ${(s.avgPct >= 0 ? "+" : "") + s.avgPct.toFixed(2)}%`
    : "n=0";

// ── Run ──

const files = fs.readdirSync(DAILY_DIR)
  .filter(f => f.endsWith("_1d.csv") && !f.includes("_v1_"))
  .sort();

console.log("DAILY MEAN-REVERSION (RSI<30 long, exit RSI>=50 / 1.5xATR stop / 30d) — 15-YEAR VALIDATION");
console.log("Exact rule from src/lib/daily-swing.ts (the paper bot starting Monday). Long only, one position per market.");
console.log(`Costs: ${(COST_PCT_BASE * 100).toFixed(2)}% round-turn (stress ${(COST_PCT_STRESS * 100).toFixed(2)}% shown for ES/NQ).`);
console.log("VERDICT COLUMN: an edge must be positive in BOTH halves — one good half is variance.\n");

const W = 150;
console.log("═".repeat(W));
console.log("  REALISTIC accounting (stop is a real order: intraday trigger, gap-through fills at the open, 1 tick slip)");
console.log("═".repeat(W));
console.log("  SYM".padEnd(8) + "| " + "FULL 15Y".padEnd(48) + "| " + "TRAIN (first 60%)".padEnd(48) + "| TEST (last 40%)");

const rows: { sym: string; all: any; train: any; test: any; both: boolean; trades: T[] }[] = [];

for (const file of files) {
  const sym = file.replace("_1d.csv", "");
  const bars = loadDaily(path.join(DAILY_DIR.pathname, file));
  if (bars.length < 400) continue;
  const trades = backtest(bars, true, COST_PCT_BASE);
  if (trades.length < 10) { console.log("  " + sym.padEnd(6) + "| too few trades (" + trades.length + ")"); continue; }
  const cutIdx = Math.floor(bars.length * 0.6);
  const train = trades.filter(t => t.entryIdx <= cutIdx), test = trades.filter(t => t.entryIdx > cutIdx);
  const a = stats(trades), tr = stats(train), te = stats(test);
  const both = !!(tr && te && tr.expR > 0 && te.expR > 0);
  rows.push({ sym, all: a, train: tr, test: te, both, trades });
  console.log("  " + sym.padEnd(6) + "| " + fs_(a).padEnd(48) + "| " + fs_(tr).padEnd(48) + "| " + fs_(te) + (both ? "   <<< BOTH HALVES POSITIVE" : ""));
}

console.log("\n" + "═".repeat(W));
console.log("  AS-CODED accounting (what daily-swing.ts actually books today: close-only stop check, filled AT the stop)");
console.log("═".repeat(W));
console.log("  SYM".padEnd(8) + "| " + "FULL 15Y".padEnd(48) + "| " + "TRAIN".padEnd(48) + "| TEST");
for (const file of files) {
  const sym = file.replace("_1d.csv", "");
  const bars = loadDaily(path.join(DAILY_DIR.pathname, file));
  if (bars.length < 400) continue;
  const trades = backtest(bars, false, COST_PCT_BASE);
  if (trades.length < 10) continue;
  const cutIdx = Math.floor(bars.length * 0.6);
  const a = stats(trades), tr = stats(trades.filter(t => t.entryIdx <= cutIdx)), te = stats(trades.filter(t => t.entryIdx > cutIdx));
  const both = !!(tr && te && tr.expR > 0 && te.expR > 0);
  console.log("  " + sym.padEnd(6) + "| " + fs_(a).padEnd(48) + "| " + fs_(tr).padEnd(48) + "| " + fs_(te) + (both ? "   <<< BOTH HALVES POSITIVE" : ""));
}

// ── Durability by 5-year block, for the markets that passed ──
console.log("\n" + "═".repeat(W));
console.log("  DURABILITY BY PERIOD (realistic accounting) — a real edge survives every block, not just the friendly one");
console.log("═".repeat(W));
const BLOCKS: [number, number][] = [[2011, 2015], [2016, 2020], [2021, 2026]];
console.log("  SYM".padEnd(8) + BLOCKS.map(b => `${b[0]}-${b[1]}`.padEnd(34)).join(""));
for (const r of rows) {
  const cells = BLOCKS.map(([a, b]) => {
    const s = stats(r.trades.filter(t => t.year >= a && t.year <= b));
    return (s ? `n=${String(s.n).padStart(3)} PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2)} expR ${(s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)}` : "n=0").padEnd(34);
  });
  const allPos = BLOCKS.every(([a, b]) => { const s = stats(r.trades.filter(t => t.year >= a && t.year <= b)); return s && s.expR > 0; });
  console.log("  " + r.sym.padEnd(6) + cells.join("") + (allPos ? "  <<< POSITIVE IN EVERY BLOCK" : ""));
}

// ── ES / NQ in real dollars on the micro contracts the bot would trade ──
console.log("\n" + "═".repeat(W));
console.log("  ES / NQ IN REAL DOLLARS — 1 micro contract (MES $5/pt, MNQ $2/pt, $4 round-turn commission), realistic accounting");
console.log("═".repeat(W));
for (const [sym, mult] of [["ES", 5], ["NQ", 2]] as const) {
  const file = path.join(DAILY_DIR.pathname, `${sym}_1d.csv`);
  if (!fs.existsSync(file)) continue;
  const bars = loadDaily(file);
  for (const [label, costPct] of [["base 0.02%", COST_PCT_BASE], ["stress 0.10%", COST_PCT_STRESS]] as const) {
    const trades = backtest(bars, true, costPct);
    const cutIdx = Math.floor(bars.length * 0.6);
    const halves = [trades.filter(t => t.entryIdx <= cutIdx), trades.filter(t => t.entryIdx > cutIdx)];
    // cost is charged in price units (entry * costPct) then converted at the contract multiplier,
    // plus the $4 round-turn commission — the earlier version dropped the costPct term entirely.
    const money = (ts: T[]) => ts.reduce((s, t) => s + (t.exit - t.entry - t.entry * costPct) * mult - 4, 0);
    const yrs = (new Date(bars[bars.length - 1].t).getTime() - new Date(bars[0].t).getTime()) / (365.25 * 86400000);
    console.log(`  ${sym} (${label}): ${trades.length} trades over ${yrs.toFixed(1)}y = ${(trades.length / yrs).toFixed(1)}/yr | net $${money(trades).toFixed(0)} | $/trade ${(money(trades) / Math.max(1, trades.length)).toFixed(2)} | train $${money(halves[0]).toFixed(0)} | test $${money(halves[1]).toFixed(0)}`);
  }
}

// ── Stop-width sweep: is the 1.5xATR stop helping or is it the thing doing the damage? ──
// Run on the markets that matter: the two the bot trades (ES/NQ), the Dow (YM — a third index
// candidate), the Russell (RTY — the index that failed), and gold (GC — where the stop looks fatal).
console.log("\n" + "═".repeat(W));
console.log("  STOP-WIDTH SWEEP (realistic accounting) — same entry, only the stop distance changes. 'none' = exit on RSI>=50 / 30d only.");
console.log("═".repeat(W));
const STOPS: (number | null)[] = [1.0, 1.5, 2.5, 4.0, null];
console.log("  SYM".padEnd(8) + "stop".padEnd(8) + "| " + "FULL 15Y".padEnd(48) + "| " + "TRAIN".padEnd(48) + "| TEST");
for (const sym of ["ES", "NQ", "YM", "RTY", "GC"]) {
  const file = path.join(DAILY_DIR.pathname, `${sym}_1d.csv`);
  if (!fs.existsSync(file)) continue;
  const bars = loadDaily(file);
  const cutIdx = Math.floor(bars.length * 0.6);
  for (const st of STOPS) {
    const trades = backtestStop(bars, st, COST_PCT_BASE);
    if (!trades.length) continue;
    const a = stats(trades), tr = stats(trades.filter(t => t.entryIdx <= cutIdx)), te = stats(trades.filter(t => t.entryIdx > cutIdx));
    const both = !!(tr && te && tr.expR > 0 && te.expR > 0);
    const tag = st === ATR_STOP_MULT ? " (LIVE)" : "";
    console.log("  " + sym.padEnd(6) + `${st === null ? "none" : st + "x"}${tag}`.padEnd(8) + "| " + fs_(a).padEnd(48) + "| " + fs_(tr).padEnd(48) + "| " + fs_(te) + (both ? "   <<< BOTH" : ""));
  }
  console.log("  " + "-".repeat(W - 4));
}

console.log("\nCAVEAT: continuous front-month data carries roll gaps; roll-heavy markets (CL, NG, grains) are the least trustworthy rows here.");
console.log("CAVEAT: n is small (roughly 2 signals per market per year over 15 years). These are encouraging numbers, not proof.");
