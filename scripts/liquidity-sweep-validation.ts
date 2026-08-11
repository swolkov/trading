/**
 * LIQUIDITY-SWEEP VALIDATION (2026-08-11) — the ICT "stop hunt" concept, made falsifiable and tested.
 *
 * Spencer asked for the sweep idea to be tested rather than dismissed. The concept: stops cluster
 * beyond obvious levels (prior-day high/low, overnight high/low); price probes the level, fills the
 * stops, and reverses. The retail version is unfalsifiable (any reversal is "the sweep" in
 * hindsight), so this defines it MECHANICALLY, identifiable in real time:
 *
 *   SWEEP  = bar pierces the level by >= 1 tick but < 0.6x ATR (deeper = breakout, not a sweep),
 *            and price CLOSES back inside within 2 x 5m bars.
 *   ENTRY  = fade at the reclaim close (short a swept high, long a swept low), first touch per
 *            level per day, RTH entries only, flat by session end.
 *   STOPS  = two styles, both tested: "atr" (engine 1.4x scaled ATR) and "struct" (1 tick beyond
 *            the sweep extreme — the concept's native stop).
 *   MGMT   = engine-faithful: BE 0.8R, trail 1.5x ATR, 65% profit lock past 1R, stale 90m.
 *   COSTS  = measured live slippage (NQ 1.38 / ES 0.89 / GC 0.50 pts) + $2.02 commission.
 *
 * Related prior evidence: failed_ib_breakout (the opening-range cousin of this idea) recorded 0%
 * wins live and is fenced off. Bar to take seriously: PF > 1.15, BOTH halves > 1.0, n >= 60 — and
 * with ~24 cells tested, one isolated pass is within false-positive expectations; coherence across
 * instruments is what would make it real.
 *
 *   npx tsx scripts/liquidity-sweep-validation.ts <NQ|ES|GC> <atr|struct>
 */
import fs from "node:fs";
const ROOT = new URL("..", import.meta.url);
const SPECS: Record<string, { file: string; ptVal: number; tick: number; slip: number; label: string }> = {
  NQ: { file: "data/NQ_1m.csv", ptVal: 2, tick: 0.25, slip: 1.38, label: "NQ → MNQ ($2/pt)" },
  ES: { file: "data/ES_1m.csv", ptVal: 5, tick: 0.25, slip: 0.89, label: "ES → MES ($5/pt)" },
  GC: { file: "data/GC_1m.csv", ptVal: 10, tick: 0.1, slip: 0.5, label: "GC → MGC ($10/pt)" },
};
const SYM = process.argv[2]; const STYLE = (process.argv[3] || "atr") as "atr" | "struct";
const S = SPECS[SYM]; if (!S) { console.error("usage: <NQ|ES|GC> <atr|struct>"); process.exit(1); }

const COMMISSION = 2.02, ATR_SCALE = 1.5, STOP_ATR = 1.4, BE_R = 0.8, TRAIL_R = 1.1, TRAIL_M = 1.5, LOCK = 0.65, STALE = 90, MAX_EXC_ATR = 0.6, RECLAIM_BARS = 2, BUFFER = 200;

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offC = new Map<number, number>();
function etOff(t: number) { const hr = Math.floor(t / 3600000); const h = offC.get(hr); if (h !== undefined) return h;
  const p: any = {}; for (const x of etFmt.formatToParts(hr * 3600000)) p[x.type] = x.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  const off = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute) - hr * 3600000; offC.set(hr, off); return off; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; day: number; hour: number; dayISO: string }
function load(file: string) {
  const lines = fs.readFileSync(new URL(file, ROOT), "utf8").split("\n"); const m1: Bar[] = [];
  for (let i = 1; i < lines.length; i++) { const r = lines[i]; if (!r) continue; const f = r.split(",");
    const t = Date.parse(f[0]); const c = +f[7], h = +f[5], l = +f[6];
    if (!isFinite(t) || !(c > 0) || !(h > 0) || !(l > 0)) continue;
    const e = t + etOff(t); const day = Math.floor(e / 86400000);
    m1.push({ t, o: +f[4], h, l, c, v: +f[8] || 0, day, hour: (e - day * 86400000) / 3600000, dayISO: new Date(e).toISOString().slice(0, 10) }); }
  const m5: Bar[] = []; let k0 = -1;
  for (const b of m1) { const k = Math.floor(b.t / 300000);
    if (k !== k0) { k0 = k; m5.push({ ...b, t: k * 300000 }); }
    else { const j = m5.length - 1; if (b.h > m5[j].h) m5[j].h = b.h; if (b.l < m5[j].l) m5[j].l = b.l; m5[j].c = b.c; m5[j].v += b.v; } }
  return { m1, m5 };
}
function atrOf(b: Bar[], p = 14) { if (b.length < p + 1) return 0; let s = 0;
  for (let i = b.length - p; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); return s / p; }
