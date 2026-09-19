/**
 * ORB STUDY — Opening Range Breakout on ES / NQ / GC, 2011–2026, 1-minute data we own.
 *
 * The question Spencer's spec asks, done the way it asks: TRY TO DISPROVE IT. Every cell below
 * has to be positive after costs in BOTH the in-sample years (2011–2019) and the untouched
 * out-of-sample years (2020–2026), with t ≥ 2 on the whole, before it counts as anything.
 *
 * GRID
 *   instrument × OR anchor × OR width {5,15,30,60 min} × entry style × exit
 *   anchors: ES/NQ 09:30 ET (NYSE cash open); GC 08:20 ET (COMEX pit open) AND 09:30 ET —
 *            the spec says do not assume the equity open for gold, so both are tested.
 *   styles:  immediate      — first 1-min CLOSE beyond the range, enter next bar open
 *            close5         — first 5-min CLOSE beyond the range, enter next bar open
 *            retest         — after a 5-min close beyond, price comes back to touch the level
 *                             (within 60 min, without closing back past the OR midpoint), then a
 *                             5-min close beyond again → enter next bar open
 *            failed         — after a 5-min close beyond, a 5-min close BACK INSIDE within 60 min →
 *                             fade it (enter next bar open toward the opposite edge), stop beyond
 *                             the excursion extreme
 *   exits:   stop = OR midpoint (breakouts) / excursion extreme (failed); target 1R, 2R, or none;
 *            everything flat at 15:59 ET. One trade per day per cell, the FIRST signal, entries
 *            only in the 2 hours after the range completes.
 *
 * COSTS (per micro, MES $5/pt · MNQ $2/pt · MGC $10/pt): $1.30 round-turn commission, 1 tick
 *   adverse on entry and on every exit incl. stops (a bar that opens through the stop fills at the
 *   open); a bar touching both stop and target counts as the STOP.
 *
 * The archive is the front contract, unadjusted. Every trade closes the day it opens, so rolls
 * never sit inside a trade — no back-adjustment needed.
 *
 * Usage: npx tsx scripts/orb-study.ts [ES,NQ,GC]
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const INSTR: Record<string, { file: string; ptVal: number; tick: number; comm: number; anchors: number[]; micro: string }> = {
  ES: { file: "data/tf15y/ES_1m.csv", ptVal: 5, tick: 0.25, comm: 1.30, anchors: [9.5], micro: "MES" },
  NQ: { file: "data/tf15y/NQ_1m.csv", ptVal: 2, tick: 0.25, comm: 1.30, anchors: [9.5], micro: "MNQ" },
  GC: { file: "data/tf15y/GC_1m.csv", ptVal: 10, tick: 0.1, comm: 1.30, anchors: [8 + 20 / 60, 9.5], micro: "MGC" },
};
const WIDTHS = [5, 15, 30, 60];
const STYLES = ["immediate", "close5", "retest", "failed"] as const;
const TARGETS = [1, 2, 0] as const; // R multiples; 0 = no target (session close)
const SESSION_END = 16.0;          // flat at the last bar before 16:00 ET
const ENTRY_WINDOW_MIN = 120;
const OOS_FROM = Date.UTC(2020, 0, 1);

interface Raw { n: number; ms: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; day: Int32Array; hour: Float64Array }

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

function loadRaw(file: string): Raw {
  // Buffer scan, not a string split: GC's file is over Node's string-length limit.
  const buf = fs.readFileSync(new URL(file, ROOT));
  const cap = Math.ceil(buf.length / 80) + 1024;
  const ms = new Float64Array(cap), o = new Float64Array(cap), h = new Float64Array(cap), l = new Float64Array(cap), c = new Float64Array(cap);
  const day = new Int32Array(cap), hour = new Float64Array(cap);
  let n = 0, pos = buf.indexOf(10) + 1; // skip the header
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos); if (nl < 0) nl = buf.length;
    if (nl > pos) {
      const f = buf.latin1Slice(pos, nl).split(",");
      const t = Date.parse(f[0]); const cl = +f[7];
      if (isFinite(t) && isFinite(cl) && cl > 0) {
        const etMs = t + etOffsetMs(t);
        const d = Math.floor(etMs / 86400000);
        ms[n] = t; o[n] = +f[4]; h[n] = +f[5]; l[n] = +f[6]; c[n] = cl; day[n] = d; hour[n] = (etMs - d * 86400000) / 3600000;
        n++;
      }
    }
    pos = nl + 1;
  }
  return { n, ms, o, h, l, c, day, hour };
}

interface Trade { day: number; ms: number; pnl: number; r: number; orwAtr: number; bars: number; outcome: string; dir: 1 | -1 }

/** Simulate one position on 1-min bars from `e` (fill at open of e) until stop/target/session end. */
function simulate(raw: Raw, e: number, endIdx: number, dir: 1 | -1, stop: number, target: number | null, inst: typeof INSTR.ES): { pnl: number; exitIdx: number; outcome: string } {
  const tick = inst.tick;
  const fill = raw.o[e] + dir * tick;
  const pnlAt = (px: number) => dir * (px - fill) * inst.ptVal - inst.comm;
  for (let j = e; j <= endIdx; j++) {
    const o = raw.o[j], hi = raw.h[j], lo = raw.l[j];
    if (dir === 1 ? o <= stop : o >= stop) return { pnl: pnlAt(o - dir * tick), exitIdx: j, outcome: "gap-stop" };
    const stopHit = dir === 1 ? lo <= stop : hi >= stop;
    if (stopHit) return { pnl: pnlAt(stop - dir * tick), exitIdx: j, outcome: "stop" };
    if (target != null && (dir === 1 ? hi > target : lo < target)) return { pnl: pnlAt(target), exitIdx: j, outcome: "target" };
  }
  return { pnl: pnlAt(raw.c[endIdx] - dir * tick), exitIdx: endIdx, outcome: "eod" };
}

