/**
 * GAP-FILL VALIDATION — engine-exact, the last unexplored setup with a live signal.
 *
 * WHY: the shadow tracker recorded 50 refused `gap_fill` setups in 8 days worth +$1,542 counterfactual
 * (MNQ +$1,337/27, MES +$250/10, MGC +$48/13). That is the only untested thing in the book with a
 * signal that size, and it is the one honest route to MORE TRADES — re-enabling the losing session
 * halves is not.
 *
 * ⚠️ THE SHADOW NUMBER IS RECORDED TOO EARLY TO TRUST. recordDecision() for an edge-gate refusal fires
 * at futures-realtime.ts:3317. The R:R >= 2.0 gate lives at :3545 — 228 lines LATER, inside sizing. So
 * every gap_fill row in that +$1,542 was captured BEFORE the engine would have checked R:R, and
 * gap-fill geometry makes that check brutal:
 *     stop   = |openingGap| * 1.5           (fixed at the open)
 *     target = |price - prevDayClose| * 0.8 (shrinks as price fills the gap)
 *     R:R >= 2  <=>  |price - PDC| >= 3.75 * |openingGap|
 * i.e. price must run to nearly 4x the gap AWAY from the previous close before the trade is allowed —
 * the opposite of a gap FILL. This script therefore reports both: what the setup does raw, and what
 * survives the R:R gate the engine actually applies.
 *
 * FIDELITY — copied from src/services/futures-realtime.ts, line-checked:
 *   ENTRY (":2838-2870"): barCount 1..6 of the RTH session AND session in {open, morning};
 *     gap = firstSessionBar.open - prevDayClose; 1 < |gap| < GAP_THRESHOLD (ES/MES 10, NQ/MNQ 50,
 *     GC/MGC 15); direction FADES the gap; stop = |gap|*1.5; target = |price-PDC|*0.8;
 *     requires target > currentATR*0.3.
 *   SCORE (scoreSetup, base 75): trend15Aligns is HARDCODED TRUE for gap fills (+10), rsiExtreme
 *     false, priceAboveVWAP false, dayTypeMatch true, session prime +5/good +0/avoid -10,
 *     vol +8 surge / +5 declining / -5 dry. Gate >= 75. NOTE there is no volTrend!=="surge" veto here
 *     (unlike the RSI bounce), so gap fill scores >= 85 essentially always — it is NOT score-limited.
 *   LIVE SESSION GATE (getSizeMultiplier): live INDEX gets 1.0 only in morning/afternoon; "open"
 *     (09:30-09:45) returns 0. So on live the eligible bars are barCount 4..6 (09:45-10:00) only.
 *     G_ALLOW_OPEN=1 relaxes this to see what the 09:30-09:45 bars would have added.
 *   MANAGEMENT: identical to gold-edge-validation.ts — 0.6R breakeven, 1.1R trail (1.0x ATR index /
 *     1.5x metals), 65% profit-lock past 1R, 45-min stale exit, flat when the session window closes.
 *   COSTS: 1 tick adverse on entry and on market-type exits, target filled exactly, $2.02 round turn.
 *
 * Usage: npx tsx scripts/gapfill-validation.ts NQ|ES|GC
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const SYM = (process.argv[2] || "NQ").toUpperCase();
const ALLOW_OPEN = process.env.G_ALLOW_OPEN === "1";
const STALE_MIN = parseFloat(process.env.G_STALE || "") || 45;

const SPEC: Record<string, { pt: number; tick: number; gapMax: number; atrScale: number; trailMult: number }> = {
  NQ: { pt: 2, tick: 0.25, gapMax: 50, atrScale: 1.0, trailMult: 1.0 },   // -> MNQ
  ES: { pt: 5, tick: 0.25, gapMax: 10, atrScale: 1.0, trailMult: 1.0 },   // -> MES
  GC: { pt: 10, tick: 0.1, gapMax: 15, atrScale: 1.5, trailMult: 1.5 },   // -> MGC
};
const S = SPEC[SYM];
if (!S) { console.error(`unknown symbol ${SYM}`); process.exit(1); }
const COMMISSION = 2.02, BREAKEVEN_R = 0.6, TRAIL_R = 1.1, PROFIT_LOCK_FRAC = 0.65, BUFFER = 200;

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offCache = new Map<number, number>();
function etOffset(t: number): number {
  const hr = Math.floor(t / 3600000);
  const hit = offCache.get(hr); if (hit !== undefined) return hit;
  const p: any = {}; for (const x of etFmt.formatToParts(hr * 3600000)) p[x.type] = x.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute);
  const off = asUTC - hr * 3600000; offCache.set(hr, off); return off;
}
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; day: number; hour: number; dayISO: string }
function sessionName(hour: number, dow: number): string {
  if (dow === 6 || (dow === 5 && hour >= 17) || (dow === 0 && hour < 18)) return "halt";
  if (hour >= 17 && hour < 18) return "halt";
  if (hour >= 9.5 && hour < 9.75) return "open";
  if (hour >= 9.75 && hour < 12) return "morning";
  if (hour >= 12 && hour < 14) return "midday";
  if (hour >= 14 && hour < 15.75) return "afternoon";
  if (hour >= 15.75 && hour < 16) return "close";
  if (hour >= 16 && hour < 17) return "eth_evening";
  if (hour >= 18 && hour < 22) return "eth_evening";
  if (hour >= 22 || hour < 3) return "eth_asia";
  if (hour >= 3 && hour < 9) return "eth_europe";
  return "pre_market";
}
/** LIVE index sizing: morning/afternoon full, midday half, everything else BLOCKED (open included). */
function liveSizeMult(session: string): number {
  if (session === "morning" || session === "afternoon") return 1.0;
  if (session === "midday") return 0.5;
  if (ALLOW_OPEN && session === "open") return 1.0;
  return 0;
}
function atrOf(b: Bar[], p = 14): number {
  if (b.length < p + 1) return 0;
  let s = 0;
  for (let i = b.length - p; i < b.length; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / p;
}
function load(file: string): { m1: Bar[]; m5: Bar[] } {
  const lines = fs.readFileSync(new URL(file, ROOT), "utf8").split("\n");
  const m1: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i]; if (!row) continue;
    const f = row.split(","); const t = Date.parse(f[0]); const c = +f[7];
    if (!isFinite(t) || !isFinite(c) || c <= 0) continue;
    const etMs = t + etOffset(t); const day = Math.floor(etMs / 86400000);
    m1.push({ t, o: +f[4], h: +f[5], l: +f[6], c, v: +f[8] || 0, day, hour: (etMs - day * 86400000) / 3600000, dayISO: new Date(etMs).toISOString().slice(0, 10) });
  }
  const m5: Bar[] = []; let key = -1;
  for (const b of m1) {
    const k = Math.floor(b.t / 300000);
    if (k !== key) { key = k; m5.push({ ...b, t: k * 300000 }); }
    else { const j = m5.length - 1; if (b.h > m5[j].h) m5[j].h = b.h; if (b.l < m5[j].l) m5[j].l = b.l; m5[j].c = b.c; m5[j].v += b.v; }
  }
  return { m1, m5 };
}

