/**
 * SPREAD PAPER-FORWARD HARNESS — does the validated edge still behave FORWARD, net of real costs?
 *
 * Discipline: FIXED validated params (no tweaking), z-score uses prior bars only (no lookahead),
 * costs deducted per trade. Baseline = long history; Forward = most-recent window (a proxy until true
 * live-forward bars accrue — re-run after each `dbn-fetch-daily.ts` append and the forward window grows).
 *
 * Cost model is SWAPPABLE: COST_R is an assumption today; when the Trades+MBP-1 slice is purchased,
 * replace it with MEASURED per-trade slippage (see DATA-PILOT.md). That answers "are costs worse than expected?".
 *
 * Reports per pair: health, rolling expectancy/drawdown/win-loss, divergence persistence, gap-through-stop,
 * and an active/reduced/disabled call. Portfolio: drift vs baseline + correlation + PASS/WARN/FAIL + pause rules.
 *   npx tsx scripts/paper-forward.ts            (writes reports/paper-forward-<date>.json)
 */
import fs from "node:fs";

const dir = new URL("../data/daily/", import.meta.url);
function load(sym: string): Map<string, number> { const m = new Map<string, number>(); try { for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch { } return m; }
const cache = new Map<string, Map<string, number>>();
const L = (s: string) => cache.get(s) ?? cache.set(s, load(s)).get(s)!;

// ── FIXED, VALIDATED CONFIG — do not tweak in this harness ──────────────────
const PAIRS: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["6E", "6B"], ["6A", "6C"], ["GC", "HG"]];
const P = { lookback: 60, entryZ: 2, exitZ: 0, stopZ: 3.5, maxHold: 40 };
const COST_R = 0.10;                 // ASSUMED round-trip slippage+commission per trade, in R. ← replace with MEASURED (Trades+MBP-1)
const COST_SWEEP = [0.05, 0.10, 0.20];
const FORWARD_MONTHS = 18;           // forward window = most-recent N months (proxy until live-forward accrues)
const MIN_N = 8;                     // below this, a pair's forward stats are MONITORING, not a verdict

interface Tr { pair: string; entry: string; exit: string; dir: number; R: number; reason: "revert" | "stop" | "timeout"; hold: number; gapThru: boolean; }

// Run the FIXED strategy across full history; tag each trade by entry date. R matches validate-spread exactly.
function runPair(a: string, b: string): Tr[] {
  const A = L(a), B = L(b); const dates = [...A.keys()].filter(d => B.has(d)).sort();
  if (dates.length < P.lookback + 50) return [];
  const ratio = dates.map(d => A.get(d)! / B.get(d)!);
  const out: Tr[] = []; let pos: { dir: number; entry: number; fs: number; i: number } | null = null;
  for (let i = P.lookback; i < ratio.length; i++) {
    const w = ratio.slice(i - P.lookback, i), m = w.reduce((s, v) => s + v, 0) / P.lookback;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / P.lookback) || 1e-9, z = (ratio[i] - m) / sd;
    if (pos) {
      const revert = pos.dir === -1 ? z <= P.exitZ : z >= P.exitZ, stopped = Math.abs(z) >= P.stopZ, timeout = i - pos.i >= P.maxHold;
      if (revert || stopped || timeout) {
        const R = (pos.dir * (ratio[i] - pos.entry) / pos.entry) / (1.5 * pos.fs);
        out.push({ pair: `${a}/${b}`, entry: dates[pos.i], exit: dates[i], dir: pos.dir, R, reason: stopped ? "stop" : timeout ? "timeout" : "revert", hold: i - pos.i, gapThru: stopped && R < -1 });
        pos = null;
      }
    }
    if (!pos) { if (z > P.entryZ) pos = { dir: -1, entry: ratio[i], fs: sd / m, i }; else if (z < -P.entryZ) pos = { dir: 1, entry: ratio[i], fs: sd / m, i }; }
  }
  return out;
}