const rth = (h: number) => h >= 9.5 && h < 16;

const { m1, m5 } = load(S.file);
// Per ET-day levels: RTH high/low, and overnight (18:00 prev → 9:30) high/low.
const rthHi = new Map<number, number>(), rthLo = new Map<number, number>();
const onHi = new Map<number, number>(), onLo = new Map<number, number>();
for (const b of m5) {
  if (rth(b.hour)) { rthHi.set(b.day, Math.max(rthHi.get(b.day) ?? -Infinity, b.h)); rthLo.set(b.day, Math.min(rthLo.get(b.day) ?? Infinity, b.l)); }
  const onDay = b.hour >= 18 ? b.day + 1 : b.day;         // overnight session belongs to NEXT day
  if (b.hour >= 18 || b.hour < 9.5) { onHi.set(onDay, Math.max(onHi.get(onDay) ?? -Infinity, b.h)); onLo.set(onDay, Math.min(onLo.get(onDay) ?? Infinity, b.l)); }
}
const prevRthDay = new Map<number, number>();             // day -> most recent prior day WITH rth bars
{ let last = -1; const days = [...new Set(m5.map(b => b.day))].sort((a, b) => a - b);
  for (const d of days) { if (last >= 0) prevRthDay.set(d, last); if (rthHi.has(d)) last = d; } }

