/**
 * EDGE-HUNTER — rigorously search the free 16yr cross-asset data for NEW tradeable edge in NQ,
 * with strict out-of-sample validation and honest multiple-testing accounting.
 *
 * Question: does any market's recent move (intermarket lead-lag) or any regime condition predict
 * NQ's NEXT-DAY return — at a horizon we can actually trade? Method (no peeking):
 *   • build candidate predictors per day from the cross-asset basket (lag-1 return, 5d momentum)
 *     + NQ's own state (regime, vol bucket, risk tone)
 *   • split TIME-ORDERED: first 70% = train (pick direction), last 30% = out-of-sample (judge)
 *   • a predictor "works" ONLY if its OOS t-stat clears the multiple-testing bar (Bonferroni)
 * This is how agents get smarter honestly — validated research, not live overfitting. Anything that
 * survives is a candidate to feed the engine; if NOTHING survives, that's the honest answer too.
 *
 *   npx tsx scripts/edge-hunter.ts
 */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const TARGET = "NQ";
const PREDICTORS = ["NQ", "ES", "RTY", "YM", "ZN", "ZB", "6E", "CL", "GC", "HG", "ZC"];

function loadClose(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(`data/daily/${sym}_1d.csv`, ROOT), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch {}
  return m;
}
const loadHL = (sym: string) => { const m = new Map<string, { h: number; l: number; c: number }>(); try { for (const r of fs.readFileSync(new URL(`data/daily/${sym}_1d.csv`, ROOT), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const h = +c[5], l = +c[6], cl = +c[7]; if (isFinite(cl) && cl > 0) m.set(c[0].slice(0, 10), { h, l, c: cl }); } } catch {} return m; };

const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 1e-9; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) || 1e-9; };
// t-stat that the mean next-day return conditioned on a signal differs from 0
const tstat = (rs: number[]) => rs.length < 5 ? 0 : mean(rs) / (std(rs) / Math.sqrt(rs.length));

interface Row { date: string; nqFwd: number; feat: Record<string, number>; lowVol: boolean; highVol: boolean; }

function build(): Row[] {
  const closes: Record<string, Map<string, number>> = {};
  for (const s of new Set([TARGET, ...PREDICTORS])) closes[s] = loadClose(s);
  const nqHL = loadHL(TARGET);
  const dates = [...closes[TARGET].keys()].filter(d => PREDICTORS.every(p => closes[p].has(d))).sort();
  const rows: Row[] = [];
  const atrWin: number[] = []; const atrPxHist: number[] = [];
  for (let i = 2; i < dates.length - 1; i++) {
    const d = dates[i], pd = dates[i - 1], nd = dates[i + 1];
    const ret = (s: string, a: string, b: string) => { const x = closes[s].get(a), y = closes[s].get(b); return x && y ? (y - x) / x : 0; };
    // NQ next-day return (the target — strictly future)
    const nqFwd = ret(TARGET, d, nd);
    // features known AT day d (no lookahead)
    const feat: Record<string, number> = {};
    for (const p of PREDICTORS) {
      feat[`${p}_lag1`] = ret(p, pd, d);                                  // today's move in market p
      const d5 = dates[i - 5]; if (d5) feat[`${p}_mom5`] = ret(p, d5, d); // 5-day momentum of p
    }
    // NQ vol bucket (trailing-252 ATR/price percentile) — for regime conditioning
    const b = nqHL.get(d)!, pb = nqHL.get(pd)!;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pb.c), Math.abs(b.l - pb.c));
    atrWin.push(tr); if (atrWin.length > 20) atrWin.shift();
    const apx = (mean(atrWin)) / b.c;
    const win = atrPxHist.slice(-252); const pct = win.length ? win.filter(x => x < apx).length / win.length : 0.5;
    atrPxHist.push(apx);
    rows.push({ date: d, nqFwd, feat, lowVol: pct < 0.33, highVol: pct > 0.66 });
  }
  return rows;
}

