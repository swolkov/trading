/**
 * TREND-FOLLOWING PORTFOLIO HARNESS — timeframe, stop width and universe are all variables.
 *
 * WHY IT REPLACES scripts/daily-trend-portfolio.ts. That script hardcoded DAILY bars and a 2xATR
 * stop, then reported the resulting $1,622-per-MGC-position as if it were a property of
 * trend-following. It is not — it is a property of those two choices, and both were assumptions I
 * never tested. Two facts the earlier run had in front of it and ignored:
 *   1. Its own exit table: 57% of trades exited at the stop for -1,252R while channel exits made
 *      +1,355R. The stop was the single largest loss source and was never varied.
 *   2. The edge factory's positive signal was on HOURLY gold, not daily. Hourly ATR is ~1/6 of
 *      daily ATR, and ATR is exactly what sets dollar risk per contract: a 2xATR stop on MGC is
 *      $260 hourly vs $1,582 daily. The "unsizable at $4,368" conclusion tested the wrong timeframe.
 *
 * So nothing is fixed here. TF picks the bar size, STOP_ATR the stop (0 = channel exit only, the
 * classic Donchian form that needs no stop at all), SYMS the universe, and ACCOUNT_SIM asks what
 * the configuration actually does to a real balance at minimum contract size.
 *
 * METHOD (unchanged, and deliberately conservative):
 *   • Donchian breakout: close beyond the prior N-bar high/low. ONE parameter set for every market.
 *   • Entry at the NEXT bar's open, never the signal bar's close.
 *   • Exit: opposite M-bar channel, and the ATR stop when one is configured. The stop is checked
 *     against the bar's low/high FIRST, so a bar touching both resolves against us.
 *   • Difference back-adjustment across contract rolls. Databento continuous v.0 SPLICES without
 *     back-adjusting; replaying multi-bar holds on the raw series either books the splice as fake
 *     P&L or terminates every position at a roll. The daily script originally did the latter and
 *     produced a textbook artifact: 60% of trades "exited at a roll" at +0.74R on a 70% win rate,
 *     because only trades that had NOT yet stopped out could survive to one. That is survivorship.
 *   • Costs charged as a fraction of ATR per round turn, so no per-market tick values are invented.
 *   • Trades still open when data ends are DROPPED — an unrealised winner must not flatter the book.
 *
 * NOT PROOF. Continuous-contract history, no margin model, no real fills. Writes no flags.
 *
 * Usage: TF=60 npx tsx scripts/trend-portfolio.ts 100 50
 *        TF=60 STOP_ATR=0 ACCOUNT_SIM=4368 npx tsx scripts/trend-portfolio.ts 100 50
 */
import fs from "node:fs";
import path from "node:path";
import { aggregateBars, loadDatabentoCsv } from "../src/lib/edge-factory/data";

const ENTRY_N = Number(process.argv[2] || "") || 55;
const EXIT_M = Number(process.argv[3] || "") || 20;
/** 0 disables the hard stop entirely — the opposite channel becomes the only exit. */
const STOP_ATR = process.env.STOP_ATR !== undefined ? Number(process.env.STOP_ATR) : 2;
const COST_ATR = process.env.COST_ATR !== undefined ? Number(process.env.COST_ATR) : 0.05;
/** Bar size in minutes. Unset = daily files in data/daily (the widest universe). */
const TF = Number(process.env.TF || "") || 0;
const ATR_PERIOD = 20;
const SIDE = (process.env.SIDE === "long" || process.env.SIDE === "short") ? process.env.SIDE : null;

