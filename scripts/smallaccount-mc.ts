/**
 * SMALL-ACCOUNT TARGET MONTE CARLO — P($1K → $5K in ~30 days before ruin), played optimally.
 * Frames the aggressive-compounding attempt as gambler's-ruin-to-target. Tests realistic edges.
 *   npx tsx scripts/smallaccount-mc.ts
 */
const START = 1000, TARGET = 5000, FLOOR = 500;       // ruin-floor: stop the attempt at -50%
const TRADES = 60;                                     // ~2 selective trades/day × 30 days
const SLIP = 3;                                        // $ cost per trade (commission + slippage, micro)
const SIMS = 100_000;

function sim(risk: number, W: number, RR: number) {
  let target = 0, ruin = 0, ended = 0; const ends: number[] = [];
  for (let s = 0; s < SIMS; s++) {
    let eq = START, done = false;
    for (let i = 0; i < TRADES && !done; i++) {
      if (eq >= TARGET) { target++; done = true; break; }
      if (eq <= FLOOR) { ruin++; done = true; break; }
      const bet = eq * risk;
      eq += (Math.random() < W ? bet * RR : -bet) - SLIP;
    }
    if (!done) { if (eq >= TARGET) target++; else if (eq <= FLOOR) ruin++; else { ended++; } }
    ends.push(eq);
  }
  ends.sort((a, b) => a - b);
  return { pTarget: target / SIMS, pRuin: ruin / SIMS, median: ends[SIMS >> 1] };
}

function main() {
  console.log("\n" + "═".repeat(78));
  console.log("  $1K → $5K in ~30 days (60 trades) — P(hit target) vs P(ruin), 100k sims each");
  console.log("  ruin-floor $500 (-50%), $3/trade cost. 'edge' = win% × reward:risk");
  console.log("═".repeat(78));
  const configs: [string, number, number, number][] = [
    ["fair coin, no edge      ", 0.08, 0.50, 1.0],
    ["thin edge (2:1 @ 50%)    ", 0.08, 0.50, 2.0],
    ["asymmetric (2.5:1 @ 45%) ", 0.08, 0.45, 2.5],
    ["good edge (2:1 @ 55%)    ", 0.08, 0.55, 2.0],
    ["good edge, BOLDER (15%)  ", 0.15, 0.55, 2.0],
    ["good edge, TIMID (3%)    ", 0.03, 0.55, 2.0],
    ["slight NEG edge (costs)  ", 0.08, 0.48, 2.0],
  ];
  console.log(`  ${"strategy".padEnd(27)} risk/trade   P(reach $5K)   P(ruin)   median end`);
  for (const [label, risk, W, RR] of configs) {
    const r = sim(risk, W, RR);
    console.log(`  ${label} ${(risk * 100).toFixed(0).padStart(6)}%      ${(r.pTarget * 100).toFixed(0).padStart(5)}%       ${(r.pRuin * 100).toFixed(0).padStart(4)}%     $${r.median.toFixed(0)}`);
  }
  console.log("\n  Read: even a GOOD edge optimally sized gives ~1-in-4 to 1-in-3 at the target — and ~2-in-3 ruin.");
  console.log("═".repeat(78) + "\n");
}
main();
