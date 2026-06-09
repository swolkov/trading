/**
 * GOLD EDGE VALIDATION — is the GC RSI "edge" real, and is it the CONFLUENCE FILTER that
 * carries it? The raw RSI signal was ~PF 0.85 OOS (no edge); backtest.ts's filtered version
 * showed OOS PF ~1.24. This isolates the filter's contribution by adding filters CUMULATIVELY
 * and watching the out-of-sample PF, with $-accurate costs and a bootstrap CI on the survivor.
 *
 * Filter levels (cumulative): L0 raw RSI → L1 +volume-not-surging → L2 +15m trend not opposing
 *                            → L3 +US active session. If OOS PF climbs L0→L3, the filter is the edge.
 *
 * $-accurate: GC mult $100/pt, tick 0.10, 1-tick adverse slippage/side + $2.50/side commission.
 * IS = 2023-2025, OOS = 2026 (held out). Verified fill logic (enter at close, exit only after entry).
 *
 * Run: node_modules/.bin/tsx scripts/validate-gold.ts
 */
import fs from "node:fs";

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
const MULT = 100, TICK = 0.10, COMM = 2.50, RSI_P = 14, ATR_P = 14, MAX_HOLD = 24;
const RSI_LO = 25, RSI_HI = 75, STOP_MULT = 1.5, TARGET_MULT = 3.5;
const SPLIT = Date.UTC(2026, 0, 1);

function loadCsv(path: string): Bar[] {
  const rows = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
  const out: Bar[] = [];
  for (const r of rows) { const c = r.split(","); const b = { t: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] }; if (isFinite(b.c) && b.c > 0 && isFinite(b.t)) out.push(b); }
  out.sort((a, z) => a.t - z.t); return out;
}
function build(m1: Bar[], stepMs: number): Bar[] {
  const map = new Map<number, Bar>();
  for (const b of m1) { const bk = Math.floor(b.t / stepMs) * stepMs; const ex = map.get(bk); if (!ex) map.set(bk, { t: bk, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; } }
  return [...map.values()].sort((a, z) => a.t - z.t);
}
function rsiAt(cl: number[], i: number, p = RSI_P): number | null { if (i < p) return null; let g = 0, l = 0; for (let k = i - p + 1; k <= i; k++) { const ch = cl[k] - cl[k - 1]; if (ch > 0) g += ch; else l -= ch; } if (l === 0) return g === 0 ? 50 : 100; const rs = (g / p) / (l / p); return 100 - 100 / (1 + rs); }
function atrAt(b: Bar[], i: number, p = ATR_P): number { if (i < p) return 0; let s = 0; for (let k = i - p + 1; k <= i; k++) s += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c)); return s / p; }
function ema(vals: number[], p: number): number[] { const k = 2 / (p + 1); const o = [vals[0]]; for (let i = 1; i < vals.length; i++) o.push(vals[i] * k + o[i - 1] * (1 - k)); return o; }
function lb(m1: Bar[], t: number): number { let lo = 0, hi = m1.length; while (lo < hi) { const m = (lo + hi) >> 1; if (m1[m].t < t) lo = m + 1; else hi = m; } return lo; }
function resolveExit(m1: Bar[], s: number, dir: "long" | "short", stop: number, target: number, maxT: number) {
  let last: Bar | null = null;
  for (let j = s; j < m1.length; j++) { const b = m1[j]; if (b.t > maxT) break; last = b; const hs = dir === "long" ? b.l <= stop : b.h >= stop; const ht = dir === "long" ? b.h >= target : b.l <= target; if (hs) return { px: stop, t: b.t }; if (ht) return { px: target, t: b.t }; }
  return last ? { px: last.c, t: last.t } : null;
}

// 15m trend at a given time: EMA9 vs EMA21 on 15m closes up to that time.
function trend15Map(m15: Bar[]): { t: number; trend: "up" | "down" | "flat" }[] {
  const cl = m15.map((b) => b.c); const e9 = ema(cl, 9), e21 = ema(cl, 21);
  return m15.map((b, i) => ({ t: b.t, trend: i < 21 ? "flat" : (e9[i] > e21[i] * 1.0005 ? "up" : e9[i] < e21[i] * 0.9995 ? "down" : "flat") as "up" | "down" | "flat" }));
}
function trendAt(tmap: { t: number; trend: string }[], t: number): string { // last 15m bar at/before t
  let lo = 0, hi = tmap.length - 1, ans = "flat"; while (lo <= hi) { const m = (lo + hi) >> 1; if (tmap[m].t <= t) { ans = tmap[m].trend; lo = m + 1; } else hi = m - 1; } return ans;
}

interface Trade { dir: "long" | "short"; netUSD: number; netR: number; year: number; t: number; }

