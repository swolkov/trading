/**
 * MULTI-INSTRUMENT RSI-EXTREME SESSION GRID — the frequency loophole, tested honestly.
 *
 * WHY (2026-08-10): live's book is 2-3 validated cells firing a few times a week. Risk per trade is
 * capped by capital, but TRADES PER WEEK are capped only by how many instruments the validated
 * playbook has been run against — and 3yr of 1m data for CL/SI/HG/NG/MBT/MET is already on disk at
 * $0 marginal (Databento Standard). This clones scripts/gold-edge-validation.ts's engine-faithful
 * logic (rolling 200x5m buffer, RSI<25 long / RSI>75 short, score>=75 gate, full management) and
 * sweeps it per instrument with MICRO contract economics, so fee drag and tick size are real.
 *
 * SCREENING PASS ONLY: all sessions enabled (0.5 size off-prime), 2026 engine management
 * (stop 1.4x ATR, target 5.0x, BE 0.8R, metals-style trail 1.5x / lock 0.65, stale 90m).
 * A cell qualifies for a DEMO TRIAL (never straight to live) only if PF > 1.15 AND train/test both
 * > 1.0 AND n >= 60. Anything less is noise-mining.
 */
import fs from "node:fs";
const ROOT = new URL("..", import.meta.url);

// Micro-contract economics. slipTicks: conservative entry slippage for screening.
const SPECS: Record<string, { file: string; ptVal: number; tick: number; label: string; slipTicks: number }> = {
  CL:  { file: "data/CL_1m.csv",  ptVal: 100,  tick: 0.01,   label: "CL → MCL micro ($100/pt)",  slipTicks: 1 },
  SI:  { file: "data/SI_1m.csv",  ptVal: 1000, tick: 0.005,  label: "SI → SIL micro ($1000/pt)", slipTicks: 2 },
  HG:  { file: "data/HG_1m.csv",  ptVal: 2500, tick: 0.0005, label: "HG → MHG micro ($2500/pt)", slipTicks: 2 },
  NG:  { file: "data/NG_1m.csv",  ptVal: 2500, tick: 0.001,  label: "NG → QG e-mini ($2500/pt)", slipTicks: 2 },
  MBT: { file: "data/MBT_1m.csv", ptVal: 0.1,  tick: 5,      label: "BTC → MBT micro ($0.10/pt)", slipTicks: 1 },
  MET: { file: "data/MET_1m.csv", ptVal: 0.1,  tick: 0.25,   label: "ETH → MET micro ($0.10/pt)", slipTicks: 1 },
};
const SYM = process.argv[2];
const S = SPECS[SYM]; if (!S) { console.error(`usage: SYM one of ${Object.keys(SPECS)}`); process.exit(1); }

const COMMISSION = 2.02;
const STOP_ATR = 1.4, TGT_ATR = 5.0, BREAKEVEN_R = 0.8, TRAIL_R = 1.1;
const ATR_SCALE = 1.5, TRAIL_ATR_MULT = 1.0 * 1.5, LOCK = 0.65, STALE_MIN = 90;
const BUFFER = 200;

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offCache = new Map<number, number>();
function etOffset(t: number): number {
  const hr = Math.floor(t / 3600000); const hit = offCache.get(hr); if (hit !== undefined) return hit;
  const p: any = {}; for (const x of etFmt.formatToParts(hr * 3600000)) p[x.type] = x.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  const off = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute) - hr * 3600000;
  offCache.set(hr, off); return off;
}
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; day: number; hour: number; dayISO: string }
function sessionName(hour: number, dow: number): string {
  if (dow === 6 || (dow === 5 && hour >= 17) || (dow === 0 && hour < 18)) return "halt";
  if (hour >= 17 && hour < 18) return "halt";
  if (hour >= 9.5 && hour < 16) { const m = (hour - 9.5) * 60; if (m < 15) return "open"; if (hour < 12) return "morning"; if (hour < 14) return "midday"; if (hour < 15.75) return "afternoon"; return "close"; }
  if (hour >= 16 && hour < 17) return "eth_evening";
  if (hour >= 18 && hour < 22) return "eth_evening";
  if (hour >= 22 || hour < 3) return "eth_asia";
  if (hour >= 3 && hour < 9) return "eth_europe";
  return "pre_market";
}
const sizeMult = (s: string) => s === "halt" ? 0 : (s === "morning" || s === "afternoon") ? 1.0 : 0.5;