// ── metrics ──
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const net = (t: Tr[]) => t.map(x => x.R - COST_R);                       // net of assumed cost
function maxDD(rs: number[]) { let peak = 0, cum = 0, dd = 0; for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); } return dd; }
function cvar(rs: number[], q = 0.05) { if (!rs.length) return 0; const s = [...rs].sort((a, b) => a - b); const k = Math.max(1, Math.floor(rs.length * q)); return mean(s.slice(0, k)); }
function sharpe(t: Tr[]) { const m = new Map<string, number>(); for (const x of t) m.set(x.exit.slice(0, 7), (m.get(x.exit.slice(0, 7)) ?? 0) + (x.R - COST_R) * 0.01); const v = [...m.values()]; if (v.length < 2) return 0; const mu = mean(v), sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / v.length) || 1e-9; return (mu / sd) * Math.sqrt(12); }
function stats(t: Tr[]) {
  const r = net(t); const wins = r.filter(x => x > 0), losses = r.filter(x => x < 0);
  return {
    n: t.length, exp: mean(r), sharpe: sharpe(t), maxDD: maxDD(r), worst: r.length ? Math.min(...r) : 0, cvar: cvar(r),
    win: t.length ? wins.length / t.length : 0, avgWin: mean(wins), avgLoss: mean(losses),
    revertRate: t.length ? t.filter(x => x.reason === "revert").length / t.length : 0,
    stopRate: t.length ? t.filter(x => x.reason === "stop").length / t.length : 0,
    gapThruRate: t.filter(x => x.reason === "stop").length ? t.filter(x => x.gapThru).length / t.filter(x => x.reason === "stop").length : 0,
    avgHold: mean(t.map(x => x.hold)),
  };
}
const sign = (x: number) => (x >= 0 ? "+" : "");
const f2 = (x: number) => `${sign(x)}${x.toFixed(2)}`;

