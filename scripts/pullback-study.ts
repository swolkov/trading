/**
 * PULLBACK STUDY — Spencer's own entry, 2011–2026, 1-minute ES / NQ / GC data we own.
 *
 * His words (Sep 22 2026): "buy high low or anticipate and hold a little or low high etc, based on vwap and orb,
 * 20 contracts micro". The ORB study (Sep 19) already killed breakout entries (0/192); this tests the different
 * thing he actually does: the opening range and VWAP set the SIDE, and he buys the HIGHER LOW (sells the LOWER
 * HIGH) of the pullback, not the break. Same bar as every study here: try to disprove it.
 *
 * PRE-REGISTERED — written before any result was seen; nothing below was tuned.
 *   Levels   exactly the trading-room Pine study: 15-minute opening range from 09:30 ET (indices) / 08:20 ET
 *            (gold); VWAP = ta.vwap(hlc3), anchored at the 18:00 ET Globex open (TradingView's default session).
 *   Side     LONG bias once a bar (of the study's timeframe) closes above the OR high AND above VWAP.
 *            A later bar closing below VWAP kills the bias for the day. Short = the mirror.
 *   Higher   after the bias, a PULLBACK starts on the first bar whose low undercuts the prior bar's low; its
 *   low      low is the running lowest low of the pullback. It stays valid while every close holds above VWAP.
 *            TRIGGER = a bar closing above the prior bar's high → enter at the next 1-minute open, 1 tick worse.
 *            Stop = pullback low − 1 tick. A later pullback must hold ABOVE the previous one's low (a higher low);
 *            if it undercuts it, the up-structure is broken and there are no more longs that day.
 *   Frames   5-minute bars ("hold a little") and 1-minute bars ("anticipate") — both run, both reported.
 *   Size     his: 20 micros, cut down so the stop risks ≤ $350 (never up); skip if 1 contract risks > $350.
 *   Exits    (a) 2R bracket — the replay's rule: everything out at 2× the risk or the stop;
 *            (b) template  — half off at 1R, stop to breakeven, rest out at 3R or the stop.
 *            Flat 5 minutes before the session ends (indices 15:55, gold 13:25). Entries stop 60 min before.
 *   Limits   one position at a time, at most 2 trades per day per instrument.
 *   Costs    $2.06 per contract round trip (MEASURED on his account, Sep 18); entry 1 tick adverse; stops 1 tick
 *            adverse; a bar opening through the stop fills at its open − 1 tick; a target fills only if a bar trades
 *            THROUGH it; a bar touching both counts as the stop.
 *   Verdict  a cell SURVIVES only with n ≥ 100, average R > 0 in BOTH 2011–2019 and 2020–2026, and t ≥ 2 overall.
 *            12 cells (3 markets × 2 frames × 2 exits): one survivor by luck alone is ~a coin flip, so a lone
 *            survivor next to eleven dead siblings is reported as that.
 *
 * Rolls: the archive is the unadjusted front contract. VWAP resets when the contract changes; a day whose
 * contract changes inside the session is skipped. Every trade closes the day it opens.
 *
 * Usage: npx tsx scripts/pullback-study.ts [ES,NQ,GC]
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const DATA = process.env.TF15Y_DIR ?? "data/tf15y";
const INSTR: Record<string, { ptVal: number; tick: number; open: number; close: number; micro: string }> = {
  ES: { ptVal: 5, tick: 0.25, open: 9.5, close: 16, micro: "MES" },
  NQ: { ptVal: 2, tick: 0.25, open: 9.5, close: 16, micro: "MNQ" },
  GC: { ptVal: 10, tick: 0.1, open: 8 + 20 / 60, close: 13.5, micro: "MGC" },
};
const OR_MIN = 15;
const FEE_RT = process.env.NO_COSTS ? 0 : 2.06;
const SLIP = process.env.NO_COSTS ? 0 : 1;   // ticks adverse on entry and stop exits
const MAX_CONTRACTS = 20;
const RISK_USD = 350;
const MAX_TRADES_PER_DAY = 2;
const OOS_FROM = Date.UTC(2020, 0, 1);

interface Raw { n: number; ms: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array; inst: Float64Array; tday: Int32Array; hour: Float64Array }

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offsetCache = new Map<number, number>();
function etOffsetMs(t: number): number {
  const hourIdx = Math.floor(t / 3600000);
  const hit = offsetCache.get(hourIdx);
  if (hit !== undefined) return hit;
  const p: any = {};
  for (const part of etFmt.formatToParts(hourIdx * 3600000)) p[part.type] = part.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  const off = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute) - hourIdx * 3600000;
  offsetCache.set(hourIdx, off);
  return off;
}

/** tday = the Globex trading day: 18:00 ET belongs to the NEXT calendar day. hour = ET clock hour (fractional). */
function loadRaw(file: string): Raw {
  const buf = fs.readFileSync(new URL(`${DATA}/${file}`, ROOT));
  const cap = Math.ceil(buf.length / 80) + 1024;
  const ms = new Float64Array(cap), o = new Float64Array(cap), h = new Float64Array(cap), l = new Float64Array(cap), c = new Float64Array(cap), v = new Float64Array(cap), inst = new Float64Array(cap);
  const tday = new Int32Array(cap), hour = new Float64Array(cap);
  let n = 0, pos = buf.indexOf(10) + 1;
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos); if (nl < 0) nl = buf.length;
    if (nl > pos) {
      const f = buf.latin1Slice(pos, nl).split(",");
      const t = Date.parse(f[0]); const cl = +f[7];
      if (isFinite(t) && isFinite(cl) && cl > 0) {
        const etMs = t + etOffsetMs(t);
        const d = Math.floor(etMs / 86400000);
        const hr = (etMs - d * 86400000) / 3600000;
        ms[n] = t; o[n] = +f[4]; h[n] = +f[5]; l[n] = +f[6]; c[n] = cl; v[n] = +f[8] || 0; inst[n] = +f[3];
        hour[n] = hr; tday[n] = hr >= 18 ? d + 1 : d;
        n++;
      }
    }
    pos = nl + 1;
  }
  return { n, ms, o, h, l, c, v, inst, tday, hour };
}

