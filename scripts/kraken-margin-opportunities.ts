// DEEP RESEARCH — how could we actually capitalise on margin trading?
//
// Everything tested so far (14 families) was DIRECTIONAL: pick a coin, pick a way, guess up or down.
// Margin adds one capability those tests never used: the ability to be SHORT and LONG at the same
// time. That unlocks two strategies that are market-neutral by construction — they do not need any
// forecast of whether crypto goes up. These are the honest candidates, and neither has been tested.
//
//   1. FUNDING CAPTURE (cash-and-carry): hold spot, short the perpetual future against it.
//      Net exposure zero. You collect the funding rate that longs pay shorts. This is how real
//      basis desks earn. Tested on a YEAR of Kraken hourly funding history.
//
//   2. PAIRS / STATISTICAL ARBITRAGE: long one coin, short a correlated one, harvest the spread
//      reverting to its mean. Market-neutral. REQUIRES margin (you must short a leg).
//      Pairs are selected IN-SAMPLE and then traded OUT-OF-SAMPLE only — selecting and testing on
//      the same data is the classic way pairs trading lies to you.
//
// Run: npx tsx scripts/kraken-margin-opportunities.ts

import fs from "fs";
import path from "path";

const FUND = path.join(process.cwd(), "data", "kraken-funding");
const CACHE = path.join(process.cwd(), "data", "kraken-universe");
const API = "https://api.kraken.com/0/public";

type Row = { t: number; c: number; qv: number };

function stat(a: number[]) {
  if (a.length < 5) return { n: a.length, m: 0, t: 0, sd: 0 };
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  return { n: a.length, m, t: sd ? m / (sd / Math.sqrt(a.length)) : 0, sd };
}

// ---------------------------------------------------------------- 1. FUNDING CAPTURE
function fundingStudy() {
  console.log("=".repeat(100));
  console.log("1. FUNDING CAPTURE (cash-and-carry) — hold spot, short the perp, collect funding");
  console.log("=".repeat(100));
  console.log("  Market-neutral by construction: no view on direction required.");
  console.log("  Positive rate = longs pay shorts = we EARN. Negative = we PAY.\n");
  console.log("  perp        | hours | annualised mean | median | % hours POSITIVE | worst 30d spell");
  console.log("  " + "-".repeat(92));

  for (const sym of ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD"]) {
    const f = path.join(FUND, `${sym}.json`);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const rates: number[] = (j.rates || [])
      .map((r: any) => +r.relativeFundingRate)
      .filter((x: number) => Number.isFinite(x));
    if (!rates.length) continue;
    const ann = rates.map((r) => r * 24 * 365);
    const s = stat(ann);
    const sorted = [...ann].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const pos = (rates.filter((r) => r > 0).length / rates.length) * 100;
    // worst rolling 30-day (720h) realised funding, annualised
    let worst = Infinity;
    for (let i = 0; i + 720 < rates.length; i += 24) {
      let s2 = 0;
      for (let j2 = i; j2 < i + 720; j2++) s2 += rates[j2];
      worst = Math.min(worst, (s2 / 720) * 24 * 365);
    }
    console.log(
      `  ${sym.padEnd(11)} | ${String(rates.length).padStart(5)} | ${(s.m * 100).toFixed(2).padStart(14)}% | ${(med * 100).toFixed(2).padStart(6)}% | ${pos.toFixed(1).padStart(15)}% | ${(worst * 100).toFixed(2).padStart(14)}%`
    );
  }

  console.log("\n  COST OF THE TRADE (both legs, per year, holding continuously):");
  console.log("    spot leg  : held outright with cash = $0 financing. (On margin it would cost 22-44%/yr — never do that.)");
  console.log("    perp leg  : Kraken futures taker ~0.05%/side, so ~0.10% round trip amortised over a long hold = negligible.");
  console.log("    => net yield is essentially the funding rate itself, minus a rounding error.");
  console.log("\n  BENCHMARK: T-bills / SPAXX ~3.9% risk-free. Funding capture must beat THAT, not zero.");
}

// ---------------------------------------------------------------- 2. PAIRS / STAT-ARB
async function liquid(): Promise<string[]> {
  const r = await (await fetch(`${API}/AssetPairs`)).json();
  const out: string[] = [];
  for (const k of Object.keys(r.result || {})) {
    const p = r.result[k];
    if (!p.wsname || !/\/USD$/.test(p.wsname)) continue;
    const lev = Math.max(0, ...(p.leverage_buy || []));
    const short = Math.max(0, ...(p.leverage_sell || []));
    const base = p.wsname.split("/")[0];
    if (["USDC", "USDT", "DAI", "PYUSD", "USDG"].includes(base)) continue;
    if (lev >= 5 && short >= 5) out.push(base); // must be shortable to trade a pair
  }
  return out;
}

