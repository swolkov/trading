/**
 * SMALL-ACCOUNT REALISTIC MATH — probability of ruin + plausible returns for a $1K micro account,
 * vs a prop-firm-funded account. No fantasy. Models the FORCED risk on tiny capital honestly.
 *   npx tsx scripts/microaccount-ruin.ts
 */
const SIMS = 100_000, TRADES_YR = 250;

// On $1K, one micro with a NOISE-SURVIVING stop ≈ 5% of the account (MES 10pt=$50, MGC ~8pt=$80,
// MNQ ~40pt=$80). You cannot get to 1-2% without stops so tight they get noise-stopped. So 5% is forced.
function sim(start: number, risk: number, W: number, RR: number, ruinFloor: number, years = 1) {
  let ruin = 0, dbl = 0, fivex = 0; const ends: number[] = [];
  for (let s = 0; s < SIMS; s++) {
    let eq = start, done = false;
    for (let i = 0; i < TRADES_YR * years && !done; i++) {
      if (eq <= ruinFloor) { ruin++; done = true; break; }
      const bet = eq * risk;
      eq += Math.random() < W ? bet * RR : -bet;
    }
    if (!done && eq <= ruinFloor) ruin++;
    if (eq >= start * 2) dbl++;
    if (eq >= start * 5) fivex++;
    ends.push(eq);
  }
  ends.sort((a, b) => a - b);
  return { ruin: ruin / SIMS, median: ends[SIMS >> 1], p2x: dbl / SIMS, p5x: fivex / SIMS };
}
const edges: [string, number, number][] = [
  ["no edge      (50% @ 1:1)", 0.50, 1.0],
  ["weak edge    (50% @ 1.5:1 = +0.25R)", 0.50, 1.5],
  ["decent edge  (53% @ 1.5:1 = +0.32R)", 0.53, 1.5],
  ["strong edge  (55% @ 2:1 = +0.65R)", 0.55, 2.0],
];

function main() {
  const pct = (x: number) => (x * 100).toFixed(0) + "%";
  console.log("\n" + "═".repeat(84));
  console.log("  SMALL-ACCOUNT REALISTIC MATH — 1 year (~250 trades), ruin = drop below 50% of start");
  console.log("═".repeat(84));

  console.log("\n  $1,000 ACCOUNT @ 5% risk/trade (the FORCED level — 1 micro is ~5% of $1k)");
  console.log(`     ${"edge".padEnd(38)} P(ruin)  median   P(2x)  P(5x)`);
  for (const [n, W, RR] of edges) { const r = sim(1000, 0.05, W, RR, 500); console.log(`     ${n.padEnd(38)} ${pct(r.ruin).padStart(5)}   $${r.median.toFixed(0).padStart(6)}  ${pct(r.p2x).padStart(4)}  ${pct(r.p5x).padStart(4)}`); }

  console.log("\n  Same edges @ a SANE 1% risk/trade (only possible on ~$5k+ where a micro = ~1%)");
  console.log(`     ${"edge".padEnd(38)} P(ruin)  median   P(2x)  P(5x)`);
  for (const [n, W, RR] of edges) { const r = sim(1000, 0.01, W, RR, 500); console.log(`     ${n.padEnd(38)} ${pct(r.ruin).padStart(5)}   $${r.median.toFixed(0).padStart(6)}  ${pct(r.p2x).padStart(4)}  ${pct(r.p5x).padStart(4)}`); }

  console.log("\n  PROP-FIRM PATH: $50k funded account, 1% risk, decent edge — survive the eval + scale?");
  const pf = sim(50000, 0.01, 0.53, 1.5, 50000 * 0.9, 1);   // 10% trailing drawdown = typical eval bust
  console.log(`     decent edge @ 1% on $50k funded (10% max-DD rule): P(bust the account in a year) ${pct(pf.ruin)}, median end $${pf.median.toFixed(0)}`);
  console.log(`     → you risk only the ~$150-300 eval fee, trade properly-sized capital, keep 80-90% of profits.`);

  console.log("\n  READ: on $1k at the forced 5% risk, even a STRONG edge has material ruin risk and is mostly variance.");
  console.log("        the math says: don't grind $1k — get properly-sized capital (deposit or prop-firm) for the SAME edge.");
  console.log("═".repeat(84) + "\n");
}
main();