function load(file: string) {
  const lines = fs.readFileSync(new URL(file, ROOT), "utf8").split("\n");
  const m1: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i]; if (!r) continue; const f = r.split(",");
    const t = Date.parse(f[0]); const c = +f[7];
    if (!isFinite(t) || !isFinite(c) || c <= 0) continue;
    const h = +f[5], l = +f[6]; if (!isFinite(h) || !isFinite(l) || h <= 0 || l <= 0) continue;
    const etMs = t + etOffset(t); const day = Math.floor(etMs / 86400000);
    m1.push({ t, o: +f[4], h, l, c, v: +f[8] || 0, day, hour: (etMs - day * 86400000) / 3600000, dayISO: new Date(etMs).toISOString().slice(0, 10) });
  }
  const m5: Bar[] = []; let key = -1;
  for (const b of m1) { const k = Math.floor(b.t / 300000);
    if (k !== key) { key = k; m5.push({ ...b, t: k * 300000 }); }
    else { const j = m5.length - 1; if (b.h > m5[j].h) m5[j].h = b.h; if (b.l < m5[j].l) m5[j].l = b.l; m5[j].c = b.c; m5[j].v += b.v; } }
  return { m1, m5 };
}
function rsiOf(c: number[], p = 14) { if (c.length < p + 1) return 50; let g = 0, l = 0; for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + (g / p) / (l / p)); }
function atrOf(b: Bar[], p = 14) { if (b.length < p + 1) return 0; let s = 0; for (let i = b.length - p; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); return s / p; }
function emaLast(c: number[], p: number) { const k = 2 / (p + 1); let r = c[0]; for (let i = 1; i < c.length; i++) r = c[i] * k + r * (1 - k); return r; }
function trend15(buf: Bar[]): "up" | "down" | "flat" { const c: number[] = []; for (let i = 0; i + 2 < buf.length; i += 3) c.push(buf[i + 2].c); if (c.length < 21) return "flat"; const a = emaLast(c, 9), b = emaLast(c, 21); return a > b ? "up" : a < b ? "down" : "flat"; }