async function pairsStudy() {
  console.log("\n" + "=".repeat(100));
  console.log("2. PAIRS / STAT-ARB — long one coin, short a correlated one, harvest mean reversion");
  console.log("=".repeat(100));

  const coins = (await liquid()).filter((c) => fs.existsSync(path.join(CACHE, `${c}.json`)));
  const hist: Record<string, Row[]> = {};
  for (const c of coins) {
    const r = JSON.parse(fs.readFileSync(path.join(CACHE, `${c}.json`), "utf8")) as Row[];
    if (r.length > 300) hist[c] = r;
  }
  const names = Object.keys(hist);
  const dates = [...new Set(names.flatMap((c) => hist[c].map((r) => r.t)))].sort((a, b) => a - b);
  const px: Record<string, Map<number, number>> = {};
  for (const c of names) px[c] = new Map(hist[c].map((r) => [r.t, r.c]));
  const common = dates.filter((d) => names.every((c) => px[c].has(d)));
  const SPLIT = Math.floor(common.length * 0.55);
  console.log(`  ${names.length} shortable liquid coins, ${common.length} common days, split at day ${SPLIT} (${new Date(common[SPLIT]).toISOString().slice(0, 10)})\n`);

  // Round-trip cost: 4 legs (in A, in B, out A, out B) at 0.20% taker + ~0.03% half-spread each.
  const LEG = 0.002 + 0.0003;
  const ROLL_D = 0.0002 * 6; // per day, per leg on margin

  // --- select pairs IN-SAMPLE on spread mean-reversion quality
  type Cand = { a: string; b: string; beta: number; halfLife: number; score: number };
  const cands: Cand[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const A = names[i], B = names[j];
      const la: number[] = [], lb: number[] = [];
      for (let d = 0; d < SPLIT; d++) { la.push(Math.log(px[A].get(common[d])!)); lb.push(Math.log(px[B].get(common[d])!)); }
      const ma = la.reduce((x, y) => x + y, 0) / la.length, mb = lb.reduce((x, y) => x + y, 0) / lb.length;
      let cov = 0, vb = 0;
      for (let k = 0; k < la.length; k++) { cov += (la[k] - ma) * (lb[k] - mb); vb += (lb[k] - mb) ** 2; }
      if (!vb) continue;
      const beta = cov / vb;
      if (beta < 0.2 || beta > 5) continue;
      const spr = la.map((x, k) => x - beta * lb[k]);
      // Ornstein-Uhlenbeck half-life via AR(1) on the spread
      const ms = spr.reduce((x, y) => x + y, 0) / spr.length;
      let num = 0, den = 0;
      for (let k = 1; k < spr.length; k++) { num += (spr[k - 1] - ms) * (spr[k] - spr[k - 1]); den += (spr[k - 1] - ms) ** 2; }
      if (!den) continue;
      const lambda = num / den;
      if (lambda >= 0) continue; // not mean-reverting
      const halfLife = -Math.log(2) / Math.log(1 + lambda);
      if (!(halfLife > 1 && halfLife < 30)) continue; // tradeable speed
      const sd = Math.sqrt(spr.reduce((x, y) => x + (y - ms) ** 2, 0) / spr.length);
      cands.push({ a: A, b: B, beta, halfLife, score: sd / halfLife });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const chosen = cands.slice(0, 20);
  console.log(`  ${cands.length} pairs mean-revert in-sample (half-life 1-30d). Trading the top 20 OUT-OF-SAMPLE only.\n`);
  if (!chosen.length) { console.log("  No cointegrated pairs found."); return; }
  console.log("  Top selections (chosen on IS data alone):");
  for (const c of chosen.slice(0, 8)) console.log(`    ${c.a}/${c.b}  beta ${c.beta.toFixed(2)}  half-life ${c.halfLife.toFixed(1)}d`);

  // --- trade them OOS
  const run = (from: number, to: number) => {
    const trades: number[] = [];
    for (const c of chosen) {
      const win = 60;
      let pos = 0, entrySpread = 0, entryDay = 0;
      for (let d = from + win; d < to; d++) {
        const hist2: number[] = [];
        for (let k = d - win; k <= d; k++) hist2.push(Math.log(px[c.a].get(common[k])!) - c.beta * Math.log(px[c.b].get(common[k])!));
        const m = hist2.reduce((x, y) => x + y, 0) / hist2.length;
        const sd = Math.sqrt(hist2.reduce((x, y) => x + (y - m) ** 2, 0) / hist2.length);
        if (!sd) continue;
        const cur = hist2[hist2.length - 1];
        const z = (cur - m) / sd;
        if (pos === 0 && Math.abs(z) > 2) { pos = z > 0 ? -1 : 1; entrySpread = cur; entryDay = d; }
        else if (pos !== 0 && (Math.abs(z) < 0.5 || d - entryDay > c.halfLife * 3)) {
          const gross = pos * (cur - entrySpread);           // spread P&L, both legs
          const days = d - entryDay;
          const net = gross - 4 * LEG - 2 * ROLL_D * days;   // 4 legs + financing on both sides
          trades.push(net);
          pos = 0;
        }
      }
    }
    return trades;
  };

  const isT = run(0, SPLIT);
  const oosT = run(SPLIT, common.length);
  const si = stat(isT), so = stat(oosT);
  console.log(`\n  IN-SAMPLE  (pairs chosen here — expect it to look good): ${si.n} trades, ${(si.m * 100).toFixed(2)}%/trade net, t=${si.t.toFixed(2)}`);
  console.log(`  OUT-OF-SAMPLE (the only number that counts)             : ${so.n} trades, ${(so.m * 100).toFixed(2)}%/trade net, t=${so.t.toFixed(2)}`);
  const tot = oosT.reduce((a, b) => a + b, 0);
  console.log(`  OOS total across all 20 pairs: ${(tot * 100).toFixed(1)}% of one unit of capital`);
  if (so.t > 2) {
    const kelly = so.sd ? so.m / so.sd ** 2 : 0;
    console.log(`  -> SURVIVES. Kelly leverage ${kelly.toFixed(1)}x (half-Kelly ${(kelly / 2).toFixed(1)}x)`);
  } else {
    console.log(`  -> does not survive out of sample.`);
  }
  console.log(`\n  Cost drag per round trip: ${(4 * LEG * 100).toFixed(2)}% in fees+spread alone, before any financing.`);
}

async function main() {
  fundingStudy();
  await pairsStudy();
}
main();
