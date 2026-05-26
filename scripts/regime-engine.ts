/**
 * REGIME ENGINE — detect when NOT to run the spread edge (it fails in panic/dislocation).
 * Multi-factor dislocation score (no single-VIX filter), trailing-z (no lookahead):
 *   F1 vol expansion · F2 cross-asset correlation spike · F3 trend persistence · F4 tail clustering.
 * Then: (A) COVID post-mortem, (B) regime stand-down test on the spread book (tail vs return cost).
 * Objective: cut the catastrophic left tail, accept lower Sharpe.   npx tsx scripts/regime-engine.ts
 */
import fs from "node:fs";
const dir = new URL("../data/daily/", import.meta.url);
function load(sym: string): Map<string, number> { const m = new Map<string, number>(); try { for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch { } return m; }
const cache = new Map<string, Map<string, number>>(); const L = (s: string) => cache.get(s) ?? cache.set(s, load(s)).get(s)!;
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length || 1)) || 1e-9; };

// ---- build the cross-asset basket return matrix on a common date axis ----
const BASKET = ["ES", "NQ", "CL", "GC", "ZN", "6E"];
function buildRegime() {
  const maps = BASKET.map(L);
  const dates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  const rets: number[][] = BASKET.map(() => []);   // daily log returns per asset
  for (let i = 1; i < dates.length; i++) for (let k = 0; k < BASKET.length; k++) rets[k].push(Math.log(maps[k].get(dates[i])! / maps[k].get(dates[i - 1])!));
  const D = dates.slice(1);
  // raw daily factors
  const F: { vx: number; corr: number; trend: number; tail: number }[] = [];
  for (let i = 0; i < D.length; i++) {
    if (i < 60) { F.push({ vx: 1, corr: 0, trend: 0, tail: 0 }); continue; }
    const v10 = mean(BASKET.map((_, k) => std(rets[k].slice(i - 10, i)))), v60 = mean(BASKET.map((_, k) => std(rets[k].slice(i - 60, i))));
    // avg pairwise correlation over last 20d
    let cs = 0, cn = 0; for (let a = 0; a < BASKET.length; a++) for (let b = a + 1; b < BASKET.length; b++) { const ra = rets[a].slice(i - 20, i), rb = rets[b].slice(i - 20, i), ma = mean(ra), mb = mean(rb); let cov = 0, va = 0, vb = 0; for (let j = 0; j < 20; j++) { cov += (ra[j] - ma) * (rb[j] - mb); va += (ra[j] - ma) ** 2; vb += (rb[j] - mb) ** 2; } cs += cov / (Math.sqrt(va * vb) || 1e-9); cn++; }
    // trend persistence: efficiency ratio over 10d (panic = trending = high)
    const trend = mean(BASKET.map((_, k) => { const seg = rets[k].slice(i - 10, i); const net = Math.abs(seg.reduce((s, v) => s + v, 0)); const path = seg.reduce((s, v) => s + Math.abs(v), 0) || 1e-9; return net / path; }));
    // tail clustering: fraction of basket-days with |ret|>2.5x its 60d vol in last 10d
    let th = 0, tn = 0; for (let k = 0; k < BASKET.length; k++) { const v = std(rets[k].slice(i - 60, i)); for (let j = i - 10; j < i; j++) { tn++; if (Math.abs(rets[k][j]) > 2.5 * v) th++; } }
    F.push({ vx: v10 / v60, corr: cs / cn, trend, tail: th / tn });
  }
  // composite dislocation = avg trailing-252d z of the 4 factors (no lookahead)
  const keys: (keyof typeof F[0])[] = ["vx", "corr", "trend", "tail"];
  const score: number[] = [], regime: string[] = [];
  for (let i = 0; i < F.length; i++) {
    if (i < 252) { score.push(0); regime.push("NORMAL"); continue; }
    const zs = keys.map(key => { const hist = F.slice(i - 252, i).map(f => f[key]); return (F[i][key] - mean(hist)) / std(hist); });
    const s = mean(zs); score.push(s);
    regime.push(s > 1.5 ? "DISLOCATION" : s > 0.75 ? "ELEVATED" : "NORMAL");
  }
  const byDate = new Map<string, { score: number; regime: string; f: typeof F[0] }>();
  D.forEach((d, i) => byDate.set(d, { score: score[i], regime: regime[i], f: F[i] }));
  return byDate;
}

// ---- spread trades (entry-dated) ----
const PAIRS: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["6E", "6B"], ["6A", "6C"], ["GC", "HG"]];
function trades(): { pair: string; R: number; date: string }[] {
  const out: { pair: string; R: number; date: string }[] = [];
  for (const [a, b] of PAIRS) { const A = L(a), B = L(b); const dts = [...A.keys()].filter(d => B.has(d)).sort(); if (dts.length < 110) continue; const ratio = dts.map(d => A.get(d)! / B.get(d)!); let pos: { dir: number; entry: number; fs: number; i: number; d: string } | null = null; for (let i = 60; i < ratio.length; i++) { const w = ratio.slice(i - 60, i), m = mean(w), sd = std(w), z = (ratio[i] - m) / sd; if (pos && ((pos.dir === -1 ? z <= 0 : z >= 0) || Math.abs(z) >= 3.5 || i - pos.i >= 40)) { out.push({ pair: `${a}/${b}`, R: (pos.dir * (ratio[i] - pos.entry) / pos.entry) / (1.5 * pos.fs), date: pos.d }); pos = null; } if (!pos) { if (z > 2) pos = { dir: -1, entry: ratio[i], fs: sd / m, i, d: dts[i] }; else if (z < -2) pos = { dir: 1, entry: ratio[i], fs: sd / m, i, d: dts[i] }; } } }
  return out;
}