/** 5-minute close series over a 1-min index range: closes at every 5th bar from `from`. */
const isFiveClose = (raw: Raw, i: number) => Math.round(raw.hour[i] * 60) % 5 === 4;

function runCell(raw: Raw, inst: typeof INSTR.ES, anchor: number, width: number, style: typeof STYLES[number], targetR: number, dayIdx: { start: number; end: number }[], atrByDay: Map<number, number>): Trade[] {
  const trades: Trade[] = [];
  for (const { start, end } of dayIdx) {
    // range bars: hour in [anchor, anchor + width/60)
    let orh = -Infinity, orl = Infinity, k = start, rangeEnd = -1;
    for (; k <= end; k++) {
      if (raw.hour[k] < anchor) continue;
      if (raw.hour[k] >= anchor + width / 60) { rangeEnd = k; break; }
      if (raw.h[k] > orh) orh = raw.h[k];
      if (raw.l[k] < orl) orl = raw.l[k];
    }
    if (rangeEnd < 0 || !isFinite(orh) || !isFinite(orl) || orh <= orl) continue;
    const orw = orh - orl, mid = (orh + orl) / 2;
    const atr = atrByDay.get(raw.day[start]) ?? 0;
    if (atr <= 0) continue;
    const orwAtr = orw / atr;
    const cutoff = anchor + (width + ENTRY_WINDOW_MIN) / 60;

    let entryIdx = -1, dir: 1 | -1 = 1, stop = 0;
    // ── find the first signal ──
    if (style === "immediate" || style === "close5") {
      for (let i = rangeEnd; i < end && raw.hour[i] < cutoff; i++) {
        if (style === "close5" && !isFiveClose(raw, i)) continue;
        if (raw.c[i] > orh) { dir = 1; entryIdx = i + 1; break; }
        if (raw.c[i] < orl) { dir = -1; entryIdx = i + 1; break; }
      }
      stop = mid;
    } else {
      // both retest and failed start from the first 5-min close beyond the range
      let b = -1;
      for (let i = rangeEnd; i < end && raw.hour[i] < cutoff; i++) {
        if (!isFiveClose(raw, i)) continue;
        if (raw.c[i] > orh) { dir = 1; b = i; break; }
        if (raw.c[i] < orl) { dir = -1; b = i; break; }
      }
      if (b >= 0) {
        const level = dir === 1 ? orh : orl;
        const limit = Math.min(end - 1, b + 60);
        if (style === "retest") {
          let touched = false;
          for (let i = b + 1; i <= limit; i++) {
            if (dir === 1 ? raw.l[i] <= level : raw.h[i] >= level) touched = true;
            if (isFiveClose(raw, i)) {
              if (dir === 1 ? raw.c[i] < mid : raw.c[i] > mid) break;               // failed before the retest held
              if (touched && (dir === 1 ? raw.c[i] > level : raw.c[i] < level)) { entryIdx = i + 1; break; }
            }
          }
          stop = mid;
        } else {
          let ext = dir === 1 ? raw.h[b] : raw.l[b];
          for (let i = b + 1; i <= limit; i++) {
            ext = dir === 1 ? Math.max(ext, raw.h[i]) : Math.min(ext, raw.l[i]);
            if (isFiveClose(raw, i) && (dir === 1 ? raw.c[i] < level : raw.c[i] > level)) {
              entryIdx = i + 1; stop = ext + dir * inst.tick; dir = (dir === 1 ? -1 : 1); break;   // fade
            }
          }
        }
      }
    }
    if (entryIdx < 0 || entryIdx >= end) continue;
    const fill = raw.o[entryIdx] + dir * inst.tick;
    const risk = dir === 1 ? fill - stop : stop - fill;
    if (!(risk > 0)) continue;
    const target = targetR > 0 ? fill + dir * risk * targetR : null;
    const { pnl, exitIdx, outcome } = simulate(raw, entryIdx, end, dir, stop, target, inst);
    trades.push({ day: raw.day[entryIdx], ms: raw.ms[entryIdx], pnl, r: pnl / (risk * inst.ptVal), orwAtr, bars: exitIdx - entryIdx, outcome, dir });
  }
  return trades;
}