// Evaluate one feature as a long/short-NQ-next-day signal, OOS. Direction chosen on TRAIN only.
function evalFeature(rows: Row[], key: string, filter?: (r: Row) => boolean): { n: number; t: number; meanR: number; dir: number } | null {
  const data = (filter ? rows.filter(filter) : rows).filter(r => key in r.feat && isFinite(r.feat[key]));
  if (data.length < 200) return null;
  const cut = Math.floor(data.length * 0.7);
  const train = data.slice(0, cut), oos = data.slice(cut);
  // pick direction on train: does a positive feature precede positive or negative NQ?
  const corrSign = Math.sign(train.reduce((s, r) => s + r.feat[key] * r.nqFwd, 0)) || 1;
  // signal: when feature is in its top/bottom tercile (train-derived thresholds), trade in corr direction
  const vals = train.map(r => r.feat[key]).sort((a, b) => a - b);
  const hi = vals[Math.floor(vals.length * 0.8)], lo = vals[Math.floor(vals.length * 0.2)];
  const oosRets: number[] = [];
  for (const r of oos) {
    const f = r.feat[key];
    if (f >= hi) oosRets.push(corrSign * r.nqFwd);        // strong positive feature → trade corr dir
    else if (f <= lo) oosRets.push(-corrSign * r.nqFwd);  // strong negative feature → opposite
  }
  if (oosRets.length < 30) return null;
  return { n: oosRets.length, t: tstat(oosRets), meanR: mean(oosRets), dir: corrSign };
}

function main() {
  const rows = build();
  const W = 100;
  console.log("\n" + "═".repeat(W));
  console.log(`  EDGE-HUNTER — intermarket + regime predictors of NQ next-day return (out-of-sample)`);
  console.log("═".repeat(W));
  if (rows.length < 400) { console.log("  insufficient aligned data"); return; }
  console.log(`  ${rows.length} aligned days · train 70% / OOS 30% (time-ordered, no lookahead)`);

  const conditions: { label: string; f?: (r: Row) => boolean }[] = [
    { label: "all" }, { label: "lowVol", f: r => r.lowVol }, { label: "highVol", f: r => r.highVol },
  ];
  const results: { name: string; cond: string; n: number; t: number; meanR: number }[] = [];
  const featureKeys = [...new Set(rows.flatMap(r => Object.keys(r.feat)))];
  for (const key of featureKeys) for (const c of conditions) {
    const r = evalFeature(rows, key, c.f);
    if (r) results.push({ name: key, cond: c.label, n: r.n, t: r.t, meanR: r.meanR });
  }
  const nTests = results.length;
  // Bonferroni: to claim significance at family-wise 5%, single-test p must be 0.05/nTests → t bar
  const tBar = 1.96 + Math.log(nTests) * 0.45; // rough Bonferroni-adjusted two-sided z for nTests
  results.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));

  console.log(`  ${nTests} predictors tested → multiple-testing bar |t| > ${tBar.toFixed(2)} (Bonferroni); ~${(nTests * 0.05).toFixed(0)} would clear |t|>1.96 by CHANCE alone`);
  console.log("─".repeat(W));
  console.log(`  ${"predictor".padEnd(14)} ${"regime".padEnd(8)} ${"OOS n".padEnd(7)} ${"t-stat".padEnd(9)} ${"mean fwd".padEnd(10)} verdict`);
  for (const r of results.slice(0, 12)) {
    const survives = Math.abs(r.t) > tBar;
    console.log(`  ${r.name.padEnd(14)} ${r.cond.padEnd(8)} ${String(r.n).padEnd(7)} ${r.t.toFixed(2).padEnd(9)} ${(r.meanR * 100).toFixed(3).padEnd(10)} ${survives ? "✅ SURVIVES" : Math.abs(r.t) > 1.96 ? "🟡 chance-level" : "—"}`);
  }
  const survivors = results.filter(r => Math.abs(r.t) > tBar);
  console.log("─".repeat(W));
  if (survivors.length) {
    console.log(`  ✅ ${survivors.length} predictor(s) cleared the honest bar — candidates to feed the engine:`);
    for (const s of survivors) console.log(`     ${s.name} (${s.cond}): OOS t=${s.t.toFixed(2)}, mean next-day ${(s.meanR * 100).toFixed(3)}%`);
  } else {
    console.log(`  ❌ NOTHING cleared the multiple-testing bar. No durable daily intermarket edge for NQ in this data.`);
    console.log(`     (Honest result — rules out the category. Next frontiers: intraday lead-lag, order-flow, OI confirmation.)`);
  }
  console.log("═".repeat(W) + "\n");
}
main();