function tailStats(rs: number[], cost = 0.10) {
  const net = rs.map(r => r - cost).filter(r => isFinite(r)); const s = [...net].sort((a, b) => a - b);
  const cvar = mean(s.slice(0, Math.max(1, Math.ceil(s.length * 0.05))));
  let eq = 0, peak = 0, dd = 0; for (const r of net) { eq += r; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return { n: net.length, avg: mean(net), worst: s[0] ?? 0, cvar, maxDD: dd };
}

function main() {
  const reg = buildRegime(); const t = trades();
  console.log("\n" + "═".repeat(82));
  console.log("  REGIME ENGINE — detecting when NOT to run the spread edge");
  console.log("═".repeat(82));

  // ---- A. COVID POST-MORTEM ----
  console.log("\n  A. COVID POST-MORTEM (regime factors by month — was the dislocation detectable early?)");
  console.log(`     month     volExp  crossCorr  trendPers  dislocScore  regime`);
  for (const m of ["2020-01", "2020-02", "2020-03", "2020-04", "2020-05", "2020-06"]) {
    const days = [...reg.entries()].filter(([d]) => d.slice(0, 7) === m); if (!days.length) continue;
    const f = days.map(([, v]) => v.f), sc = mean(days.map(([, v]) => v.score));
    const worstReg = days.map(([, v]) => v.regime).includes("DISLOCATION") ? "DISLOCATION" : days.map(([, v]) => v.regime).includes("ELEVATED") ? "ELEVATED" : "NORMAL";
    console.log(`     ${m}    ${mean(f.map(x => x.vx)).toFixed(2).padStart(5)}    ${mean(f.map(x => x.corr)).toFixed(2).padStart(5)}     ${mean(f.map(x => x.trend)).toFixed(2).padStart(5)}      ${sc.toFixed(2).padStart(5)}      ${worstReg}`);
  }
  console.log("\n  COVID per-pair damage (net avg R @0.10 cost, Feb–Apr 2020):");
  for (const [a, b] of PAIRS) { const ct = t.filter(x => x.pair === `${a}/${b}` && x.date >= "2020-02-01" && x.date <= "2020-04-30"); if (ct.length) console.log(`     ${`${a}/${b}`.padEnd(8)} n=${String(ct.length).padStart(2)}  ${mean(ct.map(x => x.R - 0.10)) >= 0 ? "+" : ""}${mean(ct.map(x => x.R - 0.10)).toFixed(2)}R`); }

  // ---- B. STAND-DOWN TEST ----
  console.log("\n  B. REGIME STAND-DOWN — apply size mult by entry regime (NORMAL 1.0 / ELEVATED 0.5 / DISLOCATION 0.0)");
  const base = t.map(x => x.R), filtered: number[] = [];
  let skipped = 0, halved = 0;
  for (const x of t) { const r = reg.get(x.date); const m = !r ? 1 : r.regime === "DISLOCATION" ? 0 : r.regime === "ELEVATED" ? 0.5 : 1; if (m === 0) skipped++; else if (m === 0.5) halved++; if (m > 0) filtered.push(x.R * m); }
  const bs = tailStats(base), fs = tailStats(filtered);
  console.log(`     trades: ${skipped} stood down (dislocation), ${halved} half-sized (elevated), rest full`);
  console.log(`     ${"".padEnd(14)} avg R   worst   CVaR(5%)  maxDD`);
  console.log(`     baseline      ${bs.avg >= 0 ? "+" : ""}${bs.avg.toFixed(3)}  ${bs.worst.toFixed(1)}   ${bs.cvar.toFixed(2)}    ${bs.maxDD.toFixed(0)}R`);
  console.log(`     regime-filtered ${fs.avg >= 0 ? "+" : ""}${fs.avg.toFixed(3)}  ${fs.worst.toFixed(1)}   ${fs.cvar.toFixed(2)}    ${fs.maxDD.toFixed(0)}R`);
  // COVID-window comparison
  const covBase = t.filter(x => x.date >= "2020-02-01" && x.date <= "2020-04-30").map(x => x.R - 0.10);
  const covFilt = t.filter(x => x.date >= "2020-02-01" && x.date <= "2020-04-30").map(x => { const r = reg.get(x.date); const m = !r ? 1 : r.regime === "DISLOCATION" ? 0 : r.regime === "ELEVATED" ? 0.5 : 1; return (x.R - 0.10) * m; });
  console.log(`     COVID window total R:  baseline ${covBase.reduce((s, v) => s + v, 0).toFixed(1)}R  →  regime-filtered ${covFilt.reduce((s, v) => s + v, 0).toFixed(1)}R`);
  console.log("\n" + "═".repeat(82) + "\n");
}
main();
