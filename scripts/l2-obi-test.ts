/**
 * L2 ORDER-BOOK IMBALANCE TEST — the small-size microstructure-edge probe.
 * Hypothesis: order-book imbalance (OBI = bid_sz / (bid_sz+ask_sz)) predicts the NEXT mid-price move
 * over a MINUTES-ish horizon a non-colocated $1K micro trader could actually execute. If the predicted
 * move in the extreme OBI buckets beats the ~0.5pt (2-tick) round-trip cost, there may be a real edge
 * that works *because* you trade tiny size. If not, it's HFT-owned / sub-cost → reject for retail.
 *   npx tsx scripts/l2-obi-test.ts
 */
import fs from "node:fs";

const dir = new URL("../data/l2/", import.meta.url);
const TICK = 0.25;                 // ES/NQ tick (index futures)
const COST_PTS = 0.5;              // ~2 ticks round trip (cross the spread in + out) — what the edge must beat
const HORIZONS = [10, 30, 60, 300];

function analyze(sym: string) {
  let lines: string[];
  try { lines = fs.readFileSync(new URL(`${sym}_bbo1s.csv`, dir), "utf8").trim().split("\n"); }
  catch { console.log(`  ${sym}: no data`); return; }
  const t: number[] = [], mid: number[] = [], obi: number[] = [];
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(",");
    const bpx = +c[10], apx = +c[11], bsz = +c[12], asz = +c[13];
    if (!(bpx > 0 && apx >= bpx && bsz > 0 && asz > 0)) continue;
    if (apx - bpx > 4 * TICK) continue;                 // skip wide/illiquid quotes
    const ts = Date.parse(c[1]); if (!isFinite(ts)) continue;
    t.push(ts); mid.push((bpx + apx) / 2); obi.push(bsz / (bsz + asz));
  }
  const fwd = (i: number, h: number): number | null => {
    const target = t[i] + h * 1000; let lo = i, hi = t.length - 1, j = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] >= target) { j = m; hi = m - 1; } else lo = m + 1; }
    if (j < 0 || t[j] - target > 5000) return null;      // need a snapshot within 5s of t+h
    return mid[j] - mid[i];
  };
  const NB = 5;
  console.log(`\n  ── ${sym}: ${t.length.toLocaleString()} valid 1s snapshots ──`);
  console.log(`  ${"OBI bucket".padEnd(11)}${HORIZONS.map(h => `+${h}s`.padStart(9)).join("")}      n   (avg forward mid-move, POINTS)`);
  const topBot: Record<number, { top: number; bot: number }> = {};
  for (let b = 0; b < NB; b++) {
    const lo = b / NB, hi = (b + 1) / NB;
    const idx: number[] = []; for (let i = 0; i < obi.length; i++) if (obi[i] >= lo && obi[i] < hi) idx.push(i);
    const row = HORIZONS.map(h => { const v = idx.map(i => fwd(i, h)).filter(x => x !== null) as number[]; return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; });
    HORIZONS.forEach((h, hi2) => { topBot[h] = topBot[h] || { top: 0, bot: 0 }; if (b === NB - 1) topBot[h].top = row[hi2]; if (b === 0) topBot[h].bot = row[hi2]; });
    console.log(`  ${`${lo.toFixed(1)}-${hi.toFixed(1)}`.padEnd(11)}${row.map(a => `${a >= 0 ? "+" : ""}${a.toFixed(3)}`.padStart(9)).join("")}  ${String(idx.length).padStart(7)}`);
  }
  console.log(`  VERDICT (long high-OBI / short low-OBI):`);
  for (const h of HORIZONS) {
    const edge = topBot[h].top - topBot[h].bot;          // points captured by the long-high/short-low spread
    const netLong = topBot[h].top - COST_PTS, netShort = -topBot[h].bot - COST_PTS;
    const tradable = netLong > 0 || netShort > 0;
    console.log(`     +${h}s: signal spread ${edge.toFixed(3)}pt | net long ${netLong.toFixed(3)}pt, net short ${netShort.toFixed(3)}pt (after ${COST_PTS}pt cost) → ${tradable ? "✅ beats cost" : "❌ below cost"}`);
  }
}

console.log("\n" + "═".repeat(72));
console.log("  L2 ORDER-BOOK IMBALANCE → forward drift  (does small-size edge survive cost?)");
console.log("═".repeat(72));
for (const s of ["ES", "NQ"]) analyze(s);
console.log("\n  Cost basis: ES/NQ tick 0.25pt; ~2 ticks (0.5pt) round trip. MES/MNQ: 1pt=$5/$2 → 0.5pt≈$2.50/$1.00.");
console.log("═".repeat(72) + "\n");