interface T { dayISO: string; dir: "long" | "short"; pnl: number; r: number; exit: string; rr: number; passedRR: boolean }

function backtest(m1: Bar[], m5: Bar[]): T[] {
  const trades: T[] = [];
  // prevDayClose = last 5m close at/before 16:00 ET of the previous ET day with RTH data
  const rthClose = new Map<number, number>();
  for (const b of m5) if (b.hour >= 9.5 && b.hour <= 16) rthClose.set(b.day, b.c);
  // first RTH bar open + running barCount per day
  const firstOpen = new Map<number, number>(); const barIdx = new Map<number, number>();
  for (const b of m5) {
    if (b.hour < 9.5 || b.hour >= 16) continue;
    if (!firstOpen.has(b.day)) firstOpen.set(b.day, b.o);
    barIdx.set(b.t, (barIdx.get(b.day) ?? 0) + 1);
    barIdx.set(b.day, (barIdx.get(b.day) ?? 0) + 1);
  }
  // recompute barCount cleanly: nth RTH 5m bar of the day
  const nth = new Map<number, number>(); const counter = new Map<number, number>();
  for (const b of m5) {
    if (b.hour < 9.5 || b.hour >= 16) continue;
    const n = (counter.get(b.day) ?? 0) + 1; counter.set(b.day, n); nth.set(b.t, n);
  }
  const days = [...rthClose.keys()].sort((a, b) => a - b);
  const prevClose = new Map<number, number>();
  for (let i = 1; i < days.length; i++) prevClose.set(days[i], rthClose.get(days[i - 1])!);

  let m1Cursor = 0;
  for (let i = BUFFER; i < m5.length; i++) {
    const bar = m5[i];
    const n = nth.get(bar.t); if (!n || n < 1 || n > 6) continue;      // barCount 1..6
    const dow = new Date(bar.t + etOffset(bar.t)).getUTCDay();
    const session = sessionName(bar.hour, dow);
    if (session !== "open" && session !== "morning") continue;         // engine's own session gate
    const sizeMult = liveSizeMult(session); if (sizeMult <= 0) continue; // live can't trade "open"
    const pdc = prevClose.get(bar.day); const fo = firstOpen.get(bar.day);
    if (!pdc || !fo) continue;

    const gap = fo - pdc; const absGap = Math.abs(gap);
    if (!(absGap > 1 && absGap < S.gapMax)) continue;

    const buf = m5.slice(i - BUFFER + 1, i + 1);
    const rawATR = atrOf(buf); if (rawATR <= 0) continue;
    const currentATR = rawATR * S.atrScale;

    const price = bar.c;
    const dir: "long" | "short" = gap > 0 ? "short" : "long";
    const targetDist = Math.abs(price - pdc) * 0.8;
    const stopDist = absGap * 1.5;
    if (!(targetDist > currentATR * 0.3)) continue;

    // scoreSetup: base 75, aligns hardcoded TRUE (+10), rsiExtreme 0, session prime +5
    let volSum = 0; for (let j = buf.length - 21; j < buf.length - 1; j++) volSum += buf[j].v;
    const avgVol = volSum / 20; const volRatio = avgVol > 0 ? bar.v / avgVol : 1;
    const volTrend = volRatio > 2 ? "surge" : volRatio < 0.6 ? "dry" : volRatio < 0.8 ? "declining" : "normal";
    let score = 75 + 10;
    if (volTrend === "surge") score += 8; else if (volTrend === "declining") score += 5; else if (volTrend === "dry") score -= 5;
    score += sizeMult >= 1 ? 5 : sizeMult >= 0.5 ? 0 : -10;
    if (Math.max(0, Math.min(100, score)) < 75) continue;

    const rr = targetDist / stopDist;
    const passedRR = rr >= 2.0;                                        // engine gate at :3545

    const short = dir === "short";
    const entry = short ? price - S.tick : price + S.tick;
    const hardStop = short ? price + stopDist : price - stopDist;
    const target = short ? price - targetDist : price + targetDist;
    const riskDollars = stopDist * S.pt;
    const entryTime = bar.t + 300000;
    while (m1Cursor < m1.length && m1[m1Cursor].t < entryTime) m1Cursor++;

    let peak = 0, reachedBE = false, trail: number | null = null, atrNow = currentATR;
    let exited: { px: number; why: string; k: number } | null = null;
    for (let k = m1Cursor; k < m1.length && !exited; k++) {
      const b1 = m1[k];
      const dow1 = new Date(b1.t + etOffset(b1.t)).getUTCDay();
      const s1 = sessionName(b1.hour, dow1);
      const mins = (b1.t - entryTime) / 60000;
      if (liveSizeMult(s1) <= 0 && s1 !== "close" && s1 !== "open") { exited = { px: short ? b1.c + S.tick : b1.c - S.tick, why: "session_close", k }; break; }
      if (trail != null && (short ? b1.h >= trail : b1.l <= trail)) exited = { px: (short ? Math.max(trail, b1.o) + S.tick : Math.min(trail, b1.o) - S.tick), why: "trail_stop", k };
      else if (reachedBE && (short ? b1.h >= entry : b1.l <= entry)) exited = { px: short ? entry + S.tick : entry - S.tick, why: "breakeven", k };
      else if (short ? b1.h >= hardStop : b1.l <= hardStop) exited = { px: (short ? Math.max(hardStop, b1.o) + S.tick : Math.min(hardStop, b1.o) - S.tick), why: "stop_loss", k };
      if (!exited && (short ? b1.l <= target : b1.h >= target)) exited = { px: target, why: "target", k };
      if (exited) break;
      const diffBest = short ? entry - b1.l : b1.h - entry;
      if (diffBest > peak) peak = diffBest;
      if (!reachedBE && peak >= stopDist * BREAKEVEN_R) reachedBE = true;
      if (peak >= stopDist * TRAIL_R) {
        if (k % 5 === 0) { const j = Math.min(i + Math.floor(mins / 5), m5.length - 1); atrNow = (atrOf(m5.slice(Math.max(0, j - BUFFER + 1), j + 1)) * S.atrScale) || atrNow; }
        let raw = short ? b1.l + atrNow * S.trailMult : b1.h - atrNow * S.trailMult;
        if (peak >= stopDist) { const lock = short ? entry - peak * PROFIT_LOCK_FRAC : entry + peak * PROFIT_LOCK_FRAC; raw = short ? Math.min(raw, lock) : Math.max(raw, lock); }
        if (trail == null || (short ? raw < trail : raw > trail)) trail = raw;
      }
      const diffNow = short ? entry - b1.c : b1.c - entry;
      if (mins >= STALE_MIN && diffNow < stopDist && !reachedBE) { exited = { px: short ? b1.c + S.tick : b1.c - S.tick, why: "time_exit", k }; break; }
    }
    if (!exited) break;
    const pnl = (short ? entry - exited.px : exited.px - entry) * S.pt - COMMISSION;
    trades.push({ dayISO: bar.dayISO, dir, pnl, r: pnl / riskDollars, exit: exited.why, rr, passedRR });
    const exitT = m1[Math.min(exited.k, m1.length - 1)].t;
    while (i + 1 < m5.length && m5[i + 1].t <= exitT) i++;
  }
  return trades;
}