/** One bar of the study's frame, built from 1-minute bars. `last` = index of its final 1-minute bar. */
interface FBar { o: number; h: number; l: number; c: number; last: number; vwap: number; hour: number }

interface Trade { ms: number; year: number; dir: 1 | -1; contracts: number; riskUsd: number; pnl: number; r: number; outcome: string; hour: number }
type Exit = "2R" | "template";

/** Manage one position on 1-minute bars from `e` (filled at open of e) to `endIdx`. */
function manage(raw: Raw, e: number, endIdx: number, dir: 1 | -1, fill: number, stop0: number, qty: number, exit: Exit, tick: number, ptVal: number): { pts: number; outcome: string } {
  const risk = (fill - stop0) * dir;
  let open = qty, pts = 0, stop = stop0, tookHalf = false;
  const tgt = fill + dir * risk * (exit === "2R" ? 2 : 3), half = fill + dir * risk;
  const out = (q: number, px: number) => { pts += (px - fill) * dir * q; open -= q; };
  for (let j = e; j <= endIdx && open > 0; j++) {
    const op = raw.o[j], hi = raw.h[j], lo = raw.l[j];
    if (j > e && (dir === 1 ? op <= stop : op >= stop)) { out(open, op - dir * tick * SLIP); return { pts, outcome: tookHalf ? "half+gap" : "gap-stop" }; }
    if (dir === 1 ? lo <= stop : hi >= stop) { out(open, stop - dir * tick * SLIP); return { pts, outcome: tookHalf ? (stop === fill ? "half+be" : "half+stop") : "stop" }; }
    if (exit === "template" && !tookHalf && (dir === 1 ? hi > half : lo < half)) {
      const q = Math.floor(qty / 2); if (q > 0) out(q, half); tookHalf = true; stop = fill;
    }
    if (dir === 1 ? hi > tgt : lo < tgt) { out(open, tgt); return { pts, outcome: "target" }; }
  }
  if (open > 0) out(open, raw.c[endIdx] - dir * tick * SLIP);
  return { pts, outcome: tookHalf ? "half+eod" : "eod" };
}