function backtest(m1: Bar[], bars5: Bar[], m15: Bar[], level: number): Trade[] {
  const cl = bars5.map((b) => b.c);
  const tmap = trend15Map(m15);
  const trades: Trade[] = [];
  let blocked = 0;
  for (let i = Math.max(RSI_P, ATR_P) + 1; i < bars5.length; i++) {
    const bar = bars5[i];
    if (bar.t < blocked) continue;
    const r = rsiAt(cl, i); if (r == null) continue;
    const a = atrAt(bars5, i); if (a <= 0) continue;
    let dir: "long" | "short" | null = null;
    if (r <= RSI_LO) dir = "long"; else if (r >= RSI_HI) dir = "short"; else continue;

    // ── cumulative confluence filters ──
    if (level >= 1) { // L1: volume not surging
      const lookback = bars5.slice(Math.max(0, i - 20), i);
      const avgV = lookback.reduce((s, x) => s + x.v, 0) / Math.max(1, lookback.length);
      if (avgV > 0 && bar.v / avgV > 2) continue;
    }
    if (level >= 2) { // L2: 15m trend not opposing the reversion
      const tr = trendAt(tmap, bar.t);
      if (dir === "long" && tr === "down") continue;
      if (dir === "short" && tr === "up") continue;
    }
    if (level >= 3) { // L3: US active session (13:00–21:00 UTC ≈ 8a–4p ET)
      const hr = new Date(bar.t).getUTCHours();
      if (hr < 13 || hr >= 21) continue;
    }

    const entry = bar.c + (dir === "long" ? TICK : -TICK);  // 1-tick adverse
    const stopDist = STOP_MULT * a;
    const stop = dir === "long" ? entry - stopDist : entry + stopDist;
    const target = dir === "long" ? entry + TARGET_MULT * a : entry - TARGET_MULT * a;
    const ex = resolveExit(m1, lb(m1, bar.t + 300000), dir, stop, target, bar.t + 300000 + MAX_HOLD * 300000);
    if (!ex) continue;
    const exitPx = ex.px - (dir === "long" ? TICK : -TICK);  // 1-tick adverse
    const gross = (dir === "long" ? exitPx - entry : entry - exitPx) * MULT;
    const netUSD = gross - COMM * 2;
    const riskUSD = stopDist * MULT;
    trades.push({ dir, netUSD, netR: riskUSD > 0 ? netUSD / riskUSD : 0, year: new Date(bar.t).getUTCFullYear(), t: bar.t });
    blocked = ex.t;
  }
  return trades;
}

function stat(ts: Trade[]) {
  let gw = 0, gl = 0, w = 0, net = 0, sumR = 0;
  for (const t of ts) { net += t.netUSD; sumR += t.netR; if (t.netUSD > 0) { gw += t.netUSD; w++; } else gl += -t.netUSD; }
  return { n: ts.length, pf: gl > 0 ? gw / gl : gw > 0 ? 99 : 0, wr: ts.length ? w / ts.length : 0, net, sumR };
}
function bootCI(ts: Trade[]): [number, number] {
  const p = ts.map((t) => t.netUSD); let seed = 987654; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const out: number[] = [];
  for (let it = 0; it < 2000; it++) { let gw = 0, gl = 0; for (let k = 0; k < p.length; k++) { const x = p[(rnd() * p.length) | 0]; if (x > 0) gw += x; else gl += -x; } out.push(gl > 0 ? gw / gl : 99); }
  out.sort((a, b) => a - b); return [out[50], out[1949]];
}
const f = (s: ReturnType<typeof stat>) => `PF ${(s.pf === 99 ? "INF" : s.pf.toFixed(2)).padStart(5)} n${String(s.n).padStart(4)} win${(s.wr * 100).toFixed(0)}% net${(s.net >= 0 ? "+$" : "-$") + Math.abs(s.net).toFixed(0)}`;

function main() {
  console.log(`\n══ GOLD (GC) EDGE VALIDATION — does the confluence filter carry it? ══`);
  console.log(`  RSI ${RSI_LO}/${RSI_HI}, stop ${STOP_MULT}×ATR, target ${TARGET_MULT}×ATR | $${MULT}/pt, 1-tick slip + $${COMM}/side | IS 2023-25 / OOS 2026\n`);
  const m1 = loadCsv("data/GC_1m.csv");
  const bars5 = build(m1, 300000), m15 = build(m1, 900000);
  const labels = ["L0 raw RSI", "L1 +vol-not-surge", "L2 +15m trend", "L3 +US session"];
  let bestOOS: { lvl: number; ts: Trade[] } | null = null;
  for (let lvl = 0; lvl <= 3; lvl++) {
    const all = backtest(m1, bars5, m15, lvl);
    const is = stat(all.filter((t) => t.t < SPLIT)), oos = stat(all.filter((t) => t.t >= SPLIT));
    console.log(`  ${labels[lvl].padEnd(20)}  IS ${f(is)}   |   OOS ${f(oos)}`);
    if (oos.n >= 50 && (!bestOOS || oos.pf > stat(bestOOS.ts.filter((t) => t.t >= SPLIT)).pf)) bestOOS = { lvl, ts: all };
  }
  if (bestOOS) {
    const all = bestOOS.ts, oos = all.filter((t) => t.t >= SPLIT);
    const [lo, hi] = bootCI(oos);
    console.log(`\n  Best OOS = ${labels[bestOOS.lvl]}.  Bootstrap 95% CI on OOS PF: [${lo.toFixed(2)}, ${hi.toFixed(2)}]  ${lo > 1.0 ? "✓ floor > 1.0" : "✗ floor ≤ 1.0 (not demonstrated)"}`);
    console.log(`\n  By year (best filter level):`);
    for (const y of [2023, 2024, 2025, 2026]) { const s = stat(all.filter((t) => new Date(t.t).getUTCFullYear() === y)); if (s.n) console.log(`    ${y}: ${f(s)}  → ${(s.sumR).toFixed(1)}R  (≈${(s.sumR * 1).toFixed(0)}% annual at 1% risk/trade)`); }
    const totalR = stat(all).sumR;
    console.log(`\n  Total ${stat(all).n} trades / ~3yr: ${totalR.toFixed(0)}R. At SAFE 1% risk/trade ≈ ${(totalR).toFixed(0)}% over 3yr (${(totalR / 3).toFixed(0)}%/yr). Gold stop ≈ $${(STOP_MULT * 15 * MULT).toFixed(0)}/contract → needs ~$${Math.round(STOP_MULT * 15 * MULT / 0.01 / 1000)}k to size at 1%.`);
  }
  console.log("");
}
main();
