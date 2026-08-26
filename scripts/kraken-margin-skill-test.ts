// Does SKILL rescue leverage? — testing Spencer's argument directly.
//
// The prior study (kraken-margin-study.ts) leveraged ONE mechanical rule (50-day SMA) and it died.
// Fair objection: "an expert reading news would hold or sell better than a moving average."
// So this script removes the strategy from the argument entirely and asks four questions:
//
//   1. HURDLE   — what gross return must ANY strategy earn just to cover financing at each leverage?
//   2. OPTIMUM  — from real volatility, what leverage is mathematically optimal, and what
//                 unlevered return would you need before 10x/20x is even the right choice?
//   3. REACTION — how fast do the liquidation-sized moves happen? If they land inside one hour,
//                 no amount of news-reading or expertise can get you out.
//   4. ORACLE   — give an agent PERFECT next-day foresight (100% directional accuracy, which no
//                 human or AI achieves) and sweep skill down to coin-flip. At each leverage,
//                 how accurate must the expert be to merely break even?
//
// Everything is generous to the leverage case: best-case fees, no fee charged for holding a
// position across days, long-only (never short into a crash).
//
// Run: npx tsx scripts/kraken-margin-skill-test.ts

import fs from "fs";
import path from "path";

type Bar = { t: number; o: number; h: number; l: number; c: number };
type Day = { key: number; open: number; close: number; bars: Bar[] };

const DATA = path.join(process.cwd(), "data", "crypto");
const SYMBOLS = ["BTC", "ETH", "SOL"];
const LEVELS = [1, 2, 3, 5, 10, 20];
const TAKER = 0.004;
const MARGIN_STOP = 40;
const START_EQUITY = 3000;
// Best-case (most generous) Kraken rollover, charged per 4h on notional.
const FEE: Record<string, number> = { BTC: 0.0001, ETH: 0.0002, SOL: 0.0002 };
const US_MAX: Record<string, number> = { BTC: 20, ETH: 10, SOL: 10 };

function loadBars(sym: string): Bar[] {
  const raw = fs.readFileSync(path.join(DATA, `${sym}.csv`), "utf8").trim().split("\n");
  const out: Bar[] = [];
  for (let i = 1; i < raw.length; i++) {
    const p = raw[i].split(",");
    const b = { t: +p[0], o: +p[1], h: +p[2], l: +p[3], c: +p[4] };
    if (Number.isFinite(b.c) && b.c > 0) out.push(b);
  }
  return out.sort((a, b) => a.t - b.t);
}

function toDays(bars: Bar[]): Day[] {
  const map = new Map<number, Bar[]>();
  for (const b of bars) {
    const k = Math.floor(b.t / 86400000);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(b);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, bs]) => ({ key, open: bs[0].o, close: bs[bs.length - 1].c, bars: bs }));
}

