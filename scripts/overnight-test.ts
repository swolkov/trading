/**
 * OVERNIGHT-HOLD strategy backtest — the EXACT strategy we'd deploy live on micros.
 * Long 1 micro at the US cash close (~16:00 ET), exit at the cash open (~09:30 ET). 3yr 1m data.
 * Reports real $ P&L per micro, Sharpe, drawdown, by-year, win% — AND the reality on a $1K account.
 *   npx tsx scripts/overnight-test.ts
 */
import fs from "node:fs";

function nthSundayUTC(y: number, mo: number, n: number, h: number): number {
  const first = new Date(Date.UTC(y, mo, 1));
  return Date.UTC(y, mo, ((7 - first.getUTCDay()) % 7 + 1) + (n - 1) * 7, h);
}
function etParts(ms: number) {
  const y = new Date(ms).getUTCFullYear();
  const edt = ms >= nthSundayUTC(y, 2, 2, 7) && ms < nthSundayUTC(y, 10, 1, 6);
  const et = new Date(ms + (edt ? -4 : -5) * 3600_000);
  return { etMin: et.getUTCHours() * 60 + et.getUTCMinutes(), day: et.toISOString().slice(0, 10) };
}
function nearest(arr: { m: number; c: number }[], t: number, tol = 25): number | null {
  let best: number | null = null, bd = 1e9;
  for (const p of arr) { const d = Math.abs(p.m - t); if (d < bd && d <= tol) { bd = d; best = p.c; } }
  return best;
}

const MICRO: Record<string, { sym: string; mult: number }> = { ES: { sym: "MES", mult: 5 }, NQ: { sym: "MNQ", mult: 2 }, GC: { sym: "MGC", mult: 10 } };
const COMM = 1.0; // per side, micro futures (Tradovate ~$0.35-0.85 + fees; conservative)

function run(base: string) {
  const rows = fs.readFileSync(new URL(`../data/${base}_1m.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
  const byDay = new Map<string, { m: number; c: number }[]>();
  for (const r of rows) { const x = r.split(","); const c = +x[7]; if (!isFinite(c)) continue; const p = etParts(new Date(x[0]).getTime()); (byDay.get(p.day) ?? byDay.set(p.day, []).get(p.day)!).push({ m: p.etMin, c }); }
  const days = [...byDay.keys()].sort();
  const ref = new Map<string, { open: number | null; close: number | null }>();
  for (const d of days) { const a = byDay.get(d)!; ref.set(d, { open: nearest(a, 570), close: nearest(a, 960) }); }
  const m = MICRO[base];
  const pnls: { year: number; pnl: number }[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = ref.get(days[i - 1])!, cur = ref.get(days[i])!;
    if (prev.close && cur.open) pnls.push({ year: +days[i].slice(0, 4), pnl: (cur.open - prev.close) * m.mult - 2 * COMM });
  }
  return { m, pnls };
}

function stats(pnls: number[]) {
  const n = pnls.length, tot = pnls.reduce((s, v) => s + v, 0), wins = pnls.filter(v => v > 0).length;
  const mean = tot / n, sd = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1e-9;
  let eq = 0, peak = 0, dd = 0; for (const v of pnls) { eq += v; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return { n, tot, mean, sharpe: (mean / sd) * Math.sqrt(252), maxDD: dd, win: wins / n };
}

function main() {
  console.log("\n" + "═".repeat(80));
  console.log("  OVERNIGHT-HOLD STRATEGY — long 1 micro at US close, exit at US open (3yr, after commission)");
  console.log("═".repeat(80));
  for (const base of ["ES", "NQ", "GC"]) {
    try {
      const { m, pnls } = run(base);
      const s = stats(pnls.map(p => p.pnl));
      const years = [...new Set(pnls.map(p => p.year))].sort();
      console.log(`\n  ${m.sym} (1 contract, $${m.mult}/pt):`);
      console.log(`    nights ${s.n}  win ${(s.win * 100).toFixed(0)}%  total $${s.tot.toFixed(0)}  avg $${s.mean.toFixed(1)}/night  Sharpe ${s.sharpe.toFixed(2)}  maxDD $${s.maxDD.toFixed(0)}`);
      console.log(`    by year: ${years.map(y => { const ys = stats(pnls.filter(p => p.year === y).map(p => p.pnl)); return `${String(y).slice(2)} $${ys.tot.toFixed(0)}`; }).join("  ")}`);
      console.log(`    on a $1K account: avg ${(s.mean / 1000 * 100).toFixed(2)}%/night, worst drawdown ${(s.maxDD / 1000 * 100).toFixed(0)}%, ~$${(s.tot / 3).toFixed(0)}/yr`);
    } catch (e) { console.log(`  ${base}: ${e instanceof Error ? e.message : e}`); }
  }
  console.log("\n  ⚠️ Long-only drift in a 3yr BULL sample — in a bear market overnight gaps DOWN. Directional + gap risk.");
  console.log("═".repeat(80) + "\n");
}
main();