function runDay(raw: Raw, inst: typeof INSTR.ES, s: number, eIdx: number, frame: 1 | 5, exit: Exit): Trade[] {
  // VWAP from the Globex open (18:00 ET), reset on a contract change; skip days whose contract changes in session.
  let pv = 0, vol = 0;
  const vwapAt = new Float64Array(eIdx - s + 1);
  let sessStart = -1, orEnd = -1, entryCut = inst.close - 1, flat = inst.close - 5 / 60;
  let orh = -Infinity, orl = Infinity;
  for (let i = s; i <= eIdx; i++) {
    if (i > s && raw.inst[i] !== raw.inst[i - 1]) {
      if (sessStart >= 0) return [];     // contract changed inside the session
      pv = 0; vol = 0;
    }
    const tp = (raw.h[i] + raw.l[i] + raw.c[i]) / 3, vv = raw.v[i] > 0 ? raw.v[i] : 0;
    pv += tp * vv; vol += vv;
    vwapAt[i - s] = vol > 0 ? pv / vol : tp;
    const hr = raw.hour[i];
    if (hr >= inst.open && hr < inst.close && sessStart < 0) sessStart = i;
    if (sessStart >= 0 && hr < inst.open + OR_MIN / 60 && hr >= inst.open) { orh = Math.max(orh, raw.h[i]); orl = Math.min(orl, raw.l[i]); }
    if (sessStart >= 0 && orEnd < 0 && hr >= inst.open + OR_MIN / 60) orEnd = i;
  }
  if (sessStart < 0 || orEnd < 0 || !(orh > orl)) return [];
  // session must be complete-ish: OR bars present (at least 10 of 15 minutes) — thin days are skipped
  let orBars = 0; for (let i = sessStart; i < orEnd; i++) orBars++;
  if (orBars < 10) return [];
  let flatIdx = -1; for (let i = orEnd; i <= eIdx; i++) { if (raw.hour[i] >= flat || raw.hour[i] < inst.open) break; flatIdx = i; }
  if (flatIdx < orEnd) return [];

  // frame bars after the OR, aligned to the session open
  const bars: FBar[] = [];
  for (let i = orEnd; i <= flatIdx;) {
    const bucket = Math.floor(Math.round((raw.hour[i] - inst.open) * 60) / frame);
    let j = i, h = raw.h[i], l = raw.l[i];
    while (j + 1 <= flatIdx && Math.floor(Math.round((raw.hour[j + 1] - inst.open) * 60) / frame) === bucket) { j++; h = Math.max(h, raw.h[j]); l = Math.min(l, raw.l[j]); }
    bars.push({ o: raw.o[i], h, l, c: raw.c[j], last: j, vwap: vwapAt[j - s], hour: raw.hour[i] });
    i = j + 1;
  }

  const trades: Trade[] = [];
  let busyUntil = -1;
  // independent state per side
  const st = { 1: { bias: false, dead: false, inPb: false, pbExt: 0, prevPbExt: NaN }, [-1]: { bias: false, dead: false, inPb: false, pbExt: 0, prevPbExt: NaN } } as Record<number, { bias: boolean; dead: boolean; inPb: boolean; pbExt: number; prevPbExt: number }>;
  for (let k = 1; k < bars.length && trades.length < MAX_TRADES_PER_DAY; k++) {
    const b = bars[k], p = bars[k - 1];
    for (const dir of [1, -1] as const) {
      const S = st[dir];
      if (S.dead) continue;
      const beyondOR = dir === 1 ? b.c > orh : b.c < orl, rightOfVwap = dir === 1 ? b.c > b.vwap : b.c < b.vwap;
      if (!S.bias) { if (beyondOR && rightOfVwap) S.bias = true; continue; }
      if (!rightOfVwap) { S.dead = true; continue; }                                   // lost VWAP: side is over for the day
      if (!S.inPb) {
        if (dir === 1 ? b.l < p.l : b.h > p.h) { S.inPb = true; S.pbExt = dir === 1 ? b.l : b.h; }
        if (S.inPb && !isNaN(S.prevPbExt) && (dir === 1 ? S.pbExt <= S.prevPbExt : S.pbExt >= S.prevPbExt)) { S.dead = true; }
        continue;
      }
      S.pbExt = dir === 1 ? Math.min(S.pbExt, b.l) : Math.max(S.pbExt, b.h);
      if (!isNaN(S.prevPbExt) && (dir === 1 ? S.pbExt <= S.prevPbExt : S.pbExt >= S.prevPbExt)) { S.dead = true; continue; }
      const trigger = dir === 1 ? b.c > p.h : b.c < p.l;
      if (!trigger) continue;
      // the pullback is complete: this is the higher low (lower high). Record it whether or not we can trade it.
      const ext = S.pbExt; S.prevPbExt = ext; S.inPb = false;
      const e = b.last + 1;
      if (e > flatIdx || e <= busyUntil || raw.hour[e] >= entryCut || raw.hour[e] < inst.open) continue;
      const fill = raw.o[e] + dir * inst.tick * SLIP, stop = ext - dir * inst.tick;
      const riskPts = (fill - stop) * dir;
      if (!(riskPts > 0)) continue;
      const qty = Math.min(MAX_CONTRACTS, Math.floor(RISK_USD / (riskPts * inst.ptVal)));
      if (qty < 1) continue;
      const { pts, outcome } = manage(raw, e, flatIdx, dir, fill, stop, qty, exit, inst.tick, inst.ptVal);
      const pnl = pts * inst.ptVal - FEE_RT * qty, riskUsd = riskPts * inst.ptVal * qty;
      trades.push({ ms: raw.ms[e], year: new Date(raw.ms[e]).getUTCFullYear(), dir, contracts: qty, riskUsd, pnl, r: pnl / riskUsd, outcome, hour: raw.hour[e] });
      busyUntil = exitIndex(raw, e, flatIdx, dir, fill, stop, exit);   // one position at a time
      break;   // one new trade per frame bar
    }
  }
  return trades;
}

