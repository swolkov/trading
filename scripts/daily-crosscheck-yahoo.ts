/**
 * CROSS-CHECK: same daily mean-reversion rule, SECOND data source (read-only research)
 *
 * WHY: scripts/daily-swing-validation.ts (Databento continuous front-month, 2011-2026) says daily
 * GOLD fails this rule (PF 0.81, train half 0.24). An earlier session recorded daily gold as
 * strongly durable using YAHOO data over a longer window. Those cannot both describe the same
 * thing, and no script from that session survives, so this re-runs the IDENTICAL rule on Yahoo
 * data to find out whether the disagreement is the data source, the period, or the rule.
 *
 * Same rule as src/lib/daily-swing.ts and the Databento validation:
 *   long when RSI(14) < 30 and close > SMA200*0.92; exit RSI >= 50, 1.5*ATR stop, 30-day time stop.
 *   Realistic stop accounting (intraday trigger, gap-through fills at the open).
 *
 * Reported per 5-year block so a "works only in one regime" result cannot hide inside a total.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinanceClass = require("yahoo-finance2").default || require("yahoo-finance2");
const yf = new YahooFinanceClass({ suppressNotices: ["ripHistorical", "yahooSurvey"] });

const RSI_ENTRY = 30, RSI_EXIT = 50, SMA_FILTER = 0.92, TIME_STOP_DAYS = 30;
const COST_PCT = 0.0002;

interface Bar { t: number; o: number; h: number; l: number; c: number; }

function rsiSeries(c: number[], p = 14): (number | null)[] {
  const out: (number | null)[] = new Array(c.length).fill(null);
  if (c.length < p + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const ch = c[i] - c[i - 1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g / p, al = l / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    ag = (ag * (p - 1) + (ch > 0 ? ch : 0)) / p;
    al = (al * (p - 1) + (ch < 0 ? -ch : 0)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function atrSeries(b: Bar[], p = 14): (number | null)[] {
  const out: (number | null)[] = new Array(b.length).fill(null);
  if (b.length < p + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < b.length; i++) {
    const pc = b[i - 1].c;
    trs.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - pc), Math.abs(b[i].l - pc)));
  }
  let a = trs.slice(0, p).reduce((x, y) => x + y, 0) / p;
  out[p] = a;
  for (let i = p; i < trs.length; i++) { a = (a * (p - 1) + trs[i]) / p; out[i + 1] = a; }
  return out;
}

interface T { year: number; r: number; retPct: number; }

function backtest(bars: Bar[], stopMult: number | null): T[] {
  const closes = bars.map(b => b.c);
  const rsi = rsiSeries(closes), atr = atrSeries(bars);
  const trades: T[] = [];
  let open: { i: number; entry: number; stop: number | null; risk: number } | null = null;
  for (let i = 200; i < bars.length; i++) {
    const b = bars[i];
    if (open) {
      let reason: string | null = null, exitPx = b.c;
      if (open.stop != null) {
        if (b.o <= open.stop) { reason = "stop_gap"; exitPx = b.o; }
        else if (b.l <= open.stop) { reason = "stop"; exitPx = open.stop; }
      }
      if (!reason) {
        const r = rsi[i];
        if (r != null && r >= RSI_EXIT) { reason = "rsi"; exitPx = b.c; }
        else if ((b.t - bars[open.i].t) / 86400000 >= TIME_STOP_DAYS) { reason = "time"; exitPx = b.c; }
      }
      if (reason) {
        const net = exitPx - open.entry - open.entry * COST_PCT;
        trades.push({ year: new Date(bars[open.i].t).getUTCFullYear(), r: net / open.risk, retPct: net / open.entry });
        open = null;
      }
      continue;
    }
    const r = rsi[i], a = atr[i];
    if (r == null || a == null || a <= 0 || i + 1 < 200) continue;
    let sma = 0; for (let j = i - 199; j <= i; j++) sma += closes[j]; sma /= 200;
    if (r < RSI_ENTRY && b.c > sma * SMA_FILTER) {
      open = { i, entry: b.c, stop: stopMult == null ? null : b.c - stopMult * a, risk: 1.5 * a };
    }
  }
  return trades;
}

function st(ts: T[]) {
  if (!ts.length) return null;
  const w = ts.filter(t => t.r > 0), l = ts.filter(t => t.r <= 0);
  const gW = w.reduce((s, t) => s + t.r, 0), gL = -l.reduce((s, t) => s + t.r, 0);
  return { n: ts.length, wr: w.length / ts.length, pf: gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0), expR: ts.reduce((s, t) => s + t.r, 0) / ts.length };
}
const f = (s: ReturnType<typeof st>) => s ? `n=${String(s.n).padStart(3)} win ${(s.wr * 100).toFixed(0).padStart(3)}% PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2).padStart(5)} expR ${(s.expR >= 0 ? "+" : "") + s.expR.toFixed(3)}` : "n=  0";

async function fetchDaily(symbol: string, fromYear: number): Promise<Bar[]> {
  const rows: any[] = await yf.chart(symbol, { period1: `${fromYear}-01-01`, period2: new Date().toISOString().slice(0, 10), interval: "1d" })
    .then((r: any) => r?.quotes ?? []);
  return rows
    .filter(q => q?.close > 0 && q?.high > 0 && q?.low > 0 && q?.open > 0)
    .map(q => ({ t: new Date(q.date).getTime(), o: +q.open, h: +q.high, l: +q.low, c: +q.close }))
    .sort((a, b) => a.t - b.t);
}

const BLOCKS: [number, number][] = [[2000, 2005], [2006, 2010], [2011, 2015], [2016, 2020], [2021, 2026]];

async function main() {
  const targets = [
    { sym: "GC=F", label: "GOLD futures (Yahoo GC=F)" },
    { sym: "ES=F", label: "S&P futures (Yahoo ES=F)" },
    { sym: "^GSPC", label: "S&P 500 index (Yahoo ^GSPC)" },
    { sym: "SPY", label: "SPY ETF (Yahoo)" },
    { sym: "QQQ", label: "QQQ ETF (Yahoo)" },
  ];
  console.log("CROSS-CHECK — identical daily mean-reversion rule, Yahoo data, realistic stop accounting");
  console.log("Rule: long RSI(14)<30 & close>SMA200*0.92; exit RSI>=50 / 1.5xATR stop / 30-day time stop.\n");
  for (const t of targets) {
    let bars: Bar[] = [];
    try { bars = await fetchDaily(t.sym, 2000); } catch (e) { console.log(`${t.label}: FETCH FAILED — ${String(e).slice(0, 90)}`); continue; }
    if (bars.length < 400) { console.log(`${t.label}: only ${bars.length} bars — skipped`); continue; }
    const from = new Date(bars[0].t).toISOString().slice(0, 10), to = new Date(bars[bars.length - 1].t).toISOString().slice(0, 10);
    console.log("═".repeat(120));
    console.log(`  ${t.label}  —  ${bars.length} daily bars, ${from} → ${to}`);
    console.log("═".repeat(120));
    for (const stop of [1.5, null] as (number | null)[]) {
      const all = backtest(bars, stop);
      const half = Math.floor(bars.length * 0.6);
      // split by date rather than trade index so halves match the other script's convention
      const cutTime = bars[half].t;
      const tr = all.filter(x => new Date(`${x.year}-12-31`).getTime() <= cutTime + 365 * 86400000 && x.year <= new Date(cutTime).getUTCFullYear());
      const te = all.filter(x => x.year > new Date(cutTime).getUTCFullYear());
      console.log(`  stop ${stop === null ? "none " : stop + "x  "}| FULL ${f(st(all))} | TRAIN ${f(st(tr))} | TEST ${f(st(te))}` +
        (st(tr) && st(te) && st(tr)!.expR > 0 && st(te)!.expR > 0 ? "   <<< BOTH HALVES POSITIVE" : ""));
      const cells = BLOCKS.map(([a, b]) => `${a}-${String(b).slice(2)}: ${f(st(all.filter(x => x.year >= a && x.year <= b)))}`);
      for (const c of cells) console.log("           " + c);
    }
  }
}
main();