function stats(t: T[]) {
  if (!t.length) return null;
  const w = t.filter(x => x.pnl > 0), l = t.filter(x => x.pnl < 0);
  const gp = w.reduce((s, x) => s + x.pnl, 0), gl = Math.abs(l.reduce((s, x) => s + x.pnl, 0));
  const net = t.reduce((s, x) => s + x.pnl, 0);
  return { n: t.length, win: w.length / t.length, pf: gl === 0 ? Infinity : gp / gl, avg: net / t.length, net };
}
const f = (s: ReturnType<typeof stats>) => s ? `n=${String(s.n).padStart(4)} win ${(s.win * 100).toFixed(0).padStart(3)}% PF ${(s.pf === Infinity ? 99 : s.pf).toFixed(2).padStart(5)} avg$${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(2)} net$${s.net.toFixed(0)}` : "—";

const { m1, m5 } = load(`data/${SYM}_1m.csv`);
const all = backtest(m1, m5);
const W = 104;
console.log(`GAP FILL (${SYM} → micro, $${S.pt}/pt) — engine-exact, full trade management, ${m5.length} 5-min bars`);
console.log(`${m5[0]?.dayISO} → ${m5[m5.length - 1]?.dayISO} · gap band 1–${S.gapMax} pts · stale ${STALE_MIN}min · live session gate${ALLOW_OPEN ? " RELAXED (open allowed)" : " (09:45–10:00 only)"}`);
if (!all.length) { console.log("\n  NO TRADES — setup never fired under the engine's own conditions."); process.exit(0); }
const days = [...new Set(all.map(t => t.dayISO))].sort();
const cut = days[Math.floor(days.length / 2)];
const half = (t: T[], first: boolean) => t.filter(x => first ? x.dayISO <= cut : x.dayISO > cut);