/** Micro contract multipliers, read from the repo's own table (src/lib/tradovate.ts) — not invented. */
const MICRO: Record<string, { micro: string; pv: number }> = {
  ES: { micro: "MES", pv: 5 }, NQ: { micro: "MNQ", pv: 2 }, GC: { micro: "MGC", pv: 10 },
  YM: { micro: "MYM", pv: 0.5 }, RTY: { micro: "M2K", pv: 5 },
  CL: { micro: "MCL", pv: 100 }, HG: { micro: "MHG", pv: 2500 }, SI: { micro: "SIL", pv: 1000 },
  // CME micro FX: dollar value of a 1.00 price move = contract notional in the foreign currency.
  // M6E 12,500 EUR (0.0001 tick = $1.25) · M6A 10,000 AUD ($1.00) · M6B 6,250 GBP ($0.625).
  // M6J is 1,250,000 JPY quoted in USD-per-JPY (~0.0067), so 0.000001 tick = $1.25. It is the
  // MICRO — the full-size 6J is 12,500,000 JPY, a 10x difference worth getting right, since this
  // number is what ACCOUNT_SIM converts every R into.
  "6E": { micro: "M6E", pv: 12500 }, "6A": { micro: "M6A", pv: 10000 },
  "6B": { micro: "M6B", pv: 6250 }, "6J": { micro: "M6J", pv: 1250000 },
};
/**
 * Intraday universe. Prefers data/tf15y (2011-2026, pulled at $0 by dbn-fetch-gold-history.ts)
 * and falls back to the older 3-year files. Discovered from disk rather than hardcoded so adding a
 * market is a download, not a code change — and so a market whose download failed is simply absent
 * instead of silently loading a stale short file under a "15-year" label.
 */
function intradayFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const legacy: Record<string, string> = {
    ES: "data/ES_1m.csv", NQ: "data/NQ_1m.csv", GC: "data/gold3y/GC_1m.csv", CL: "data/CL_1m.csv",
    HG: "data/HG_1m.csv", NG: "data/NG_1m.csv", SI: "data/SI_1m.csv", PL: "data/PL_1m.csv", PA: "data/PA_1m.csv",
  };
  const dir = path.resolve("data/tf15y");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(.+)_1m\.csv$/);
      if (m && fs.statSync(path.join(dir, f)).size > 0) out[m[1]] = `data/tf15y/${f}`;
    }
  }
  for (const [sym, file] of Object.entries(legacy)) if (!out[sym] && fs.existsSync(path.resolve(file))) out[sym] = file;
  return out;
}
const INTRADAY_FILES: Record<string, string> = intradayFiles();

interface Bar { t: number; o: number; h: number; l: number; c: number; id: string; }
interface Trade { sym: string; dir: "long" | "short"; entryT: number; exitT: number; r: number; reason: string; riskPoints: number; }

/** Difference ("Panama") back-adjustment: each roll's splice is removed, every difference preserved. */
function backAdjust(raw: Bar[]): Bar[] {
  const out: Bar[] = [];
  let offset = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (i > 0 && b.id !== raw[i - 1].id) offset = out[i - 1].c - b.o;
    out.push({ t: b.t, o: b.o + offset, h: b.h + offset, l: b.l + offset, c: b.c + offset, id: b.id });
  }
  const firstUsable = out.findIndex((b) => b.l > 0);
  return firstUsable > 0 ? out.slice(firstUsable) : out;
}

function universe(): { sym: string; bars: Bar[] }[] {
  const only = (process.env.SYMS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const out: { sym: string; bars: Bar[] }[] = [];
  if (TF) {
    for (const [sym, file] of Object.entries(INTRADAY_FILES)) {
      if (only.length && !only.includes(sym)) continue;
      const full = path.resolve(file);
      if (!fs.existsSync(full)) continue;
      const agg = aggregateBars(loadDatabentoCsv(full), TF);
      out.push({ sym, bars: backAdjust(agg.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, id: b.instrumentId }))) });
    }
    return out;
  }
  const dir = path.resolve("data/daily");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith("_1d.csv") && !f.includes("_v1_")).sort()) {
    const sym = f.replace("_1d.csv", "");
    if (only.length && !only.includes(sym)) continue;
    const lines = fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n");
    const raw: Bar[] = [];
    for (let i = 1; i < lines.length; i++) {
      const x = lines[i].split(",");
      const t = Date.parse(x[0]), o = +x[4], h = +x[5], l = +x[6], c = +x[7];
      if (!isFinite(t) || !(c > 0) || !(o > 0) || !(h >= l)) continue;
      raw.push({ t, o, h, l, c, id: x[3] });
    }
    if (raw.length > 400) out.push({ sym, bars: backAdjust(raw) });
  }
  return out;
}