function stats(tr: Trade[]) {
  const n = tr.length;
  if (!n) return { n: 0, net: 0, avg: 0, wr: 0, pf: 0, t: 0, dd: 0 };
  let net = 0, w = 0, gw = 0, gl = 0, peak = 0, dd = 0, cum = 0, ss = 0;
  for (const x of tr) { net += x.pnl; if (x.pnl > 0) { w++; gw += x.pnl; } else gl -= x.pnl; cum += x.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const avg = net / n;
  for (const x of tr) ss += (x.pnl - avg) ** 2;
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  return { n, net, avg, wr: w / n, pf: gl > 0 ? gw / gl : Infinity, t: sd > 0 ? avg / sd * Math.sqrt(n) : 0, dd };
}
const f0 = (x: number) => (x < 0 ? "−" : "") + Math.abs(x).toFixed(0);
const f1 = (x: number) => (x < 0 ? "−" : "") + Math.abs(x).toFixed(1);
const f2 = (x: number) => (x < 0 ? "−" : "") + Math.abs(x).toFixed(2);

function main() {
  const want = (process.argv[2] ?? "ES,NQ,GC").split(",");
  const rows: { key: string; s: ReturnType<typeof stats>; is: ReturnType<typeof stats>; oos: ReturnType<typeof stats>; byYear: Map<number, number>; terc: [number, number, number]; robust: boolean; tr: Trade[] }[] = [];
  for (const sym of want) {
    const inst = INSTR[sym]; if (!inst) continue;
    const t0 = Date.now();
    const raw = loadRaw(inst.file);
    // ET day → [start,end] index of bars with hour in [anchor-ish, SESSION_END); build on the session window
    const dayIdx: { start: number; end: number }[] = [];
    let curDay = -1, start = -1;
    for (let i = 0; i < raw.n; i++) {
      if (raw.hour[i] >= SESSION_END || raw.hour[i] < 8) { if (start >= 0 && raw.day[i] === curDay) { /* past session */ } continue; }
      if (raw.day[i] !== curDay) { if (start >= 0) dayIdx.push({ start, end: lastIdx }); curDay = raw.day[i]; start = i; }
      var lastIdx = i;
    }
    if (start >= 0) dayIdx.push({ start, end: lastIdx! });
    // daily ATR(20) from the session bars, keyed by ET day, using the PRIOR 20 days only
    const atrByDay = new Map<number, number>();
    const trs: number[] = []; let prevClose = NaN;
    for (const { start, end } of dayIdx) {
      let hi = -Infinity, lo = Infinity;
      for (let i = start; i <= end; i++) { if (raw.h[i] > hi) hi = raw.h[i]; if (raw.l[i] < lo) lo = raw.l[i]; }
      if (trs.length >= 20) atrByDay.set(raw.day[start], trs.slice(-20).reduce((a, b) => a + b, 0) / 20);
      const tr = isFinite(prevClose) ? Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose)) : hi - lo;
      trs.push(tr); prevClose = raw.c[end];
    }
    console.log(`\n${sym} (${inst.micro}): ${raw.n.toLocaleString()} 1-min bars, ${dayIdx.length} session days, loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const anchor of inst.anchors) for (const width of WIDTHS) for (const style of STYLES) for (const targetR of TARGETS) {
      const tr = runCell(raw, inst, anchor, width, style, targetR, dayIdx, atrByDay);
      const is = tr.filter((x) => x.ms < OOS_FROM), oos = tr.filter((x) => x.ms >= OOS_FROM);
      const s = stats(tr), si = stats(is), so = stats(oos);
      const byYear = new Map<number, number>();
      for (const x of tr) { const y = new Date(x.ms).getUTCFullYear(); byYear.set(y, (byYear.get(y) ?? 0) + x.pnl); }
      const sorted = [...tr].sort((a, b) => a.orwAtr - b.orwAtr); const third = Math.floor(sorted.length / 3);
      const terc: [number, number, number] = [stats(sorted.slice(0, third)).avg, stats(sorted.slice(third, 2 * third)).avg, stats(sorted.slice(2 * third)).avg];
      const robust = s.n >= 100 && si.avg > 0 && so.avg > 0 && s.t >= 2;
      const anchorLabel = `${Math.floor(anchor)}:${String(Math.round((anchor % 1) * 60)).padStart(2, "0")}`;
      rows.push({ key: `${sym.padEnd(2)} ${anchorLabel} OR${String(width).padStart(2)} ${style.padEnd(9)} ${targetR ? targetR + "R" : "eod"}`, s, is: si, oos: so, byYear, terc, robust, tr });
    }
  }
  console.log("\ncell                               n     net/micro   avg    WR    PF     t   maxDD |  IS avg  IS t | OOS avg OOS t | narrow/normal/wide OR (avg $) ");
  for (const r of rows.sort((a, b) => b.s.t - a.s.t)) {
    console.log(`${r.robust ? "★" : " "} ${r.key}  ${String(r.s.n).padStart(5)}  ${f0(r.s.net).padStart(9)}  ${f1(r.s.avg).padStart(6)}  ${(r.s.wr * 100).toFixed(0).padStart(3)}%  ${(isFinite(r.s.pf) ? r.s.pf.toFixed(2) : "∞").padStart(5)}  ${f2(r.s.t).padStart(5)}  ${f0(r.s.dd).padStart(6)} | ${f1(r.is.avg).padStart(7)} ${f2(r.is.t).padStart(5)} | ${f1(r.oos.avg).padStart(7)} ${f2(r.oos.t).padStart(5)} | ${f1(r.terc[0])} / ${f1(r.terc[1])} / ${f1(r.terc[2])}`);
  }
  const survivors = rows.filter((r) => r.robust);
  console.log(`\n★ = n ≥ 100, positive in BOTH 2011–19 and 2020–26, t ≥ 2 overall. Survivors: ${survivors.length} of ${rows.length}`);
  console.log("\nTop 6 cells by t, dissected — by year, long vs short, and the narrow-range third:");
  for (const r of rows.slice(0, 6)) {
    const years = [...r.byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, v]) => `${String(y).slice(2)}:${f0(v)}`).join(" ");
    const L = stats(r.tr.filter((x) => x.dir === 1)), S = stats(r.tr.filter((x) => x.dir === -1));
    const sorted = [...r.tr].sort((a, b) => a.orwAtr - b.orwAtr); const narrow = sorted.slice(0, Math.floor(sorted.length / 3));
    const nI = stats(narrow.filter((x) => x.ms < OOS_FROM)), nO = stats(narrow.filter((x) => x.ms >= OOS_FROM));
    console.log(`  ${r.key}\n    by year: ${years}\n    long n=${L.n} avg ${f1(L.avg)} t ${f2(L.t)} · short n=${S.n} avg ${f1(S.avg)} t ${f2(S.t)}\n    narrow-OR third: IS avg ${f1(nI.avg)} t ${f2(nI.t)} · OOS avg ${f1(nO.avg)} t ${f2(nO.t)}`);
  }
}
main();
