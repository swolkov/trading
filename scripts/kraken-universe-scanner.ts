// KRAKEN MARGIN UNIVERSE SCANNER — does breadth find an edge?
//
// Spencer: "can't we build bots to track all of the cryptos and the ones we can margin?"
// Prior studies covered 7 coins. Kraken has ~132 margin-eligible USD pairs. This tests whether
// scanning the WHOLE margin universe surfaces anything the 7-coin study missed.
//
// The right diagnostic is the INFORMATION COEFFICIENT (IC) — the rank correlation between a
// signal and the forward return it is supposed to predict. Grinold's Fundamental Law:
//        IR  =  IC  x  sqrt(breadth)
// Breadth AMPLIFIES skill; it does not create it. If IC is ~0, scanning 132 coins instead of 7
// multiplies zero by 4.3 and still gets zero. So: measure IC directly, then decide.
//
// Also fetches REAL bid/ask spreads — on the 3x long-tail the spread alone can exceed the entire
// edge budget, which decides whether those coins are tradeable at all.
//
// SURVIVORSHIP WARNING: Kraken's CURRENT margin list only contains coins that survived to today.
// Delisted losers are absent, which biases every result UPWARD. A negative result here is
// therefore doubly damning; a positive one would need re-testing on a point-in-time list.
//
// Run: npx tsx scripts/kraken-universe-scanner.ts

import fs from "fs";
import path from "path";

const CACHE = path.join(process.cwd(), "data", "kraken-universe");
const API = "https://api.kraken.com/0/public";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pair = { key: string; ws: string; base: string; lev: number; spreadBp?: number };
type Row = { t: number; c: number; qv: number };

async function jget(url: string, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j.error?.length && String(j.error).includes("Rate limit")) { await sleep(3000); continue; }
      if (j.error?.length) return null;
      return j.result;
    } catch { await sleep(1500); }
  }
  return null;
}

async function getPairs(): Promise<Pair[]> {
  const r = await jget(`${API}/AssetPairs`);
  const out: Pair[] = [];
  for (const key of Object.keys(r || {})) {
    const p = r[key];
    if (!p.wsname || !/\/USD$/.test(p.wsname)) continue;
    const lev = Math.max(0, ...(p.leverage_buy || []));
    if (!lev) continue;
    const base = p.wsname.split("/")[0];
    if (["USDC", "USDT", "DAI", "PYUSD", "USDG"].includes(base)) continue; // stablecoins aren't trades
    out.push({ key, ws: p.wsname, base, lev });
  }
  return out;
}

async function addSpreads(pairs: Pair[]) {
  for (let i = 0; i < pairs.length; i += 20) {
    const chunk = pairs.slice(i, i + 20);
    const r = await jget(`${API}/Ticker?pair=${chunk.map((p) => p.key).join(",")}`);
    if (r) {
      for (const p of chunk) {
        const t = r[p.key];
        if (!t) continue;
        const ask = +t.a[0], bid = +t.b[0];
        if (ask > 0 && bid > 0) p.spreadBp = ((ask - bid) / ((ask + bid) / 2)) * 10000;
      }
    }
    await sleep(400);
  }
}

async function getDaily(p: Pair): Promise<Row[]> {
  const f = path.join(CACHE, `${p.base}.json`);
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* refetch */ }
  }
  const r = await jget(`${API}/OHLC?pair=${p.key}&interval=1440`);
  const arr = r?.[p.key] || r?.[Object.keys(r || {}).find((k) => k !== "last") || ""] || [];
  const rows: Row[] = arr.map((a: any[]) => ({ t: +a[0] * 1000, c: +a[4], qv: +a[6] * +a[4] }));
  if (rows.length) fs.writeFileSync(f, JSON.stringify(rows));
  await sleep(400);
  return rows;
}