const { m1, m5 } = load(S.file);
interface T { dayISO: string; session: string; dir: string; pnl: number; r: number }
const trades: T[] = [];
let m1Cursor = 0;
for (let i = BUFFER; i < m5.length; i++) {
  const bar = m5[i];
  const dow = new Date(bar.t + etOffset(bar.t)).getUTCDay();
  const session = sessionName(bar.hour, dow);
  const sm = sizeMult(session); if (sm <= 0) continue;
  const buf = m5.slice(i - BUFFER + 1, i + 1);
  const closes = buf.map(b => b.c);
  const rawATR = atrOf(buf); if (rawATR <= 0) continue;
  const currentATR = rawATR * ATR_SCALE;
  const rsi = rsiOf(closes);
  if (!(rsi < 25 || rsi > 75)) continue;
  let volSum = 0; for (let j = buf.length - 21; j < buf.length - 1; j++) volSum += buf[j].v;
  const avgVol = volSum / 20; const vr = avgVol > 0 ? bar.v / avgVol : 1;
  const volTrend = vr > 2 ? "surge" : vr < 0.6 ? "dry" : vr < 0.8 ? "declining" : "normal";
  if (volTrend === "surge") continue;
  const isOversold = rsi < 25;
  const dir = isOversold ? "long" : "short";
  const t15 = trend15(buf);
  let score = 70 + (volTrend === "declining" ? 5 : volTrend === "dry" ? -5 : 0)
    + ((isOversold ? t15 !== "down" : t15 !== "up") ? 10 : -10) + 3 + (sm >= 1 ? 5 : 0);
  if (Math.max(0, Math.min(100, score)) < 75) continue;

  const price = bar.c, short = dir === "short";
  const SLIP = S.tick * S.slipTicks;
  const stopDist = currentATR * 1.0 * STOP_ATR; // VIX mult 1.0
  const targetDist = currentATR * TGT_ATR / ATR_SCALE * ATR_SCALE; // target on scaled ATR, mirrors gold harness
  const entry = short ? price - SLIP : price + SLIP;
  const hardStop = short ? price + stopDist : price - stopDist;
  const target = short ? price - targetDist : price + targetDist;
  const riskDollars = stopDist * S.ptVal;
  const entryTime = bar.t + 300000;
  while (m1Cursor < m1.length && m1[m1Cursor].t < entryTime) m1Cursor++;
  let peak = 0, reachedBE = false, trail: number | null = null, atrNow = currentATR;
  let exited: { px: number; why: string; k: number } | null = null;
  for (let k = m1Cursor; k < m1.length && !exited; k++) {
    const b1 = m1[k];
    const s1 = sessionName(b1.hour, new Date(b1.t + etOffset(b1.t)).getUTCDay());
    const mins = (b1.t - entryTime) / 60000;
    if (sizeMult(s1) <= 0 && s1 !== "close") { exited = { px: short ? b1.c + SLIP : b1.c - SLIP, why: "session_close", k }; break; }
    if (trail != null && (short ? b1.h >= trail : b1.l <= trail)) exited = { px: (short ? Math.max(trail, b1.o) + S.tick : Math.min(trail, b1.o) - S.tick), why: "trail", k };
    else if (reachedBE && (short ? b1.h >= entry : b1.l <= entry)) exited = { px: short ? entry + S.tick : entry - S.tick, why: "be", k };
    else if (short ? b1.h >= hardStop : b1.l <= hardStop) exited = { px: (short ? Math.max(hardStop, b1.o) + S.tick : Math.min(hardStop, b1.o) - S.tick), why: "stop", k };
    if (!exited && (short ? b1.l <= target : b1.h >= target)) exited = { px: target, why: "target", k };
    if (exited) break;
    const diffBest = short ? entry - b1.l : b1.h - entry;
    if (diffBest > peak) peak = diffBest;
    if (!reachedBE && peak >= stopDist * BREAKEVEN_R) reachedBE = true;
    if (peak >= stopDist * TRAIL_R) {
      if (k % 5 === 0) { const j = Math.min(i + Math.floor(mins / 5), m5.length - 1); atrNow = (atrOf(m5.slice(Math.max(0, j - BUFFER + 1), j + 1)) * ATR_SCALE) || atrNow; }
      let raw = short ? b1.l + atrNow * TRAIL_ATR_MULT : b1.h - atrNow * TRAIL_ATR_MULT;
      if (peak >= stopDist) { const lock = short ? entry - peak * LOCK : entry + peak * LOCK; raw = short ? Math.min(raw, lock) : Math.max(raw, lock); }
      if (trail == null || (short ? raw < trail : raw > trail)) trail = raw;
    }
    const diffNow = short ? entry - b1.c : b1.c - entry;
    if (mins >= STALE_MIN && diffNow < stopDist && !reachedBE) { exited = { px: short ? b1.c + S.tick : b1.c - S.tick, why: "time", k }; break; }
  }
  if (!exited) break;
  const pnl = (short ? entry - exited.px : exited.px - entry) * S.ptVal - COMMISSION;
  trades.push({ dayISO: bar.dayISO, session, dir, pnl, r: pnl / riskDollars });
  const exitT = m1[Math.min(exited.k, m1.length - 1)].t;
  while (i + 1 < m5.length && m5[i + 1].t <= exitT) i++;
}

// report: session × direction grid with train/test halves
console.log(`\n${S.label}   ${m5[0]?.dayISO} → ${m5[m5.length - 1]?.dayISO}   trades=${trades.length}`);
const cells: Record<string, T[]> = {};
for (const t of trades) (cells[`${t.dir}|${t.session}`] ??= []).push(t);
const pf = (a: T[]) => { const g = a.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0), l = Math.abs(a.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0)); return l > 0 ? g / l : Infinity; };
const line = (label: string, a: T[]) => {
  if (a.length < 20) return;
  const h = Math.floor(a.length / 2), tr = pf(a.slice(0, h)), te = pf(a.slice(h));
  const net = a.reduce((s, t) => s + t.pnl, 0);
  const win = a.filter(t => t.pnl > 0).length / a.length;
  const qual = pf(a) > 1.15 && tr > 1.0 && te > 1.0 && a.length >= 60 ? "  ✅ QUALIFIES (demo-trial bar)" : "";
  console.log(`  ${label.padEnd(24)} n=${String(a.length).padStart(4)}  win ${(win * 100).toFixed(0).padStart(3)}%  PF ${pf(a).toFixed(2).padStart(5)}  net $${net.toFixed(0).padStart(7)}  | ${tr.toFixed(2)} / ${te.toFixed(2)}${qual}`);
};
line("ALL", trades);
for (const dir of ["long", "short"]) {
  const dt = trades.filter(t => t.dir === dir); line(`all ${dir}`, dt);
  for (const s of ["morning", "midday", "afternoon", "close", "eth_evening", "eth_asia", "eth_europe", "pre_market", "open"]) line(`  ${dir} ${s}`, cells[`${dir}|${s}`] ?? []);
}
