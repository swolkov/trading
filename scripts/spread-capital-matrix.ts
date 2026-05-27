/**
 * SPREAD CAPITAL MATRIX — the REAL dollar risk per trade for each validated spread, using actual CME
 * contract specs + dollar-neutral whole-contract sizing. Answers: what is safely tradable on $50K vs
 * needs more capital? Per the GPT/Claude consensus: MARGIN lets you hold a spread cheaply, but the
 * gap-through-stop LOSS is what actually needs capital — so this sizes on RISK, not margin.
 *   npx tsx scripts/spread-capital-matrix.ts
 */
import fs from "node:fs";

const PAIRS: [string, string][] = [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["ZW", "ZC"], ["ZS", "ZW"], ["6E", "6B"], ["6A", "6C"], ["GC", "HG"]];
const P = { lookback: 60, entryZ: 2, exitZ: 0, stopZ: 3.5, maxHold: 40 };
// $ per 1.0 of the data's price units — standard CME specs (grains quoted in cents → $50 per cent).
const MULT: Record<string, number> = { CL: 1000, RB: 42000, HO: 42000, ZC: 50, ZS: 50, ZW: 50, "6E": 125000, "6B": 62500, "6A": 100000, "6C": 100000, GC: 100, HG: 25000 };

const dir = new URL("../data/daily/", import.meta.url);
function load(s: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(`${s}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch { }
  return m;
}

function pctl(arr: number[], q: number) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.max(0, Math.floor(s.length * q))]; }

function analyze(a: string, b: string) {
  const A = load(a), B = load(b); const ds = [...A.keys()].filter(d => B.has(d)).sort();
  if (ds.length < P.lookback + 20) return null;
  const ratio = ds.map(d => A.get(d)! / B.get(d)!);
  // dollar-neutral whole-contract sizing at the latest price (min 1 each)
  const pA = A.get(ds[ds.length - 1])!, pB = B.get(ds[ds.length - 1])!;
  const notA = pA * MULT[a], notB = pB * MULT[b];
  let nA = 1, nB = 1;
  if (notA >= notB) nB = Math.max(1, Math.round(notA / notB)); else nA = Math.max(1, Math.round(notB / notA));
  const pnls: number[] = []; let pos: { d: number; i: number } | null = null;
  for (let i = P.lookback; i < ratio.length; i++) {
    const w = ratio.slice(i - P.lookback, i); const m = w.reduce((s, v) => s + v, 0) / P.lookback;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / P.lookback) || 1e-9; const z = (ratio[i] - m) / sd;
    if (pos) {
      const revert = pos.d === -1 ? z <= P.exitZ : z >= P.exitZ, stopped = Math.abs(z) >= P.stopZ, timeout = i - pos.i >= P.maxHold;
      if (revert || stopped || timeout) {
        const dA = A.get(ds[i])! - A.get(ds[pos.i])!, dB = B.get(ds[i])! - B.get(ds[pos.i])!;
        pnls.push(pos.d * (nA * dA * MULT[a] - nB * dB * MULT[b]));   // long ratio = long A, short B
        pos = null;
      }
    }
    if (!pos) { if (z > P.entryZ) pos = { d: -1, i }; else if (z < -P.entryZ) pos = { d: 1, i }; }
  }
  const losses = pnls.filter(x => x < 0);
  const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : 0;
  const worst = pnls.length ? Math.min(...pnls) : 0;
  const p95loss = pctl(pnls, 0.05);   // 5th percentile = a bad-but-not-worst loss
  return { nA, nB, netNotional: nA * notA + nB * notB, n: pnls.length, avgLoss, worst, p95loss };
}

const W = 104;
console.log("\n" + "═".repeat(W));
console.log("  SPREAD CAPITAL MATRIX — real $ risk per trade (CME specs, $-neutral sizing) → safe capital");
console.log("═".repeat(W));
console.log(`  ${"spread".padEnd(7)} ${"size".padEnd(7)} ${"net notion".padStart(11)} ${"avg loss".padStart(9)} ${"bad(5%)".padStart(9)} ${"worst".padStart(9)} ${"cap (worst≤10%)".padStart(16)}  $50K?`);
const fit: string[] = [];
for (const [a, b] of PAIRS) {
  const r = analyze(a, b);
  if (!r) { console.log(`  ${a}/${b} — insufficient data`); continue; }
  const cap = Math.abs(r.worst) / 0.10;             // worst historical loss ≤ 10% of capital
  const ok = Math.abs(r.worst) <= 5000;             // 10% of $50K
  if (ok) fit.push(`${a}/${b}`);
  const $ = (x: number) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString();
  const k = (x: number) => "$" + Math.round(x / 1000) + "k";
  console.log(`  ${`${a}/${b}`.padEnd(7)} ${`${r.nA}×${r.nB}`.padEnd(7)} ${k(r.netNotional).padStart(11)} ${$(r.avgLoss).padStart(9)} ${$(r.p95loss).padStart(9)} ${$(r.worst).padStart(9)} ${k(cap).padStart(16)}  ${ok ? "✅" : "❌"}`);
}
console.log("─".repeat(W));
console.log(`  Tradable on $50K (worst historical loss ≤ ~10% = $5k): ${fit.length ? fit.join(", ") : "NONE"}`);
console.log(`  NOTE: margin to HOLD each spread is far lower (SPAN credits) — but that's not the constraint.`);
console.log(`  RISK is: one gap-through-stop on a too-big spread can blow the account. This sizes on the tail, not margin.`);
console.log("═".repeat(W) + "\n");
