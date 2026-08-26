// IS THE LOWVOL SIGNAL REAL ALPHA, OR JUST A SHORT-BETA BET IN DISGUISE?
//
// The universe scan found `lowvol` surviving both halves with OOS IC = 0.15 (high — 0.05 is
// "good" in equities) while the long-only top-decile portfolio still LOST money.
//
// That combination has one overwhelmingly likely explanation: the OOS window (2025-10 -> 2026-06)
// was a crypto bear, and low-volatility coins simply fall less than high-volatility coins. That is
// BETA, not alpha — the ranking is "correct" only because it sorts by market sensitivity.
//
// Three tests that separate the two:
//   A. MARKET-NEUTRAL   — long low-vol / short high-vol, dollar neutral. If the IC is real alpha
//                         this harvests it regardless of market direction.
//   B. REGIME SPLIT     — does it work in UP periods as well as DOWN periods? Alpha does. Short-beta doesn't.
//   C. BETA DIAGNOSTIC  — correlation of strategy return vs the equal-weight universe. Strongly
//                         negative = we have simply built an expensive way to be short the market.
//
// Liquid universe only (10x and 5x tiers): the 3x long tail has spreads up to 3.78%, which no
// 3-day edge can survive, and shorting illiquid meme coins is worse still.
//
// Run: npx tsx scripts/kraken-lowvol-neutral.ts   (uses the cache from kraken-universe-scanner.ts)

import fs from "fs";
import path from "path";

const CACHE = path.join(process.cwd(), "data", "kraken-universe");
const API = "https://api.kraken.com/0/public";
type Row = { t: number; c: number; qv: number };

async function liquidPairs(): Promise<Record<string, number>> {
  const r = await (await fetch(`${API}/AssetPairs`)).json();
  const out: Record<string, number> = {};
  for (const k of Object.keys(r.result || {})) {
    const p = r.result[k];
    if (!p.wsname || !/\/USD$/.test(p.wsname)) continue;
    const lev = Math.max(0, ...(p.leverage_buy || []));
    const base = p.wsname.split("/")[0];
    if (["USDC", "USDT", "DAI", "PYUSD", "USDG"].includes(base)) continue;
    if (lev >= 5) out[base] = lev; // 10x + 5x tiers only
  }
  return out;
}

function stat(a: number[]) {
  if (a.length < 5) return { n: a.length, m: 0, t: 0, sd: 0 };
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  return { n: a.length, m, t: sd ? m / (sd / Math.sqrt(a.length)) : 0, sd };
}
function corr(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

async function main() {
  const lev = await liquidPairs();
  const hist: Record<string, Row[]> = {};
  for (const base of Object.keys(lev)) {
    const f = path.join(CACHE, `${base}.json`);
    if (!fs.existsSync(f)) continue;
    const r = JSON.parse(fs.readFileSync(f, "utf8")) as Row[];
    if (r.length > 120) hist[base] = r;
  }
  const coins = Object.keys(hist);
  console.log(`Liquid margin universe (10x + 5x tiers): ${coins.length} coins with history\n`);

  const allDates = [...new Set(coins.flatMap((c) => hist[c].map((r) => r.t)))].sort((a, b) => a - b);
  const px: Record<string, Map<number, Row>> = {};
  for (const c of coins) px[c] = new Map(hist[c].map((r) => [r.t, r]));
  const SPLIT = allDates[Math.floor(allDates.length * 0.55)];

  // Cost per leg: 0.20% taker/side + ~0.05% spread (liquid tiers) + rollover for the hold.
  const legCost = (H: number) => 2 * 0.002 + 0.0005 + 0.0002 * 6 * H;

  for (const H of [3, 7]) {
    console.log("=".repeat(100));
    console.log(`MARKET-NEUTRAL LOWVOL — long low-vol decile / short high-vol decile, ${H}-day hold`);
    console.log("=".repeat(100));

    const rows: { t: number; net: number; mkt: number; longR: number; shortR: number }[] = [];
    for (let d = 60; d + H < allDates.length; d += H) {
      const day = allDates[d], fwd = allDates[d + H];
      const vol: number[] = [], ret: number[] = [];
      for (const c of coins) {
        const rows2 = hist[c];
        const i = rows2.findIndex((r) => r.t === day);
        if (i < 60) continue;
        const now = px[c].get(day), f2 = px[c].get(fwd);
        if (!now || !f2) continue;
        const adv = rows2.slice(i - 19, i + 1).reduce((a, b) => a + b.qv, 0) / 20;
        if (!(adv > 250000)) continue;
        let s = 0;
        for (let j = i - 19; j <= i; j++) s += (rows2[j].c / rows2[j - 1].c - 1) ** 2;
        vol.push(Math.sqrt(s / 20));
        ret.push(f2.c / now.c - 1);
      }
      if (vol.length < 20) continue;
      const order = vol.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
      const N = Math.max(3, Math.floor(vol.length * 0.1));
      let lo = 0, hi = 0;
      for (let k = 0; k < N; k++) lo += ret[order[k][1]];
      for (let k = order.length - N; k < order.length; k++) hi += ret[order[k][1]];
      lo /= N; hi /= N;
      const mkt = ret.reduce((a, b) => a + b, 0) / ret.length;
      // dollar-neutral: half capital each leg, costs on BOTH legs
      const net = 0.5 * (lo - hi) - legCost(H);
      rows.push({ t: day, net, mkt, longR: lo, shortR: hi });
    }

    const is = rows.filter((r) => r.t < SPLIT), oos = rows.filter((r) => r.t >= SPLIT);
    const sIS = stat(is.map((r) => r.net)), sOOS = stat(oos.map((r) => r.net));
    console.log(`  A. MARKET-NEUTRAL net of costs:`);
    console.log(`       IS : ${(sIS.m * 100).toFixed(2)}%/period  t=${sIS.t.toFixed(2)}  (n=${sIS.n})`);
    console.log(`       OOS: ${(sOOS.m * 100).toFixed(2)}%/period  t=${sOOS.t.toFixed(2)}  (n=${sOOS.n})`);

    const up = oos.filter((r) => r.mkt > 0), dn = oos.filter((r) => r.mkt <= 0);
    const sUp = stat(up.map((r) => r.net)), sDn = stat(dn.map((r) => r.net));
    console.log(`  B. REGIME SPLIT (out-of-sample):`);
    console.log(`       market UP   periods: ${(sUp.m * 100).toFixed(2)}%/period  t=${sUp.t.toFixed(2)}  (n=${sUp.n})`);
    console.log(`       market DOWN periods: ${(sDn.m * 100).toFixed(2)}%/period  t=${sDn.t.toFixed(2)}  (n=${sDn.n})`);

    const c = corr(rows.map((r) => r.net), rows.map((r) => r.mkt));
    console.log(`  C. BETA DIAGNOSTIC: correlation with the equal-weight universe = ${c.toFixed(3)}`);
    console.log(
      `       -> ${c < -0.5 ? "STRONGLY NEGATIVE: this is a short-beta bet, NOT alpha." : c < -0.2 ? "negative: substantially a market hedge, not alpha." : "near zero: genuinely market-neutral."}`
    );
    console.log("");
  }
}

main();
