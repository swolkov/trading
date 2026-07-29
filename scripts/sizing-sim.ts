/**
 * CONTRACT-CAP SIMULATION — how much more per trade can we take WITHOUT more capital?
 *
 * THE FINDING THAT PROMPTED THIS: the 2-contract cap, not the 3% risk rule, is what sets position
 * size on most trades. At today's equity the budget is 3% x $5,227 = $156.83, but:
 *     MGC ATR 1.41 -> $21.15/contract -> budget allows 7, cap gives 2  -> 27% of budget used
 *     MNQ ATR 7.26 -> $21.78/contract -> budget allows 7, cap gives 2  -> 28%
 *     MES ATR 1.78 -> $13.35/contract -> budget allows 11, cap gives 2 -> 17%
 *     MES ATR 0.79 -> $ 5.93/contract -> budget allows 26, cap gives 2 ->  8%
 * So we routinely risk 8-28% of the risk we have already authorised. Raising the cap does not
 * change the RISK RULE — it lets position size actually reach it.
 *
 * WHY THIS NEEDS A SIM AND NOT A GUESS: the last sizing study (on $4,876) found 1 micro optimal and
 * put the kill-switch probability at 7% / 30% / 45% / 54% for 1/2/3/4 contracts. That is the reason
 * the cap exists. But it was run at 6% risk_pct with a different edge set, so it cannot be applied
 * to today's 3% config directly. This re-runs it on the CURRENT setup.
 *
 * MODEL: per trade, draw a risk-per-contract from the observed ATR mix, size
 * qty = min(cap, floor(budget / riskPerContract)) exactly as futures-realtime.ts:3533-3536 does,
 * then win with probability p for payoff x risk, else lose the risk. Budget recomputes off CURRENT
 * equity, so it compounds both ways. Path dies if equity <= 75% of start (the 25% kill switch).
 *
 * HONEST LIMITS: assumes trades are independent (no clustering/tilt), a fixed payoff ratio, and no
 * daily-loss-limit circuit breaker (which would cushion the bad tails, so ruin here is if anything
 * PESSIMISTIC). It cannot tell you the true win rate — that is why it sweeps a range.
 */
const START = 5227.52;
const RISK_PCT = 0.03;
const KILL = 0.75;              // 25% drawdown kill switch
const PAYOFF = 0.90;            // live measured: avg win / avg loss
const TRADES = 91;              // ~6 months at 3.5/week
const PATHS = 20000;
/** Observed risk-per-contract across the real ATR mix (MGC quiet/vol, MNQ, MES typical/quiet). */
const RISK_PER_CT = [21.15, 76.35, 21.78, 13.35, 5.93];
const CAPS = [2, 3, 4, 5, 7, 10];
const WIN_RATES = [0.50, 0.55, 0.60, 0.706];   // 0.706 = live measured (17 trades — unreliable)

// Deterministic PRNG so the result is reproducible.
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function run(cap: number, p: number) {
  let killed = 0, profitable = 0;
  const finals: number[] = [];
  for (let path = 0; path < PATHS; path++) {
    let eq = START, dead = false;
    for (let t = 0; t < TRADES; t++) {
      const budget = eq * RISK_PCT;
      const perCt = RISK_PER_CT[Math.floor(rnd() * RISK_PER_CT.length)];
      const qty = Math.min(cap, Math.floor(budget / perCt));
      if (qty < 1) continue;                       // engine skips: "calculated qty 0"
      const risk = qty * perCt;
      eq += rnd() < p ? risk * PAYOFF : -risk;
      if (eq <= START * KILL) { dead = true; break; }
    }
    if (dead) killed++;
    if (eq > START) profitable++;
    finals.push(eq);
  }
  finals.sort((a, b) => a - b);
  return {
    median: finals[Math.floor(PATHS / 2)],
    p10: finals[Math.floor(PATHS * 0.1)],
    p90: finals[Math.floor(PATHS * 0.9)],
    killPct: 100 * killed / PATHS,
    profitPct: 100 * profitable / PATHS,
  };
}

console.log(`CONTRACT-CAP SIM — $${START.toFixed(0)} start · ${RISK_PCT * 100}% budget · payoff ${PAYOFF}:1 · ${TRADES} trades (~6mo) · ${PATHS} paths`);
console.log(`Kill switch: equity <= $${(START * KILL).toFixed(0)} (-25%)\n`);
for (const p of WIN_RATES) {
  const be = 1 / (1 + PAYOFF);
  console.log("═".repeat(96));
  console.log(`  WIN RATE ${(p * 100).toFixed(1)}%   (break-even at this payoff = ${(be * 100).toFixed(1)}%)${p > 0.7 ? "   <- live measured, only 17 trades" : ""}`);
  console.log("═".repeat(96));
  console.log(`  ${"cap".padEnd(6)} ${"median".padEnd(11)} ${"10th pct".padEnd(11)} ${"90th pct".padEnd(11)} ${"P(killed)".padEnd(11)} P(profit)`);
  for (const cap of CAPS) {
    const r = run(cap, p);
    const flag = cap === 2 ? "  <- today" : "";
    console.log(`  ${String(cap).padEnd(6)} $${r.median.toFixed(0).padEnd(10)} $${r.p10.toFixed(0).padEnd(10)} $${r.p90.toFixed(0).padEnd(10)} ${(r.killPct.toFixed(1) + "%").padEnd(11)} ${r.profitPct.toFixed(1)}%${flag}`);
  }
  console.log();
}