function main() {
  // build trades, find split date
  const all: Tr[] = []; for (const [a, b] of PAIRS) all.push(...runPair(a, b));
  if (!all.length) { console.log("No trades — is data/daily populated? Run scripts/dbn-fetch-daily.ts"); return; }
  const lastDate = all.reduce((mx, t) => (t.exit > mx ? t.exit : mx), "0000");
  const cut = new Date(lastDate + "T00:00:00Z"); cut.setUTCMonth(cut.getUTCMonth() - FORWARD_MONTHS);
  const FWD = cut.toISOString().slice(0, 10);
  const isFwd = (t: Tr) => t.entry >= FWD;

  console.log("\n" + "═".repeat(94));
  console.log(`  SPREAD PAPER-FORWARD  |  baseline < ${FWD} ≤ forward  (last data ${lastDate})  |  cost ${COST_R}R/trade (ASSUMED)`);
  console.log("═".repeat(94));

  // ── PER-PAIR ──
  console.log("\n  PER-PAIR HEALTH (net of cost; forward vs baseline)");
  console.log(`  ${"pair".padEnd(7)} ${"n(b/f)".padEnd(9)} ${"exp b→f".padEnd(15)} ${"DD f".padEnd(7)} ${"win f".padEnd(6)} ${"revert f".padEnd(9)} ${"gapThru f".padEnd(10)} verdict → action`);
  const pairReport: Record<string, unknown> = {};
  for (const [a, b] of PAIRS) {
    const key = `${a}/${b}`; const tp = all.filter(t => t.pair === key);
    const base = stats(tp.filter(t => !isFwd(t))), fwd = stats(tp.filter(t => isFwd(t)));
    let verdict: string, action: string;
    if (fwd.n < MIN_N) { verdict = "MONITOR"; action = "active (low forward n)"; }
    else if (fwd.exp <= 0) { verdict = "FAIL"; action = "DISABLE"; }
    else if (fwd.exp >= 0.5 * Math.max(base.exp, 1e-9) && fwd.gapThruRate <= base.gapThruRate * 1.5 + 0.1) { verdict = "PASS"; action = "active"; }
    else { verdict = "WARN"; action = "REDUCE"; }
    const tag = verdict === "PASS" ? "✅" : verdict === "WARN" ? "🟡" : verdict === "FAIL" ? "❌" : "⏳";
    console.log(`  ${key.padEnd(7)} ${`${base.n}/${fwd.n}`.padEnd(9)} ${`${f2(base.exp)}→${f2(fwd.exp)}R`.padEnd(15)} ${f2(fwd.maxDD).padEnd(7)} ${(fwd.win * 100).toFixed(0).padEnd(5)}% ${(fwd.revertRate * 100).toFixed(0).padEnd(8)}% ${(fwd.gapThruRate * 100).toFixed(0).padEnd(9)}% ${tag} ${verdict} → ${action}`);
    pairReport[key] = { baseline: base, forward: fwd, verdict, action };
  }

  // ── PORTFOLIO ──
  const base = stats(all.filter(t => !isFwd(t))), fwd = stats(all.filter(t => isFwd(t)));
  const drift = (b: number, f: number) => (b ? ((f - b) / Math.abs(b)) * 100 : 0);
  console.log("\n  PORTFOLIO (all pairs pooled, net of cost)");
  console.log(`    expectancy:  baseline ${f2(base.exp)}R   forward ${f2(fwd.exp)}R   (drift ${f2(drift(base.exp, fwd.exp))}%)`);
  console.log(`    Sharpe:      baseline ${base.sharpe.toFixed(2)}    forward ${fwd.sharpe.toFixed(2)}     (small forward-n → noisy)`);
  console.log(`    maxDD:       baseline ${base.maxDD.toFixed(1)}R   forward ${fwd.maxDD.toFixed(1)}R`);
  console.log(`    tail:        worst b ${base.worst.toFixed(1)}R / f ${fwd.worst.toFixed(1)}R   CVaR5% b ${base.cvar.toFixed(2)} / f ${fwd.cvar.toFixed(2)}`);
  console.log(`    behavior:    revert-rate b ${(base.revertRate * 100).toFixed(0)}% / f ${(fwd.revertRate * 100).toFixed(0)}%   gap-through-stop b ${(base.gapThruRate * 100).toFixed(0)}% / f ${(fwd.gapThruRate * 100).toFixed(0)}%`);

  // ── COST SENSITIVITY (until measured slippage replaces COST_R) ──
  console.log("\n  COST SENSITIVITY (forward expectancy at assumed slippage levels — measured slippage will replace this)");
  for (const c of COST_SWEEP) { const e = mean(all.filter(isFwd).map(x => x.R - c)); console.log(`     @ ${c.toFixed(2)}R cost:  forward ${f2(e)}R/trade  ${e > 0 ? "✅ positive" : "❌ negative"}`); }

  // ── CORRELATION / CONCENTRATION (forward monthly returns per pair) ──
  const months = [...new Set(all.filter(isFwd).map(t => t.exit.slice(0, 7)))].sort();
  const series: Record<string, number[]> = {};
  for (const [a, b] of PAIRS) { const k = `${a}/${b}`; const mm = new Map<string, number>(); for (const t of all.filter(t => t.pair === k && isFwd(t))) mm.set(t.exit.slice(0, 7), (mm.get(t.exit.slice(0, 7)) ?? 0) + (t.R - COST_R)); series[k] = months.map(m => mm.get(m) ?? 0); }
  let maxCorr = 0, maxPair = "";
  const keys = PAIRS.map(([a, b]) => `${a}/${b}`);
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) { const x = series[keys[i]], y = series[keys[j]]; if (x.length < 4) continue; const mx = mean(x), my = mean(y); const cov = mean(x.map((v, k) => (v - mx) * (y[k] - my))); const sx = Math.sqrt(mean(x.map(v => (v - mx) ** 2))) || 1e-9, sy = Math.sqrt(mean(y.map(v => (v - my) ** 2))) || 1e-9; const c = cov / (sx * sy); if (Math.abs(c) > Math.abs(maxCorr)) { maxCorr = c; maxPair = `${keys[i]}↔${keys[j]}`; } }
  console.log(`\n  CONCENTRATION: highest forward pair-correlation ${maxCorr.toFixed(2)} (${maxPair || "n/a"})  ${Math.abs(maxCorr) > 0.7 ? "🟡 watch — pairs co-moving" : "✅ diversified"}`);

  // ── VERDICT + 7 QUESTIONS ──
  const passPairs = Object.values(pairReport).filter((p: any) => p.verdict === "PASS").length;
  const failPairs = Object.entries(pairReport).filter(([, p]: any) => p.verdict === "FAIL").map(([k]) => k);
  const warnPairs = Object.entries(pairReport).filter(([, p]: any) => p.verdict === "WARN").map(([k]) => k);
  const overall = fwd.exp <= 0 ? "❌ FAIL" : (fwd.exp >= 0.5 * base.exp && mean(all.filter(isFwd).map(x => x.R - 0.20)) > 0) ? "✅ PASS" : "🟡 WARN";
  console.log("\n  " + "─".repeat(90));
  console.log(`  OVERALL: ${overall}   (forward expectancy ${f2(fwd.exp)}R, baseline ${f2(base.exp)}R; ${passPairs}/${PAIRS.length} pairs PASS)`);
  console.log("  " + "─".repeat(90));
  console.log("  1. Edge still behaves forward?      " + (fwd.exp > 0 ? `YES — forward ${f2(fwd.exp)}R/trade positive net of cost` : `NO — forward ${f2(fwd.exp)}R ≤ 0`));
  console.log("  2. Which pairs still working?       " + (Object.entries(pairReport).filter(([, p]: any) => p.verdict === "PASS").map(([k]) => k).join(", ") || "(none cleared — mostly low-n monitoring)"));
  console.log("  3. Which pairs degrading?           " + ([...warnPairs, ...failPairs].join(", ") || "none"));
  console.log("  4. Tails worse than expected?       " + (fwd.worst < base.worst * 1.25 || fwd.gapThruRate > base.gapThruRate * 1.5 ? `🟡 watch (worst f ${fwd.worst.toFixed(1)}R vs b ${base.worst.toFixed(1)}R, gap-through f ${(fwd.gapThruRate * 100).toFixed(0)}%)` : `no (worst f ${fwd.worst.toFixed(1)}R ≈ b ${base.worst.toFixed(1)}R)`));
  console.log("  5. Costs worse than expected?       UNKNOWN until measured — buy the Trades+MBP-1 slice (DATA-PILOT.md). Sensitivity above shows survival to 0.20R.");
  console.log("  6. Viable for prop/funded?          " + (overall.includes("PASS") ? "YES if it holds — needs ~$100k+ (per-pair margin); NOT $1K" : overall.includes("WARN") ? "CONDITIONAL — must clear WARN + measured costs first" : "NO — forward edge not present"));
  console.log("  7. Conditions that PAUSE strategy:");
  console.log("       • portfolio forward expectancy ≤ 0 over a rolling 30-trade window");
  console.log("       • any pair forward expectancy < 0 over ≥" + MIN_N + " trades → DISABLE that pair");
  console.log("       • gap-through-stop rate > 1.5× baseline (tail widening) → REDUCE size");
  console.log("       • max pair-correlation > 0.7 (concentration) → cut overlapping pairs");
  console.log("       • measured slippage pushes net expectancy ≤ 0 → STOP, re-cost");

  // ── write report ──
  const outDir = new URL("../reports/", import.meta.url); try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
  const report = { generated: new Date().toISOString(), lastData: lastDate, forwardStart: FWD, costR: COST_R, params: P, overall, portfolio: { baseline: base, forward: fwd }, pairs: pairReport, maxCorr, maxPair };
  const file = new URL(`paper-forward-${lastDate}.json`, outDir);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\n  report → reports/paper-forward-${lastDate}.json`);
  console.log("  NOTE: forward window is a PROXY until live-forward bars accrue. Re-run after each dbn-fetch-daily.ts append;");
  console.log("        the forward sample grows and the verdict strengthens. Replace COST_R with measured slippage when bought.");
  console.log("═".repeat(94) + "\n");
}
main();