/** Same path as `manage`, returning only the 1-minute index where the position is fully closed. */
function exitIndex(raw: Raw, e: number, endIdx: number, dir: 1 | -1, fill: number, stop0: number, exit: Exit): number {
  const risk = (fill - stop0) * dir; let stop = stop0, tookHalf = false;
  const tgt = fill + dir * risk * (exit === "2R" ? 2 : 3), half = fill + dir * risk;
  for (let j = e; j <= endIdx; j++) {
    if (j > e && (dir === 1 ? raw.o[j] <= stop : raw.o[j] >= stop)) return j;
    if (dir === 1 ? raw.l[j] <= stop : raw.h[j] >= stop) return j;
    if (exit === "template" && !tookHalf && (dir === 1 ? raw.h[j] > half : raw.l[j] < half)) { tookHalf = true; stop = fill; }
    if (dir === 1 ? raw.h[j] > tgt : raw.l[j] < tgt) return j;
  }
  return endIdx;
}

function stats(xs: number[]) {
  const n = xs.length; if (!n) return { n: 0, sum: 0, avg: 0, t: 0 };
  const sum = xs.reduce((a, b) => a + b, 0), avg = sum / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1)) : 0;
  return { n, sum, avg, t: sd > 0 ? (avg / sd) * Math.sqrt(n) : 0 };
}
function money(tr: Trade[]) {
  let gw = 0, gl = 0, cum = 0, peak = 0, dd = 0, w = 0;
  for (const x of tr) { if (x.pnl > 0) { gw += x.pnl; w++; } else gl -= x.pnl; cum += x.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { pf: gl > 0 ? gw / gl : Infinity, wr: tr.length ? w / tr.length : 0, dd, net: cum };
}
const f0 = (x: number) => (x < 0 ? "−" : "") + Math.abs(x).toFixed(0);
const f2 = (x: number) => (x < 0 ? "−" : "") + Math.abs(x).toFixed(2);

function main() {
  const want = (process.argv[2] ?? "ES,NQ,GC").split(",");
  const summary: string[] = [];
  const dump: Record<string, Trade[]> = {};
  for (const sym of want) {
    const inst = INSTR[sym]; if (!inst) continue;
    const t0 = Date.now();
    const raw = loadRaw(`${sym}_1m.csv`);
    const days: { s: number; e: number }[] = [];
    let s = 0;
    for (let i = 1; i <= raw.n; i++) if (i === raw.n || raw.tday[i] !== raw.tday[i - 1]) { days.push({ s, e: i - 1 }); s = i; }
    console.log(`\n${sym} (${inst.micro}): ${raw.n.toLocaleString()} bars, ${days.length} Globex days, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const frame of [5, 1] as const) for (const exit of ["2R", "template"] as Exit[]) {
      const tr: Trade[] = [];
      for (const d of days) tr.push(...runDay(raw, inst, d.s, d.e, frame, exit));
      const key = `${sym} ${frame}m ${exit}`;
      dump[key] = tr;
      const all = stats(tr.map((x) => x.r)), is = stats(tr.filter((x) => x.ms < OOS_FROM).map((x) => x.r)), oos = stats(tr.filter((x) => x.ms >= OOS_FROM).map((x) => x.r));
      const m = money(tr);
      const years = new Map<number, number>(); for (const x of tr) years.set(x.year, (years.get(x.year) ?? 0) + x.r);
      const posYears = [...years.values()].filter((v) => v > 0).length;
      const L = stats(tr.filter((x) => x.dir === 1).map((x) => x.r)), Sh = stats(tr.filter((x) => x.dir === -1).map((x) => x.r));
      const morn = stats(tr.filter((x) => x.hour < 10.5 + (sym === "GC" ? -1 : 0)).map((x) => x.r)), later = stats(tr.filter((x) => x.hour >= 10.5 + (sym === "GC" ? -1 : 0)).map((x) => x.r));
      const survives = all.n >= 100 && is.avg > 0 && oos.avg > 0 && all.t >= 2;
      const line = `${survives ? "★" : " "} ${key.padEnd(16)} n ${String(all.n).padStart(5)}  avgR ${f2(all.avg).padStart(6)}  t ${f2(all.t).padStart(6)}  PF ${m.pf.toFixed(2)}  win ${(m.wr * 100).toFixed(0)}%  net $${f0(m.net).padStart(8)}  maxDD $${f0(m.dd).padStart(7)} | 2011-19 avgR ${f2(is.avg)} t ${f2(is.t)} | 2020-26 avgR ${f2(oos.avg)} t ${f2(oos.t)} | years+ ${posYears}/${years.size} | long ${f2(L.avg)} (t ${f2(L.t)}) short ${f2(Sh.avg)} (t ${f2(Sh.t)}) | early ${f2(morn.avg)} (n ${morn.n}) later ${f2(later.avg)} (n ${later.n})`;
      console.log(line); summary.push(line);
      console.log(`    by year (sum R): ${[...years.entries()].sort((a, b) => a[0] - b[0]).map(([y, v]) => `${String(y).slice(2)}:${v.toFixed(0)}`).join(" ")}`);
    }
  }
  console.log(`\n★ = n ≥ 100, avg R > 0 in 2011–19 AND 2020–26, t ≥ 2 overall.\n${summary.join("\n")}`);
  if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(dump));
}
main();
