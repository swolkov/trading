/**
 * TREND-FOLLOWING TEST — the one real, directional edge class we never tested.
 * We tested INTRADAY trend-continuation (it loses). This is the academically-robust DAILY diversified
 * time-series-momentum premium (Moskowitz-Ooi-Pedersen 2012; the entire managed-futures industry).
 * Long markets trending up, short markets trending down, vol-targeted, diversified across 29 markets,
 * net of cost. Question: is there a real directional edge here a (scaled) micro-futures account could run?
 *   npx tsx scripts/trend-following-test.ts
 */
import fs from "node:fs";

const dir = new URL("../data/daily/", import.meta.url);
const MARKETS = ["ES", "NQ", "RTY", "YM", "ZB", "ZN", "ZF", "ZT", "6E", "6J", "6B", "6A", "6C", "6S", "CL", "NG", "RB", "HO", "GC", "SI", "HG", "PL", "ZC", "ZS", "ZW", "ZL", "ZM", "LE", "HE"];
const TARGET_VOL = 0.15;          // vol-target each leg to 15% annualized (equal risk)
const COST_BPS = 1.5;             // per unit of weight turnover (round-trip ~3bps) — conservative for daily TF
const MAXW = 2;                   // cap leverage per leg

function loadClose(sym: string): { d: string; p: number }[] {
  try {
    return fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)
      .map(r => { const c = r.split(","); return { d: c[0].slice(0, 10), p: +c[7] }; })
      .filter(x => isFinite(x.p) && x.p > 0);
  } catch { return []; }
}

// per-market daily strategy return series (signal × next-day return, vol-targeted, net cost), keyed by date
function stratReturns(sym: string, LB: number): Map<string, number> {
  const s = loadClose(sym); const out = new Map<string, number>();
  if (s.length < LB + 80) return out;
  const ret = s.map((x, i) => i === 0 ? 0 : x.p / s[i - 1].p - 1);
  let prevW = 0;
  for (let i = LB; i < s.length - 1; i++) {
    const mom = Math.sign(s[i].p / s[i - LB].p - 1);                         // trend signal
    const win = ret.slice(i - 60, i); const mu = win.reduce((a, b) => a + b, 0) / 60;
    const vol = Math.sqrt(win.reduce((a, b) => a + (b - mu) ** 2, 0) / 60) * Math.sqrt(252) || 1e-9;
    let w = mom * (TARGET_VOL / vol); w = Math.max(-MAXW, Math.min(MAXW, w));  // vol-target + cap
    const cost = (COST_BPS / 1e4) * Math.abs(w - prevW); prevW = w;
    out.set(s[i + 1].d, w * ret[i + 1] - cost);                              // next-day P&L net of turnover cost
  }
  return out;
}

function run(LB: number) {
  const series = MARKETS.map(m => stratReturns(m, LB)).filter(s => s.size > 100);
  const allDates = [...new Set(series.flatMap(s => [...s.keys()]))].sort();
  const port: { d: string; r: number }[] = [];
  for (const d of allDates) {
    const vals = series.map(s => s.get(d)).filter(v => v !== undefined) as number[];
    if (vals.length >= 8) port.push({ d, r: vals.reduce((a, b) => a + b, 0) / vals.length });  // equal-weight diversified
  }
  const rs = port.map(x => x.r);
  const mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mu) ** 2, 0) / rs.length) || 1e-9;
  const sharpe = (mu / sd) * Math.sqrt(252);
  const annRet = mu * 252 * 100;
  let cum = 1, peak = 1, mdd = 0; const byYear: Record<string, number> = {};
  for (const x of port) { cum *= 1 + x.r; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum / peak - 1); byYear[x.d.slice(0, 4)] = (byYear[x.d.slice(0, 4)] ?? 0) + x.r; }
  const yrs = Object.entries(byYear); const posYrs = yrs.filter(([, v]) => v > 0).length;
  return { LB, sharpe, annRet, mdd: mdd * 100, totRet: (cum - 1) * 100, posYrs, nYrs: yrs.length, nMkts: series.length, byYear };
}

console.log("\n" + "═".repeat(76));
console.log("  DIVERSIFIED DAILY TREND-FOLLOWING — 29-market basket, vol-targeted, net of cost");
console.log("═".repeat(76));
console.log(`  ${"lookback".padEnd(10)} ${"Sharpe".padStart(7)} ${"ann.ret".padStart(9)} ${"maxDD".padStart(8)} ${"+years".padStart(8)} ${"markets".padStart(8)}`);
let best: ReturnType<typeof run> | null = null;
for (const LB of [60, 120, 250]) {
  const r = run(LB);
  if (!best || r.sharpe > best.sharpe) best = r;
  console.log(`  ${`${LB}d`.padEnd(10)} ${r.sharpe.toFixed(2).padStart(7)} ${(r.annRet.toFixed(1) + "%").padStart(9)} ${(r.mdd.toFixed(0) + "%").padStart(8)} ${`${r.posYrs}/${r.nYrs}`.padStart(8)} ${String(r.nMkts).padStart(8)}`);
}
console.log("─".repeat(76));
const verdict = best!.sharpe > 0.5 && best!.posYrs / best!.nYrs > 0.6;
console.log(`  VERDICT: ${verdict ? "✅ REAL diversified trend edge (Sharpe " + best!.sharpe.toFixed(2) + ", " + best!.posYrs + "/" + best!.nYrs + " yrs positive)" : "❌ no robust edge (Sharpe " + best!.sharpe.toFixed(2) + ")"}`);
console.log(`  per-year (best lookback ${best!.LB}d): ${Object.entries(best!.byYear).map(([y, v]) => `${y.slice(2)}:${(v * 100).toFixed(0)}%`).join(" ")}`);
console.log("═".repeat(76) + "\n");
