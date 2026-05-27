/**
 * L2 MICROSTRUCTURE SUITE — exhaust the order-book-edge search on the bbo-1s data.
 * The basic OBI test showed a real-but-sub-cost signal (~0.14pt vs 0.5pt cost). This pushes harder:
 *   A) EXTREME imbalance tails (0.90/0.95/0.98) — does a sharper signal predict a bigger, cost-beating move?
 *   B) PERSISTENCE — does imbalance SUSTAINED for K seconds predict more than an instantaneous reading?
 *   C) TIME-OF-DAY — does OBI work better at the RTH open (structural / H1) than midday?
 * Bar to clear: forward move must beat ~0.5pt (2-tick) retail round-trip cost. If nothing clears, the
 * order-book edge is HFT-owned at every config a $1K taker could use → reject for retail.
 *   npx tsx scripts/l2-microstructure-suite.ts
 */
import fs from "node:fs";

const dir = new URL("../data/l2/", import.meta.url);
const TICK = 0.25, COST = 0.5;
const SYM = "ES";

const lines = fs.readFileSync(new URL(`${SYM}_bbo1s.csv`, dir), "utf8").trim().split("\n");
const t: number[] = [], mid: number[] = [], obi: number[] = [], hourUTC: number[] = [];
for (let k = 1; k < lines.length; k++) {
  const c = lines[k].split(",");
  const bpx = +c[10], apx = +c[11], bsz = +c[12], asz = +c[13];
  if (!(bpx > 0 && apx >= bpx && bsz > 0 && asz > 0) || apx - bpx > 4 * TICK) continue;
  const ts = Date.parse(c[1]); if (!isFinite(ts)) continue;
  t.push(ts); mid.push((bpx + apx) / 2); obi.push(bsz / (bsz + asz)); hourUTC.push(new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60);
}
const N = t.length;
function fwd(i: number, h: number): number | null {
  const target = t[i] + h * 1000; let lo = i, hi = N - 1, j = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] >= target) { j = m; hi = m - 1; } else lo = m + 1; }
  return (j < 0 || t[j] - target > 5000) ? null : mid[j] - mid[i];
}
const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const fwdAvg = (idx: number[], h: number) => avg(idx.map(i => fwd(i, h)).filter(x => x !== null) as number[]);
const verdict = (longMove: number, shortMove: number) => (longMove - COST > 0 || -shortMove - COST > 0) ? "✅ BEATS COST" : "❌ below cost";

console.log("\n" + "═".repeat(74) + `\n  L2 MICROSTRUCTURE SUITE — ${SYM}, ${N.toLocaleString()} snapshots (must beat ${COST}pt cost)\n` + "═".repeat(74));

// ── A) EXTREME thresholds ──
console.log("\n  A) EXTREME imbalance → forward move (pt) at 60s / 300s:");
for (const thr of [0.90, 0.95, 0.98]) {
  const hi = []; const loI = []; for (let i = 0; i < N; i++) { if (obi[i] >= thr) hi.push(i); if (obi[i] <= 1 - thr) loI.push(i); }
  const l60 = fwdAvg(hi, 60), s60 = fwdAvg(loI, 60), l300 = fwdAvg(hi, 300), s300 = fwdAvg(loI, 300);
  console.log(`    OBI≥${thr} (n=${hi.length}) long +60s ${l60.toFixed(3)} +300s ${l300.toFixed(3)} | OBI≤${(1 - thr).toFixed(2)} (n=${loI.length}) short +60s ${s60.toFixed(3)} +300s ${s300.toFixed(3)}  → ${verdict(Math.max(l60, l300), Math.min(s60, s300))}`);
}

// ── B) PERSISTENCE (imbalance sustained K consecutive snapshots) ──
console.log("\n  B) PERSISTENT imbalance (OBI extreme held ≥K snapshots) → forward move:");
for (const K of [10, 30]) {
  const hiP: number[] = [], loP: number[] = []; let runHi = 0, runLo = 0;
  for (let i = 0; i < N; i++) {
    runHi = obi[i] >= 0.8 ? runHi + 1 : 0; runLo = obi[i] <= 0.2 ? runLo + 1 : 0;
    if (runHi === K) hiP.push(i); if (runLo === K) loP.push(i);
  }
  const l = fwdAvg(hiP, 60), s = fwdAvg(loP, 60), l3 = fwdAvg(hiP, 300), s3 = fwdAvg(loP, 300);
  console.log(`    held ${K}s: bid-heavy (n=${hiP.length}) +60s ${l.toFixed(3)} +300s ${l3.toFixed(3)} | ask-heavy (n=${loP.length}) +60s ${s.toFixed(3)} +300s ${s3.toFixed(3)}  → ${verdict(Math.max(l, l3), Math.min(s, s3))}`);
}

// ── C) TIME-OF-DAY (does OBI predict better at the RTH open? 13:30 UTC ≈ 9:30 ET) ──
console.log("\n  C) OBI top-vs-bottom-quintile spread by session (signal strength, pt):");
const sessions: [string, (h: number) => boolean][] = [["RTH open 13:30-14:30", h => h >= 13.5 && h < 14.5], ["RTH mid 15-19", h => h >= 15 && h < 19], ["overnight 0-13", h => h < 13]];
for (const [name, inSess] of sessions) {
  const top = [], bot = []; for (let i = 0; i < N; i++) { if (!inSess(hourUTC[i])) continue; if (obi[i] >= 0.8) top.push(i); if (obi[i] <= 0.2) bot.push(i); }
  const spread = fwdAvg(top, 60) - fwdAvg(bot, 60);
  console.log(`    ${name.padEnd(22)} top-bot spread @60s = ${spread.toFixed(3)}pt (n top ${top.length}/bot ${bot.length})  → ${spread > COST ? "✅" : "❌ < cost"}`);
}
console.log("\n" + "═".repeat(74) + "\n");