function atrSeries(bars: Bar[], period: number): number[] {
  const out = new Array(bars.length).fill(0);
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(p ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : b.h - b.l);
  }
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function backtest(sym: string, bars: Bar[]): Trade[] {
  const atr = atrSeries(bars, ATR_PERIOD);
  const trades: Trade[] = [];
  let i = Math.max(ENTRY_N, EXIT_M, ATR_PERIOD) + 2;
  while (i < bars.length - 1) {
    const a = atr[i - 1];
    if (!(a > 0)) { i++; continue; }
    let hi = -Infinity, lo = Infinity;
    for (let k = i - ENTRY_N; k < i; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
    let dir: "long" | "short" | null = bars[i].c > hi ? "long" : bars[i].c < lo ? "short" : null;
    // SIDE isolates one direction. Across every test run so far the long side is significantly
    // positive (t~3) and the short side significantly negative — over 2011-2026, when most of these
    // markets rose. That is the signature of BETA, not alpha, so long-only has to be benchmarked
    // against simply holding before it can be called an edge.
    if (SIDE && dir !== SIDE) dir = null;
    if (!dir) { i++; continue; }

    const entryBar = bars[i + 1];
    const entry = entryBar.o;
    // With no hard stop the risk unit is still 1 ATR-based notional, so R stays comparable across
    // configurations; only the exit rule changes. Otherwise "no stop" would silently redefine R.
    const risk = (STOP_ATR > 0 ? STOP_ATR : 2) * a;
    const stop = dir === "long" ? entry - risk : entry + risk;
    let exitPx = entryBar.c, exitIdx = i + 1, reason = "unclosed";

    for (let j = i + 1; j < bars.length; j++) {
      const b = bars[j];
      if (STOP_ATR > 0) {
        const hitStop = dir === "long" ? b.l <= stop : b.h >= stop;
        if (hitStop) { exitPx = stop; exitIdx = j; reason = "stop"; break; }
      }
      if (j > i + 1) {
        let ehi = -Infinity, elo = Infinity;
        for (let k = Math.max(0, j - EXIT_M); k < j; k++) { ehi = Math.max(ehi, bars[k].h); elo = Math.min(elo, bars[k].l); }
        if (dir === "long" ? b.c < elo : b.c > ehi) {
          const nxt = bars[j + 1];
          if (!nxt) { exitPx = b.c; exitIdx = j; reason = "channel_eod"; break; }
          exitPx = nxt.o; exitIdx = j + 1; reason = "channel"; break;
        }
      }
      exitPx = b.c; exitIdx = j;
    }
    if (reason === "unclosed") break;
    const move = dir === "long" ? exitPx - entry : entry - exitPx;
    trades.push({ sym, dir, entryT: entryBar.t, exitT: bars[exitIdx].t, r: (move - COST_ATR * a) / risk, reason, riskPoints: risk });
    i = Math.max(i + 1, exitIdx);
  }
  return trades;
}

function stats(rs: number[]) {
  if (!rs.length) return null;
  const n = rs.length, mean = rs.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(n > 1 ? rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0);
  const gp = rs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const gl = Math.abs(rs.filter((v) => v < 0).reduce((s, v) => s + v, 0));
  let cum = 0, peak = 0, dd = 0;
  for (const v of rs) { cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, pf: gl > 0 ? gp / gl : Infinity, wr: rs.filter((v) => v > 0).length / n, net: cum, dd };
}
const fmt = (s: ReturnType<typeof stats>) => s
  ? `n=${String(s.n).padStart(5)} exp=${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(3)}R PF=${(s.pf === Infinity ? 99 : s.pf).toFixed(2)} win=${(s.wr * 100).toFixed(0)}% net=${s.net >= 0 ? "+" : ""}${s.net.toFixed(0)}R maxDD=${s.dd.toFixed(0)}R t=${s.t.toFixed(2)}`
  : "n=0";

// ── run ────────────────────────────────────────────────────────────────────────────────────────
const markets = universe();
const all: Trade[] = [];
const perMarket: { sym: string; s: ReturnType<typeof stats> }[] = [];
for (const { sym, bars } of markets) {
  const t = backtest(sym, bars);
  if (!t.length) continue;
  all.push(...t);
  perMarket.push({ sym, s: stats(t.map((x) => x.r)) });
}
all.sort((a, b) => a.exitT - b.exitT);

const label = TF ? `${TF}-minute` : "daily";
console.log(`\nTREND PORTFOLIO — Donchian ${ENTRY_N}/${EXIT_M} on ${label} bars, stop ${STOP_ATR > 0 ? `${STOP_ATR}xATR` : "NONE (channel exit only)"}, cost ${COST_ATR} ATR`);
console.log(`${perMarket.length} markets, ${all.length ? new Date(all[0].entryT).toISOString().slice(0, 10) : "-"} → ${all.length ? new Date(all.at(-1)!.exitT).toISOString().slice(0, 10) : "-"}\n`);
console.log(`  ALL      ${fmt(stats(all.map((x) => x.r)))}`);
const half = Math.floor(all.length / 2);
console.log(`  1st half ${fmt(stats(all.slice(0, half).map((x) => x.r)))}`);
console.log(`  2nd half ${fmt(stats(all.slice(half).map((x) => x.r)))}`);

if (process.env.DETAIL) {
  console.log("\n  BY MARKET");
  for (const { sym, s } of perMarket.sort((a, b) => (b.s?.net ?? 0) - (a.s?.net ?? 0))) console.log(`  ${sym.padEnd(5)} ${fmt(s)}`);
  console.log(`  ${perMarket.filter((m) => (m.s?.net ?? 0) > 0).length}/${perMarket.length} markets net-positive`);
  console.log("\n  BY DIRECTION — a long-only result in a bull market is regime, not edge");
  for (const d of ["long", "short"] as const) {
    const rs = all.filter((x) => x.dir === d).map((x) => x.r);
    if (rs.length) console.log(`  ${d.padEnd(12)} ${fmt(stats(rs))}`);
  }
  console.log("\n  BY EXIT REASON");
  for (const r of ["stop", "channel", "channel_eod"]) {
    const rs = all.filter((x) => x.reason === r).map((x) => x.r);
    if (rs.length) console.log(`  ${r.padEnd(12)} ${fmt(stats(rs))}`);
  }
}

if (process.env.ACCOUNT_SIM) {
  const START = Number(process.env.ACCOUNT_SIM) || 4368;
  const sim = all.filter((t) => MICRO[t.sym]);
  let eq = START, peak = START, worst = START, maxDD = 0, ruinAt = "";
  for (const t of sim) {
    eq += t.r * (t.riskPoints * MICRO[t.sym].pv);   // one micro contract per signal
    peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); worst = Math.min(worst, eq);
    if (eq <= 0 && !ruinAt) ruinAt = new Date(t.exitT).toISOString().slice(0, 10);
  }
  const risks = sim.map((t) => t.riskPoints * MICRO[t.sym].pv).sort((a, b) => a - b);
  console.log(`\n  ACCOUNT SIM — 1 micro contract per signal, ${[...new Set(sim.map((t) => MICRO[t.sym].micro))].join("/")}`);
  console.log(`  $${START} → $${eq.toFixed(0)} over ${sim.length} trades | worst $${worst.toFixed(0)} | maxDD $${maxDD.toFixed(0)} (${(100 * maxDD / START).toFixed(0)}% of start)`);
  console.log(`  median risk per position $${risks.length ? risks[Math.floor(risks.length / 2)].toFixed(0) : 0} (${risks.length ? (100 * risks[Math.floor(risks.length / 2)] / START).toFixed(1) : 0}% of account)`);
  console.log(ruinAt ? `  >>> ACCOUNT HITS ZERO ${ruinAt}` : `  >>> survives`);
}
console.log(`\nResearch only — continuous-contract history, no margin model, no real fills.\n`);