// Spearman rank correlation
function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 5) return 0;
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n).fill(0);
    for (let i = 0; i < n; i++) r[idx[i][1]] = i + 1;
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const ma = (n + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function stat(a: number[]) {
  if (a.length < 5) return { n: a.length, m: 0, t: 0, sd: 0 };
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  return { n: a.length, m, t: sd ? m / (sd / Math.sqrt(a.length)) : 0, sd };
}

const SIGNALS: [string, (h: number[], v: number[]) => number][] = [
  ["mom_30d", (h) => h[h.length - 1] / h[h.length - 31] - 1],
  ["mom_7d", (h) => h[h.length - 1] / h[h.length - 8] - 1],
  ["rev_3d", (h) => -(h[h.length - 1] / h[h.length - 4] - 1)],
  ["lowvol", (h) => { let s = 0; for (let i = h.length - 20; i < h.length; i++) s += ((h[i] / h[i - 1] - 1) ** 2); return -Math.sqrt(s / 20); }],
  ["nearHigh", (h) => { let hi = 0; for (let i = h.length - 60; i < h.length; i++) hi = Math.max(hi, h[i]); return h[h.length - 1] / hi; }],
  ["volsurge", (_h, v) => { let a = 0, b = 0; for (let i = v.length - 5; i < v.length; i++) a += v[i]; for (let i = v.length - 30; i < v.length; i++) b += v[i]; return b ? a / 5 / (b / 30) : 0; }],
];

async function main() {
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
  console.log("Fetching Kraken margin universe…");
  const pairs = await getPairs();
  await addSpreads(pairs);
  console.log(`  ${pairs.length} margin-eligible USD pairs (stablecoins excluded)\n`);

  // ---- spread reality check
  console.log("=".repeat(100));
  console.log("1. CAN WE EVEN TRADE THESE? — live bid/ask spread by leverage tier");
  console.log("=".repeat(100));
  console.log("  Round-trip cost = spread + 2x taker fee. Budget for a 3-day edge is ~1.1%. Spread alone can exceed it.\n");
  for (const tier of [10, 5, 4, 3]) {
    const g = pairs.filter((p) => p.lev === tier && p.spreadBp !== undefined);
    if (!g.length) continue;
    const sp = g.map((p) => p.spreadBp!).sort((a, b) => a - b);
    const med = sp[Math.floor(sp.length / 2)];
    const worst = sp[sp.length - 1];
    console.log(
      `  ${String(tier).padStart(2)}x tier: ${String(g.length).padStart(3)} pairs | median spread ${(med / 100).toFixed(3)}% | worst ${(worst / 100).toFixed(2)}% | ` +
        `median round-trip w/ fees ${((med / 100) + 0.4).toFixed(2)}%`
    );
  }

  console.log("\nDownloading daily history (cached after first run)…");
  const hist: Record<string, Row[]> = {};
  let done = 0;
  for (const p of pairs) {
    const r = await getDaily(p);
    if (r.length > 120) hist[p.base] = r;
    if (++done % 25 === 0) console.log(`  ${done}/${pairs.length}`);
  }
  const coins = Object.keys(hist);
  console.log(`  ${coins.length} coins with >120 days of history\n`);

  // align on a common date axis
  const allDates = [...new Set(coins.flatMap((c) => hist[c].map((r) => r.t)))].sort((a, b) => a - b);
  const px: Record<string, Map<number, Row>> = {};
  for (const c of coins) px[c] = new Map(hist[c].map((r) => [r.t, r]));

  const SPLIT = allDates[Math.floor(allDates.length * 0.55)];
  console.log("=".repeat(100));
  console.log("2. INFORMATION COEFFICIENT — does any signal rank the universe correctly?");
  console.log("=".repeat(100));
  console.log(`  ${allDates.length} days, split at ${new Date(SPLIT).toISOString().slice(0, 10)}.`);
  console.log("  IC = rank correlation between signal and forward return. IC of 0.05 is considered GOOD in equities.");
  console.log("  Fundamental Law: IR = IC x sqrt(breadth). With 130 coins, sqrt(breadth) = 11.4.\n");
  console.log("  signal      hold |   IS: avg IC / t    |  OOS: avg IC / t    | verdict");
  console.log("  " + "-".repeat(88));

  const results: any[] = [];
  for (const [sname, fn] of SIGNALS) {
    for (const H of [3, 7]) {
      const icIS: number[] = [], icOOS: number[] = [];
      const retIS: number[] = [], retOOS: number[] = [];
      for (let d = 60; d + H < allDates.length; d += H) {
        const day = allDates[d], fwd = allDates[d + H];
        const sig: number[] = [], ret: number[] = [], names: string[] = [];
        for (const c of coins) {
          const rows = hist[c];
          const i = rows.findIndex((r) => r.t === day);
          if (i < 60) continue;
          const nowR = px[c].get(day), fwdR = px[c].get(fwd);
          if (!nowR || !fwdR) continue;
          const h = rows.slice(0, i + 1).map((r) => r.c);
          const v = rows.slice(0, i + 1).map((r) => r.qv);
          if (h.length < 61) continue;
          // liquidity floor: need $250k/day to absorb a leveraged $3k account
          const adv = v.slice(-20).reduce((a, b) => a + b, 0) / 20;
          if (!(adv > 250000)) continue;
          const s = fn(h, v);
          if (!Number.isFinite(s)) continue;
          sig.push(s); ret.push(fwdR.c / nowR.c - 1); names.push(c);
        }
        if (sig.length < 20) continue;
        const ic = spearman(sig, ret);
        // top-decile long portfolio, net of 0.20%/side + spread proxy 0.15% + rollover
        const order = sig.map((s, i) => [s, i] as [number, number]).sort((a, b) => b[0] - a[0]);
        const topN = Math.max(3, Math.floor(sig.length * 0.1));
        let r = 0;
        for (let k = 0; k < topN; k++) r += ret[order[k][1]];
        r = r / topN - (2 * 0.002 + 0.0015 + 0.0002 * 6 * H);
        if (day < SPLIT) { icIS.push(ic); retIS.push(r); } else { icOOS.push(ic); retOOS.push(r); }
      }
      const a = stat(icIS), b = stat(icOOS);
      const ra = stat(retIS), rb = stat(retOOS);
      const survives = a.t > 2 && b.t > 2;
      results.push({ sname, H, a, b, ra, rb, survives });
      console.log(
        `  ${sname.padEnd(10)} ${String(H).padStart(2)}d | ${a.m.toFixed(4).padStart(9)} t=${a.t.toFixed(2).padStart(6)} | ${b.m.toFixed(4).padStart(9)} t=${b.t.toFixed(2).padStart(6)} | ` +
          (survives ? "SURVIVES" : b.t > 2 ? "OOS only" : a.t > 2 ? "IS only (overfit)" : "no signal")
      );
    }
  }

  console.log("\n  Top-decile long portfolio, NET of costs, per rebalance:");
  console.log("  signal      hold |  IS net%/period  t   |  OOS net%/period  t");
  console.log("  " + "-".repeat(70));
  for (const r of results) {
    console.log(
      `  ${r.sname.padEnd(10)} ${String(r.H).padStart(2)}d | ${(r.ra.m * 100).toFixed(2).padStart(8)}% ${r.ra.t.toFixed(2).padStart(6)} | ${(r.rb.m * 100).toFixed(2).padStart(9)}% ${r.rb.t.toFixed(2).padStart(6)}`
    );
  }

  const surv = results.filter((r) => r.survives);
  const oosPos = results.filter((r) => r.b.t > 2);
  console.log("\n" + "=".repeat(100));
  console.log("VERDICT");
  console.log("=".repeat(100));
  console.log(`  Cells tested            : ${results.length} (${SIGNALS.length} signals x 2 horizons)`);
  console.log(`  Expected false positives: ${(results.length * 0.05).toFixed(1)} at p<0.05`);
  console.log(`  Positive OOS            : ${oosPos.length}`);
  console.log(`  SURVIVED BOTH HALVES    : ${surv.length}`);
  const bestIC = Math.max(...results.map((r) => Math.abs(r.b.m)));
  console.log(`  Best absolute OOS IC    : ${bestIC.toFixed(4)}`);
  console.log(`\n  Breadth check: to earn an information ratio of 1.0 across ~130 coins you need IC = 1/sqrt(130) = ${(1 / Math.sqrt(130)).toFixed(3)}.`);
  console.log(`  Our best measured OOS IC is ${bestIC.toFixed(4)} — that is ${(bestIC / (1 / Math.sqrt(130)) * 100).toFixed(0)}% of what is needed.`);
}

main();