console.log("\n" + "═".repeat(W));
console.log("  RAW SETUP — every gap fill that clears the confluence gate (ignores the engine's R:R check)");
console.log("═".repeat(W));
console.log("  FULL : " + f(stats(all)));
console.log("  TRAIN: " + f(stats(half(all, true))));
const trS = stats(half(all, true)), teS = stats(half(all, false));
console.log("  TEST : " + f(teS) + (trS && teS && trS.avg > 0 && teS.avg > 0 ? "   <<< POSITIVE IN BOTH HALVES" : "   <<< fails both-halves"));
for (const d of ["long", "short"] as const) console.log(`  ${d.padEnd(6)}: ` + f(stats(all.filter(t => t.dir === d))));

const passed = all.filter(t => t.passedRR);
console.log("\n" + "═".repeat(W));
console.log("  WHAT THE ENGINE WOULD ACTUALLY TAKE — after the R:R >= 2.0 gate at futures-realtime.ts:3545");
console.log("═".repeat(W));
console.log(`  ${passed.length} of ${all.length} signals clear R:R >= 2.0 (${(100 * passed.length / all.length).toFixed(1)}%)`);
if (passed.length) {
  console.log("  FULL : " + f(stats(passed)));
  console.log("  TRAIN: " + f(stats(half(passed, true))));
  const a = stats(half(passed, true)), b = stats(half(passed, false));
  console.log("  TEST : " + f(b) + (a && b && a.avg > 0 && b.avg > 0 ? "   <<< POSITIVE IN BOTH HALVES" : "   <<< fails both-halves"));
  for (const d of ["long", "short"] as const) console.log(`  ${d.padEnd(6)}: ` + f(stats(passed.filter(t => t.dir === d))));
} else {
  console.log("  → the engine would take NONE of them. The shadow tracker's counterfactual is recorded at");
  console.log("    line 3317, 228 lines BEFORE this gate, so it counts trades that could never have fired.");
}
const rrs = all.map(t => t.rr).sort((a, b) => a - b);
console.log(`\n  R:R distribution — median ${rrs[Math.floor(rrs.length / 2)].toFixed(2)} · p90 ${rrs[Math.floor(rrs.length * 0.9)].toFixed(2)} · max ${rrs[rrs.length - 1].toFixed(2)} (need 2.00)`);
const byExit: Record<string, { n: number; net: number }> = {};
for (const t of all) { byExit[t.exit] ??= { n: 0, net: 0 }; byExit[t.exit].n++; byExit[t.exit].net += t.pnl; }
console.log("  exits: " + Object.entries(byExit).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ${v.n} ($${v.net.toFixed(0)})`).join(" | "));
console.log(`  trades/week: ${(all.length / (days.length / 5)).toFixed(1)} raw · ${(passed.length / (days.length / 5)).toFixed(1)} after R:R`);