interface T { session: string; kind: string; dir: string; pnl: number; r: number }
const trades: T[] = [];
// sweep state per day: level key -> { pierceBar, pierceExtreme } while awaiting reclaim; and traded set
let curDay = -1;
let pend: Record<string, { i: number; ext: number; level: number }> = {}; let done = new Set<string>();
let m1c = 0;
for (let i = BUFFER; i < m5.length; i++) {
  const bar = m5[i];
  if (!rth(bar.hour) || bar.hour >= 15.5) continue;       // entries 9:30–15:30 only
  if (bar.day !== curDay) { curDay = bar.day; pend = {}; done = new Set(); }
  const pd = prevRthDay.get(bar.day);
  const buf = m5.slice(i - BUFFER + 1, i + 1);
  const atr = atrOf(buf); if (!(atr > 0)) continue;
  const levels: [string, number, "hi" | "lo"][] = [];
  if (pd !== undefined && rthHi.has(pd)) { levels.push(["PDH", rthHi.get(pd)!, "hi"], ["PDL", rthLo.get(pd)!, "lo"]); }
  if (onHi.has(bar.day)) { levels.push(["ONH", onHi.get(bar.day)!, "hi"], ["ONL", onLo.get(bar.day)!, "lo"]); }

  for (const [kind, L, side] of levels) {
    if (done.has(kind)) continue;
    const p = pend[kind];
    if (!p) {
      // did THIS bar pierce shallowly?
      const pierced = side === "hi" ? bar.h > L + S.tick : bar.l < L - S.tick;
      if (!pierced) continue;
      const exc = side === "hi" ? bar.h - L : L - bar.l;
      if (exc >= MAX_EXC_ATR * atr * ATR_SCALE) { done.add(kind); continue; }   // deep pierce = breakout, level dead today
      const closedBack = side === "hi" ? bar.c < L : bar.c > L;
      if (closedBack) pend[kind] = { i, ext: side === "hi" ? bar.h : bar.l, level: L }; // reclaim SAME bar → trigger below
      else { pend[kind] = { i, ext: side === "hi" ? bar.h : bar.l, level: L }; continue; } // wait for reclaim
    } else {
      // waiting for reclaim within RECLAIM_BARS
      if (i - p.i > RECLAIM_BARS) { delete pend[kind]; done.add(kind); continue; }  // no reclaim = breakout
      p.ext = side === "hi" ? Math.max(p.ext, bar.h) : Math.min(p.ext, bar.l);
      if ((side === "hi" ? p.ext - p.level : p.level - p.ext) >= MAX_EXC_ATR * atr * ATR_SCALE) { delete pend[kind]; done.add(kind); continue; }
      const closedBack = side === "hi" ? bar.c < p.level : bar.c > p.level;
      if (!closedBack) continue;
    }
    // TRIGGER: fade at this close
    const st = pend[kind]!; delete pend[kind]; done.add(kind);
    const short = side === "hi"; const dir = short ? "short" : "long";
    const entry = short ? bar.c - S.slip : bar.c + S.slip;
    const stopDist = STYLE === "atr" ? atr * ATR_SCALE * STOP_ATR
      : Math.max(Math.abs(st.ext - entry) + S.tick, 2 * S.tick);
    const hardStop = short ? entry + stopDist : entry - stopDist;
    const target = short ? entry - atr * ATR_SCALE * 5 : entry + atr * ATR_SCALE * 5;
    const risk$ = stopDist * S.ptVal;
    const eT = bar.t + 300000; while (m1c < m1.length && m1[m1c].t < eT) m1c++;
    let peak = 0, be = false, trail: number | null = null, exited: { px: number; k: number } | null = null;
    for (let k = m1c; k < m1.length && !exited; k++) {
      const b1 = m1[k]; const mins = (b1.t - eT) / 60000;
      if (!rth(b1.hour)) { exited = { px: b1.c, k }; break; }                     // flat at RTH end
      if (trail != null && (short ? b1.h >= trail : b1.l <= trail)) exited = { px: short ? Math.max(trail, b1.o) + S.tick : Math.min(trail, b1.o) - S.tick, k };
      else if (be && (short ? b1.h >= entry : b1.l <= entry)) exited = { px: short ? entry + S.tick : entry - S.tick, k };
      else if (short ? b1.h >= hardStop : b1.l <= hardStop) exited = { px: short ? Math.max(hardStop, b1.o) + S.tick : Math.min(hardStop, b1.o) - S.tick, k };
      if (!exited && (short ? b1.l <= target : b1.h >= target)) exited = { px: target, k };
      if (exited) break;
      const fav = short ? entry - b1.l : b1.h - entry; if (fav > peak) peak = fav;
      if (!be && peak >= stopDist * BE_R) be = true;
      if (peak >= stopDist * TRAIL_R) {
        let raw = short ? b1.l + atr * ATR_SCALE * TRAIL_M / 1.5 : b1.h - atr * ATR_SCALE * TRAIL_M / 1.5;
        if (peak >= stopDist) { const lk = short ? entry - peak * LOCK : entry + peak * LOCK; raw = short ? Math.min(raw, lk) : Math.max(raw, lk); }
        if (trail == null || (short ? raw < trail : raw > trail)) trail = raw;
      }
      if (mins >= STALE && (short ? entry - b1.c : b1.c - entry) < stopDist && !be) { exited = { px: short ? b1.c + S.tick : b1.c - S.tick, k }; break; }
    }
    if (!exited) break;
    const pnl = (short ? entry - exited.px : exited.px - entry) * S.ptVal - COMMISSION;
    const sess = bar.hour < 12 ? "morning" : bar.hour < 14 ? "midday" : "afternoon";
    trades.push({ session: sess, kind, dir, pnl, r: pnl / risk$ });
    const xT = m1[Math.min(exited.k, m1.length - 1)].t; while (i + 1 < m5.length && m5[i + 1].t <= xT) i++;
  }
}
console.log(`\n${S.label}  style=${STYLE}  ${m5[0]?.dayISO} → ${m5[m5.length - 1]?.dayISO}  trades=${trades.length}`);
const pf = (a: T[]) => { const g = a.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0), l = Math.abs(a.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0)); return l > 0 ? g / l : Infinity; };
const line = (lab: string, a: T[]) => { if (a.length < 20) return;
  const h = Math.floor(a.length / 2), tr = pf(a.slice(0, h)), te = pf(a.slice(h));
  const win = a.filter(t => t.pnl > 0).length / a.length; const net = a.reduce((s, t) => s + t.pnl, 0);
  const q = pf(a) > 1.15 && tr > 1 && te > 1 && a.length >= 60 ? "  ✅ PASSES" : "";
  console.log(`  ${lab.padEnd(26)} n=${String(a.length).padStart(4)}  win ${(win * 100).toFixed(0).padStart(3)}%  PF ${pf(a).toFixed(2).padStart(5)}  net $${net.toFixed(0).padStart(7)}  | ${tr.toFixed(2)} / ${te.toFixed(2)}${q}`); };
line("ALL", trades);
for (const kind of ["PDH", "PDL", "ONH", "ONL"]) { const a = trades.filter(t => t.kind === kind); line(`${kind} (${a[0]?.dir ?? ""})`, a);
  for (const s of ["morning", "midday", "afternoon"]) line(`  ${kind} ${s}`, a.filter(t => t.session === s)); }
