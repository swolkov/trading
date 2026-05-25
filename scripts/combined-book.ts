/**
 * THE COMBINED BOOK — the two best validated, uncorrelated edges combined: SPREADS + OVERNIGHT.
 * Builds monthly return series for each over the common period (2023–2026), combines 50/50, and
 * reports per-sleeve + combined annualized return / Sharpe / maxDD + correlation + Monte Carlo.
 * This quantifies "the best system" — the deployment spec.   npx tsx scripts/combined-book.ts
 */
import fs from "node:fs";

const dailyDir = new URL("../data/daily/", import.meta.url);
function loadClose(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dailyDir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const px = +c[7]; if (isFinite(px) && px > 0) m.set(c[0].slice(0, 10), px); } } catch { }
  return m;
}
const inWindow = (d: string) => d >= "2023-01-01";
const addM = (m: Map<string, number>, day: string, R: number) => m.set(day.slice(0, 7), (m.get(day.slice(0, 7)) ?? 0) + R);

// SLEEVE 1 — SPREADS (z-score reversion on economically-linked pairs), monthly R, 2023+
function spreadMonthly(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [a, b] of [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["6E", "6B"]]) {
    const A = loadClose(a), B = loadClose(b); const dates = [...A.keys()].filter(d => B.has(d)).sort();
    if (dates.length < 120) continue;
    const ratio = dates.map(d => A.get(d)! / B.get(d)!);
    let pos: { dir: number; entry: number; fs: number; i: number } | null = null;
    for (let i = 60; i < ratio.length; i++) {
      const w = ratio.slice(i - 60, i), mean = w.reduce((s, v) => s + v, 0) / 60, sd = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / 60) || 1e-9, z = (ratio[i] - mean) / sd;
      if (pos && ((pos.dir === -1 ? z <= 0 : z >= 0) || Math.abs(z) >= 3.5 || i - pos.i >= 40)) { if (inWindow(dates[i])) addM(out, dates[i], (pos.dir * (ratio[i] - pos.entry) / pos.entry) / (1.5 * pos.fs)); pos = null; }
      if (!pos) { if (z > 2) pos = { dir: -1, entry: ratio[i], fs: sd / mean, i }; else if (z < -2) pos = { dir: 1, entry: ratio[i], fs: sd / mean, i }; }
    }
  }
  return out;
}

// SLEEVE 2 — OVERNIGHT (long close→open), monthly R (move / daily ATR), 2023+
function nthSun(y: number, mo: number, n: number, h: number) { const f = new Date(Date.UTC(y, mo, 1)); return Date.UTC(y, mo, ((7 - f.getUTCDay()) % 7 + 1) + (n - 1) * 7, h); }
function overnightMonthly(): Map<string, number> {
  const out = new Map<string, number>();
  for (const base of ["ES", "NQ", "GC"]) {
    const rows = fs.readFileSync(new URL(`../data/${base}_1m.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
    const byDay = new Map<string, { m: number; h: number; l: number; c: number }[]>();
    for (const r of rows) { const x = r.split(","); const c = +x[7]; if (!isFinite(c)) continue; const ms = new Date(x[0]).getTime(); const yy = new Date(ms).getUTCFullYear(); const edt = ms >= nthSun(yy, 2, 2, 7) && ms < nthSun(yy, 10, 1, 6); const d = new Date(ms + (edt ? -4 : -5) * 3600_000); const day = d.toISOString().slice(0, 10); const min = d.getUTCHours() * 60 + d.getUTCMinutes(); (byDay.get(day) ?? byDay.set(day, []).get(day)!).push({ m: min, h: +x[5], l: +x[6], c }); }
    const days = [...byDay.keys()].sort();
    const ref = new Map<string, { open: number | null; close: number | null }>();
    const nrest = (a: { m: number; c: number }[], t: number) => { let b: number | null = null, bd = 1e9; for (const p of a) { const dd = Math.abs(p.m - t); if (dd < bd && dd <= 25) { bd = dd; b = p.c; } } return b; };
    for (const d of days) { const a = byDay.get(d)!; ref.set(d, { open: nrest(a, 570), close: nrest(a, 960) }); }
    // daily ATR proxy from close-to-close
    const closes = days.map(d => ref.get(d)!.close).filter(Boolean) as number[];
    for (let i = 1; i < days.length; i++) {
      const prev = ref.get(days[i - 1])!, cur = ref.get(days[i])!;
      if (prev.close && cur.open && inWindow(days[i])) {
        const window = closes.slice(Math.max(0, i - 20), i); const atr = window.length > 1 ? window.reduce((s, v, k) => k ? s + Math.abs(v - window[k - 1]) : 0, 0) / (window.length - 1) : 1;
        addM(out, days[i], (cur.open - prev.close) / (atr || 1));
      }
    }
  }
  return out;
}

function stats(monthly: number[]) {
  const n = monthly.length, mean = monthly.reduce((s, v) => s + v, 0) / n, sd = Math.sqrt(monthly.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1e-9;
  let eq = 1, peak = 1, dd = 0; for (const r of monthly) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
  return { annRet: mean * 12, annVol: sd * Math.sqrt(12), sharpe: (mean * 12) / (sd * Math.sqrt(12)), maxDD: dd };
}
function corr(a: number[], b: number[]) { const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / (Math.sqrt(va * vb) || 1e-9); }

function main() {
  const RISK = 0.01; // 1% per trade-unit
  const S = spreadMonthly(), O = overnightMonthly();
  const months = [...new Set([...S.keys(), ...O.keys()])].sort();
  const sArr = months.map(m => (S.get(m) ?? 0) * RISK), oArr = months.map(m => (O.get(m) ?? 0) * RISK);
  const combo = months.map((_, i) => 0.5 * sArr[i] + 0.5 * oArr[i]);
  const pct = (x: number) => (x * 100).toFixed(0) + "%";
  console.log("\n" + "═".repeat(76));
  console.log("  THE COMBINED BOOK — spreads + overnight (best validated edges), 2023–2026 monthly");
  console.log("═".repeat(76));
  const row = (l: string, a: number[]) => { const s = stats(a); console.log(`  ${l.padEnd(22)} return ${pct(s.annRet).padStart(5)}/yr  vol ${pct(s.annVol).padStart(5)}  Sharpe ${s.sharpe.toFixed(2)}  maxDD ${pct(s.maxDD).padStart(5)}`); };
  row("Spreads sleeve", sArr); row("Overnight sleeve", oArr);
  console.log(`\n  correlation(spreads, overnight) = ${corr(sArr, oArr).toFixed(2)}   (low = diversification works)`);
  console.log("  ── COMBINED (50/50) ──"); row("COMBINED BOOK", combo);
  // Monte Carlo: resample months → annual outcome distribution
  let pPos = 0; const ann: number[] = [];
  for (let s = 0; s < 50000; s++) { let eq = 1; for (let k = 0; k < 12; k++) eq *= 1 + combo[(Math.random() * combo.length) | 0]; ann.push(eq - 1); if (eq > 1) pPos++; }
  ann.sort((a, b) => a - b);
  console.log(`\n  Monte Carlo (12-month, 50k sims): median ${pct(ann[25000])}  [5th ${pct(ann[2500])} … 95th ${pct(ann[47500])}]  P(profitable yr) ${(pPos / 50000 * 100).toFixed(0)}%`);
  console.log("═".repeat(76) + "\n");
}
main();