// Deterministic PRNG so results are reproducible.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function pct(x: number) {
  return (x * 100).toFixed(1) + "%";
}
function usd(x: number) {
  return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ---------------------------------------------------------------- 1. FINANCING HURDLE
function hurdle() {
  console.log("\n" + "=".repeat(100));
  console.log("1. THE FINANCING HURDLE — what ANY strategy must earn just to break even");
  console.log("=".repeat(100));
  console.log("   Financing is charged on NOTIONAL every 4h, so the drag on YOUR equity = leverage x rate x 6/day.");
  console.log("   Figures assume continuously invested. Half-time in market = roughly half the drag.\n");
  console.log("   coin | lev | daily drag | equity kept after 1yr | gross return needed to BREAK EVEN");
  console.log("   " + "-".repeat(92));
  for (const sym of SYMBOLS) {
    for (const lev of LEVELS) {
      if (lev === 1) continue;
      const daily = FEE[sym] * 6 * lev;
      const kept = Math.pow(1 - daily, 365);
      const need = 1 / kept - 1;
      const cap = lev > US_MAX[sym] ? "  (above US max)" : "";
      console.log(
        `   ${sym.padEnd(4)} | ${String(lev).padStart(2)}x | ${pct(daily).padStart(10)} | ${pct(kept).padStart(21)} | ${(need * 100).toFixed(0).padStart(10)}% per year${cap}`
      );
    }
  }
}

// ---------------------------------------------------------------- 2. OPTIMAL LEVERAGE
function optimum(data: Record<string, Bar[]>) {
  console.log("\n" + "=".repeat(100));
  console.log("2. OPTIMAL LEVERAGE — g(L) = L*mu - L^2*sigma^2/2 - L*c  =>  L* = (mu - c)/sigma^2");
  console.log("=".repeat(100));
  console.log("   Leverage amplifies return linearly but volatility drag QUADRATICALLY. Past L*, more leverage");
  console.log("   lowers growth even with a real edge. c = annual financing per unit of leverage.\n");
  for (const sym of SYMBOLS) {
    const days = toDays(data[sym]);
    const rets: number[] = [];
    for (let i = 1; i < days.length; i++) rets.push(days[i].close / days[i - 1].close - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varD = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    const sigma = Math.sqrt(varD * 365);
    const c = FEE[sym] * 6 * 365;
    const muActual = mean * 365;
    console.log(`   ${sym}: realised vol ${pct(sigma)}/yr, financing ${pct(c)}/yr per 1x, actual drift ${pct(muActual)}/yr`);
    const lStar = (muActual - c) / (sigma * sigma);
    console.log(`      -> optimal leverage on ACTUAL drift: ${lStar.toFixed(2)}x`);
    for (const lev of [2, 5, 10, 20]) {
      const need = c + lev * sigma * sigma;
      console.log(
        `      -> to justify ${String(lev).padStart(2)}x you need a sustained UNLEVERED return of ${(need * 100).toFixed(0)}%/yr`
      );
    }
    console.log("");
  }
}

// ---------------------------------------------------------------- 3. REACTION TIME
function reaction(data: Record<string, Bar[]>) {
  console.log("=".repeat(100));
  console.log("3. REACTION TIME — can an expert or a news feed actually get you out?");
  console.log("=".repeat(100));
  console.log("   A 10x position dies on a 6% drop; 20x on 3%. Question: how fast do those arrive?\n");
  for (const sym of SYMBOLS) {
    const bars = data[sym];
    for (const [lev, dist] of [
      [10, 0.06],
      [20, 0.03],
    ] as [number, number][]) {
      // Within a SINGLE hourly bar: high -> low move of >= dist
      let intraHour = 0;
      for (const b of bars) if (b.l / b.h - 1 <= -dist) intraHour++;
      // Within 4 hours and 24 hours: peak-to-trough from a running high
      const win = (n: number) => {
        let hits = 0;
        let tot = 0;
        for (let i = 0; i + n < bars.length; i += n) {
          tot++;
          let hi = -Infinity;
          let worst = 0;
          for (let j = i; j < i + n; j++) {
            hi = Math.max(hi, bars[j].h);
            worst = Math.min(worst, bars[j].l / hi - 1);
          }
          if (worst <= -dist) hits++;
        }
        return hits / tot;
      };
      console.log(
        `   ${sym} @ ${lev}x (dies on ${pct(dist)}): inside ONE hour ${((intraHour / bars.length) * 100).toFixed(2)}% of hours` +
          ` | within 4h ${pct(win(4))} of windows | within 24h ${pct(win(24))} of days`
      );
    }
  }
  console.log("\n   Even a PERFECT directional call gets stopped out by the path. Of days that CLOSED UP:");
  for (const sym of SYMBOLS) {
    const days = toDays(data[sym]);
    const up = days.filter((d) => d.close > d.open);
    for (const dist of [0.06, 0.03]) {
      const dipped = up.filter((d) => Math.min(...d.bars.map((b) => b.l)) / d.open - 1 <= -dist).length;
      console.log(
        `      ${sym}: ${pct(dipped / up.length)} of UP days first dipped ${pct(dist)} below the open ` +
          `(= liquidated at ${dist === 0.06 ? "10x" : "20x"} despite being right)`
      );
    }
  }
}

// ---------------------------------------------------------------- 4. SKILL ORACLE
function oracleRun(days: Day[], lev: number, feeRate: number, acc: number, rnd: () => number) {
  let equity = START_EQUITY;
  let inPos = false;
  let units = 0;
  let entryPx = 0;
  let notional = 0;
  let usedMargin = 0;
  let eqOpen = 0;
  let accrued = 0;
  let hrs = 0;
  let liq = 0;

  for (const d of days) {
    if (equity <= 0) break;
    const trueUp = d.close > d.open;
    // Agent is right with probability `acc`.
    const predUp = rnd() < acc ? trueUp : !trueUp;

    if (!inPos && predUp) {
      notional = equity * lev;
      units = notional / d.open;
      entryPx = d.open;
      usedMargin = equity;
      const fee = TAKER * notional;
      const open = lev > 1 ? feeRate * notional : 0;
      accrued = open;
      eqOpen = equity - fee;
      inPos = true;
      hrs = 0;
    } else if (inPos && !predUp) {
      const eq = eqOpen - accrued + units * (d.open - entryPx);
      equity = Math.max(0, eq - TAKER * units * d.open);
      inPos = false;
      units = 0;
      accrued = 0;
      continue;
    }

    if (!inPos) continue;

    for (const b of d.bars) {
      hrs++;
      if (lev > 1 && hrs % 4 === 0) accrued += feeRate * notional;
      const eqLow = eqOpen - accrued + units * (b.l - entryPx);
      if (lev > 1 && eqLow <= (MARGIN_STOP / 100) * usedMargin) {
        equity = Math.max(0, (MARGIN_STOP / 100) * usedMargin - TAKER * units * b.l);
        liq++;
        inPos = false;
        units = 0;
        accrued = 0;
        break;
      }
    }
    if (inPos) {
      // mark to day close, keep holding (no fee for staying in — generous)
      const eq = eqOpen - accrued + units * (d.close - entryPx);
      if (eq <= 0) {
        equity = 0;
        inPos = false;
      }
    }
  }
  if (inPos) {
    const last = days[days.length - 1];
    equity = Math.max(0, eqOpen - accrued + units * (last.close - entryPx) - TAKER * units * last.close);
  }
  return { equity, liq };
}

function oracle(data: Record<string, Bar[]>) {
  console.log("\n" + "=".repeat(100));
  console.log("4. THE SKILL ORACLE — how good would the expert have to be?");
  console.log("=".repeat(100));
  console.log("   Agent predicts each day's direction with accuracy p, goes long if up, flat if down.");
  console.log("   p=1.00 is PERFECT FORESIGHT — strictly impossible. Median of 200 seeded paths.");
  console.log("   For reference: top discretionary macro traders sustain roughly p=0.55.\n");
  const accs = [0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1.0];
  for (const sym of SYMBOLS) {
    const days = toDays(data[sym]);
    console.log(`   ${sym}  (start ${usd(START_EQUITY)}, ${days.length} days)`);
    console.log(
      "      accuracy |" + LEVELS.map((l) => `${String(l)}x`.padStart(12)).join(" |")
    );
    console.log("      " + "-".repeat(9 + LEVELS.length * 15));
    for (const acc of accs) {
      const cells: string[] = [];
      for (const lev of LEVELS) {
        const outs: number[] = [];
        const runs = acc === 1.0 ? 1 : 200;
        for (let s = 0; s < runs; s++) {
          outs.push(oracleRun(days, lev, FEE[sym], acc, lcg(s * 7919 + 13)).equity);
        }
        outs.sort((a, b) => a - b);
        const med = outs[Math.floor(outs.length / 2)];
        cells.push(usd(med).padStart(12));
      }
      const label = acc === 1.0 ? "PERFECT " : `p=${acc.toFixed(2)}`;
      console.log(`      ${label.padStart(8)} |` + cells.join(" |"));
    }
    console.log("");
  }
}

// ---------------------------------------------------------------- 5. DOES SENTIMENT PREDICT?
function sentiment(data: Record<string, Bar[]>) {
  console.log("=".repeat(100));
  console.log('5. "RESEARCH TO KNOW WHEN IT GOES UP" — does the Fear & Greed index predict returns?');
  console.log("=".repeat(100));
  const raw = fs.readFileSync(path.join(DATA, "fng.csv"), "utf8").trim().split("\n");
  const fng = new Map<number, number>();
  for (let i = 1; i < raw.length; i++) {
    const [d, v] = raw[i].split(",");
    const key = Math.floor(new Date(d + "T00:00:00Z").getTime() / 86400000);
    if (Number.isFinite(+v)) fng.set(key, +v);
  }
  for (const sym of SYMBOLS) {
    const days = toDays(data[sym]);
    const closeByKey = new Map(days.map((d) => [d.key, d.close]));
    const buckets: Record<string, number[]> = { "0-24 extreme fear": [], "25-44 fear": [], "45-55 neutral": [], "56-74 greed": [], "75-100 extreme greed": [] };
    for (const d of days) {
      const v = fng.get(d.key);
      if (v === undefined) continue;
      const fwd = closeByKey.get(d.key + 7);
      if (fwd === undefined) continue;
      const r = fwd / d.close - 1;
      const b = v <= 24 ? "0-24 extreme fear" : v <= 44 ? "25-44 fear" : v <= 55 ? "45-55 neutral" : v <= 74 ? "56-74 greed" : "75-100 extreme greed";
      buckets[b].push(r);
    }
    console.log(`\n   ${sym} — forward 7-day return by sentiment on the day you'd buy:`);
    for (const [k, arr] of Object.entries(buckets)) {
      if (!arr.length) continue;
      const m = arr.reduce((a, b) => a + b, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, arr.length - 1));
      const t = m / (sd / Math.sqrt(arr.length));
      console.log(
        `      ${k.padEnd(22)} n=${String(arr.length).padStart(4)}  avg ${pct(m).padStart(7)}  t=${t.toFixed(2).padStart(6)}` +
          (Math.abs(t) > 2 ? "  <- significant" : "")
      );
    }
  }
  console.log("\n   (t > 2 = real signal. Anything less is noise you would be paying financing to trade.)");
}

function main() {
  const data: Record<string, Bar[]> = {};
  for (const s of SYMBOLS) data[s] = loadBars(s);
  hurdle();
  optimum(data);
  reaction(data);
  oracle(data);
  sentiment(data);
}

main();
