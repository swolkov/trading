/**
 * COMBINED MULTI-STRATEGY — the real way to a "crazy" edge: stack UNCORRELATED edges so the
 * portfolio Sharpe (return ÷ risk) jumps, which lets you safely size up and make a lot.
 * Combines the validated SPREAD edge + diversified TREND edge, 15yr daily, monthly returns.
 *   npx tsx scripts/combined-test.ts
 */
import fs from "node:fs";

const dir = new URL("../data/daily/", import.meta.url);
function loadClose(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  try {
    for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) {
      const c = r.split(","); const px = +c[7]; if (isFinite(px) && px > 0) m.set(c[0].slice(0, 10), px);
    }
  } catch { }
  return m;
}
function loadOHLC(sym: string) {
  const out: { d: string; h: number; l: number; c: number }[] = [];
  try {
    for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) {
      const x = r.split(","); const h = +x[5], l = +x[6], c = +x[7]; if (isFinite(c) && c > 0) out.push({ d: x[0].slice(0, 10), h, l, c });
    }
  } catch { }
  return out;
}
const addM = (m: Map<string, number>, day: string, R: number) => m.set(day.slice(0, 7), (m.get(day.slice(0, 7)) ?? 0) + R);

// STRATEGY 1 — spread z-score reversion (R per trade, by month)
function spreadMonthly(): Map<string, number> {
  const out = new Map<string, number>();
  const basket = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["6E", "6B"], ["GC", "PL"], ["GC", "SI"]];
  for (const [a, b] of basket) {
    const A = loadClose(a), B = loadClose(b); const dates = [...A.keys()].filter(d => B.has(d)).sort();
    if (dates.length < 120) continue;
    const ratio = dates.map(d => A.get(d)! / B.get(d)!);
    let pos: { dir: number; entry: number; fs: number; i: number } | null = null;
    for (let i = 60; i < ratio.length; i++) {
      const w = ratio.slice(i - 60, i), mean = w.reduce((s, v) => s + v, 0) / 60;
      const sd = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / 60) || 1e-9, z = (ratio[i] - mean) / sd;
      if (pos) {
        const exit = (pos.dir === -1 ? z <= 0 : z >= 0) || Math.abs(z) >= 3.5 || i - pos.i >= 40;
        if (exit) { addM(out, dates[i], (pos.dir * (ratio[i] - pos.entry) / pos.entry) / (1.5 * pos.fs)); pos = null; }
      }
      if (!pos) { if (z > 2) pos = { dir: -1, entry: ratio[i], fs: sd / mean, i }; else if (z < -2) pos = { dir: 1, entry: ratio[i], fs: sd / mean, i }; }
    }
  }
  return out;
}

// STRATEGY 2 — diversified Donchian trend (R per trade, by month)
function trendMonthly(): Map<string, number> {
  const out = new Map<string, number>();
  const files = fs.readdirSync(dir).filter(f => f.endsWith("_1d.csv"));
  for (const f of files) {
    const bars = loadOHLC(f.replace("_1d.csv", "")); if (bars.length < 80) continue;
    const atr = (i: number) => { let s = 0; for (let j = i - 19; j <= i; j++) s += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c)); return s / 20; };
    let pos: { dir: number; entry: number; stop: number; risk: number; d: string } | null = null;
    for (let i = 50; i < bars.length; i++) {
      const b = bars[i];
      const hiN = Math.max(...bars.slice(i - 50, i).map(x => x.h)), loN = Math.min(...bars.slice(i - 50, i).map(x => x.l));
      const hiX = Math.max(...bars.slice(i - 20, i).map(x => x.h)), loX = Math.min(...bars.slice(i - 20, i).map(x => x.l)), a = atr(i);
      if (pos) {
        const lg = pos.dir === 1; let ex: number | null = null;
        if (lg && b.l <= pos.stop) ex = pos.stop; else if (!lg && b.h >= pos.stop) ex = pos.stop;
        else if (lg && b.c < loX) ex = b.c; else if (!lg && b.c > hiX) ex = b.c;
        if (ex !== null) { addM(out, b.d, (lg ? ex - pos.entry : pos.entry - ex) / pos.risk); pos = null; }
      }
      if (!pos && a > 0) { if (b.c > hiN) pos = { dir: 1, entry: b.c, stop: b.c - 2 * a, risk: 2 * a, d: b.d }; else if (b.c < loN) pos = { dir: -1, entry: b.c, stop: b.c + 2 * a, risk: 2 * a, d: b.d }; }
    }
  }
  return out;
}

function stats(monthlyR: number[], risk: number) {
  const r = monthlyR.map(x => x * risk), n = r.length;
  const mean = r.reduce((s, v) => s + v, 0) / n, sd = Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1e-9;
  let eq = 1, peak = 1, dd = 0; for (const x of r) { eq *= 1 + x; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
  return { annRet: mean * 12, annVol: sd * Math.sqrt(12), sharpe: (mean * 12) / (sd * Math.sqrt(12)), maxDD: dd };
}
function corr(a: number[], b: number[]) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return cov / (Math.sqrt(va * vb) || 1e-9);
}

function main() {
  const S = spreadMonthly(), T = trendMonthly();
  const months = [...new Set([...S.keys(), ...T.keys()])].sort();
  const sArr = months.map(m => S.get(m) ?? 0), tArr = months.map(m => T.get(m) ?? 0);
  console.log("\n" + "═".repeat(80));
  console.log("  COMBINED MULTI-STRATEGY — stacking uncorrelated edges to raise Sharpe (15yr, monthly)");
  console.log("═".repeat(80));
  const pct = (x: number) => (x * 100).toFixed(0) + "%";
  const row = (label: string, arr: number[], risk: number) => { const s = stats(arr, risk); console.log(`  ${label.padEnd(26)} return ${pct(s.annRet).padStart(5)}/yr   vol ${pct(s.annVol).padStart(5)}   Sharpe ${s.sharpe.toFixed(2)}   maxDD ${pct(s.maxDD).padStart(5)}`); };

  console.log("\n  ── each edge ALONE (@1% risk/trade) ──");
  row("Spreads only", sArr, 0.01);
  row("Trend-following only", tArr, 0.01);
  console.log(`\n  correlation(spreads, trend) = ${corr(sArr, tArr).toFixed(2)}   ← low/negative = the free lunch`);

  const combo = months.map((_, i) => 0.5 * sArr[i] + 0.5 * tArr[i]); // 0.5% risk each = 1% total
  console.log("\n  ── COMBINED 50/50 (same 1% total risk) ──");
  row("Combined", combo, 0.01);

  // punchline: scale combined to a 20%-drawdown budget and see the return
  const base = stats(combo, 0.01); const spreadsAlone = stats(sArr, 0.01);
  const scaleTo20 = base.maxDD !== 0 ? (-0.20 / base.maxDD) : 1;
  console.log("\n  ── THE PAYOFF: higher Sharpe lets you safely size UP ──");
  console.log(`  Combined Sharpe ${base.sharpe.toFixed(2)} vs spreads-alone ${spreadsAlone.sharpe.toFixed(2)}.`);
  console.log(`  Sized to a 20% max-drawdown budget: combined makes ~${pct(base.annRet * scaleTo20)}/yr (at ${(0.01 * scaleTo20 * 100).toFixed(1)}% risk/trade).`);
  console.log("  → That's how you 'risk a decent amount to make a lot' — by raising Sharpe, not by gambling.");
  console.log("═".repeat(80) + "\n");
}
main();
