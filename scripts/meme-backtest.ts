// Meme Lab backtest — replays REAL pump.fun graduate price paths (GeckoTerminal free OHLCV)
// through a matrix of {entry timing} × {exit rules} to see which, if any, would have made money.
// Honest about its limits: no historical liquidity/holders/buy-pressure, and delisted rugs are
// under-sampled (survivorship) — so real-world results are likely WORSE than this shows.
/* eslint-disable @typescript-eslint/no-explicit-any */

const GT = "https://api.geckoterminal.com/api/v2";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// throttle GeckoTerminal free tier (~30/min) → ~1 req / 2.2s, retry on 429
let lastCall = 0;
async function gt(path: string, tries = 4): Promise<any> {
  for (let t = 0; t < tries; t++) {
    const wait = 2200 - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const r = await fetch(GT + path, { headers: { accept: "application/json" } });
      if (r.status === 429) { await sleep(4000 * (t + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1500); }
  }
  return null;
}

// mirror the live bot's slippage model exactly (meme-scanner.ts slipFor)
const slipFor = (liq: number) => (liq < 25000 ? 0.15 : liq < 75000 ? 0.08 : 0.05);

const SIZE = 20;                 // $ per trade (live size)
const CANDLE_MIN = 5;            // 5-min candles
const PER_HR = 60 / CANDLE_MIN;  // 12 candles/hr

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type Pool = { addr: string; name: string; created: number; liqNow: number };

// ── sample a broad set of pump.fun graduate pools with forward price paths ──
async function samplePools(): Promise<Pool[]> {
  const seen = new Map<string, Pool>();
  const now = Date.now();
  const sorts = ["h24_volume_usd_desc", "h24_tx_count_desc"];
  for (const sort of sorts) {
    for (let pg = 1; pg <= 10; pg++) {
      const d = await gt(`/networks/solana/dexes/pumpswap/pools?page=${pg}&sort=${sort}`);
      const arr = d?.data || [];
      if (!arr.length) break;
      for (const p of arr) {
        const a = p.attributes;
        const addr = String(p.id).replace("solana_", "");
        const created = a.pool_created_at ? Date.parse(a.pool_created_at) : 0;
        const ageH = (now - created) / 3.6e6;
        // need a forward path: created ≥18h ago (fate mostly decided in hrs) and ≤14d (data depth)
        if (ageH < 18 || ageH > 24 * 14) continue;
        if (!seen.has(addr)) seen.set(addr, { addr, name: a.name || addr, created, liqNow: parseFloat(a.reserve_in_usd) || 0 });
      }
    }
  }
  return [...seen.values()];
}

// first 24h of 5-min candles starting at graduation (before_timestamp = created + 24h)
async function fetchPath(p: Pool): Promise<Candle[]> {
  const before = Math.floor(p.created / 1000) + 24 * 3600;
  const d = await gt(`/networks/solana/pools/${p.addr}/ohlcv/minute?aggregate=${CANDLE_MIN}&before_timestamp=${before}&limit=288&currency=usd`);
  const raw: any[] = d?.data?.attributes?.ohlcv_list || [];
  let cs = raw
    .map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }))
    .filter((c) => c.c > 0 && c.h > 0 && c.l > 0)
    .sort((a, b) => a.t - b.t); // ascending = forward in time
  if (cs.length < 6) return cs;
  // DE-GLITCH: GeckoTerminal occasionally emits a near-zero or astronomical wick (bad decimals).
  // Drop candles whose close is >50× or <1/50 the median close of the path — real memes are wild
  // but a single 5-min bar 50× off the whole path's median is a data artifact, not a tradeable price.
  const med = [...cs].map((c) => c.c).sort((a, b) => a - b)[Math.floor(cs.length / 2)];
  cs = cs.filter((c) => c.c <= med * 50 && c.c >= med / 50 && c.h <= med * 50 && c.l >= med / 50);
  return cs;
}

// ── ENTRY strategies: return the candle index to enter at, or -1 if never ──
type Entry = { key: string; find: (cs: Candle[]) => number };
const M15 = 3, H1 = 12;
const pctUp = (cs: Candle[], i: number, back: number) => (i - back >= 0 ? cs[i].c / cs[i - back].c - 1 : 0);

const ENTRIES: Entry[] = [
  // buy the graduation itself (earliest possible), once a couple candles exist
  { key: "EARLY_grad", find: (cs) => (cs.length > 3 ? 2 : -1) },
  // current bot: first "accelerating" candle — m15≥+8% & h1≥+5%, anti-chase h1≤+60%
  { key: "LATE_bot", find: (cs) => {
    for (let i = H1; i < cs.length; i++) { const m15 = pctUp(cs, i, M15), h1 = pctUp(cs, i, H1);
      if (m15 >= 0.08 && h1 >= 0.05 && h1 <= 0.60) return i; } return -1; } },
  // stricter late: needs a bigger burst
  { key: "LATE_strict", find: (cs) => {
    for (let i = H1; i < cs.length; i++) { const m15 = pctUp(cs, i, M15), h1 = pctUp(cs, i, H1);
      if (m15 >= 0.15 && h1 >= 0.10 && h1 <= 0.60) return i; } return -1; } },
  // contrarian: buy the first −20% dip off an early peak in the first 2 hours
  { key: "DIP_early", find: (cs) => { let peak = cs[0]?.c || 0;
    for (let i = 1; i < Math.min(cs.length, 24); i++) { peak = Math.max(peak, cs[i].h);
      if (cs[i].c <= peak * 0.80) return i; } return -1; } },
];

// ── EXIT strategies: walk forward from entry, return realized $ on SIZE ──
type Exit = { key: string; run: (cs: Candle[], e: number, liq: number) => number };

const MAX_MULT = 50; // conservative cap: assume you cannot realistically extract more than 50× through a thin meme pool
const clampGain = (g: number) => Math.min(g, MAX_MULT - 1);

function realize(entryFill: number, cs: Candle[], e: number, liq: number, rules: {
  scaleAt?: number; scaleFrac?: number; trailArm?: number; trailGive?: number;
  tpFull?: number; stop: number; rugAtEntryMult?: number; timeH?: number;
}): number {
  const slip = slipFor(liq);
  const rugMult = rules.rugAtEntryMult ?? 0.15;
  const timeC = (rules.timeH ?? 24) * PER_HR;
  let peak = entryFill;
  let scaled = false, remain = 1, banked = 0;
  for (let i = e + 1; i < cs.length && i - e <= timeC; i++) {
    const px = cs[i].c;
    peak = Math.max(peak, cs[i].h);
    const gain = px / entryFill - 1;
    const peakGain = peak / entryFill - 1;
    // rug / capitulation
    if (px <= entryFill * rugMult) return banked + SIZE * remain * clampGain((px * (1 - slip)) / entryFill - 1);
    // scale out a fraction at target, keep runner
    if (rules.scaleAt != null && !scaled && gain >= rules.scaleAt) {
      const f = rules.scaleFrac ?? 0.5;
      banked += SIZE * f * clampGain((px * (1 - slip)) / entryFill - 1);
      remain -= f; scaled = true; continue;
    }
    // full take-profit (scalp)
    if (rules.tpFull != null && gain >= rules.tpFull) return banked + SIZE * remain * clampGain((px * (1 - slip)) / entryFill - 1);
    // after scaling, protect remainder at breakeven
    if (scaled && px <= entryFill) return banked + SIZE * remain * clampGain((px * (1 - slip)) / entryFill - 1);
    // trailing stop once armed
    if (rules.trailArm != null && peakGain >= rules.trailArm && px <= peak * (rules.trailGive ?? 0.7))
      return banked + SIZE * remain * clampGain((px * (1 - slip)) / entryFill - 1);
    // hard stop (only meaningful pre-scale)
    if (!scaled && gain <= rules.stop) return banked + SIZE * remain * clampGain((px * (1 - slip)) / entryFill - 1);
  }
  // timed out → mark out remainder at last close
  const last = cs[Math.min(cs.length - 1, e + timeC)].c;
  return banked + SIZE * remain * clampGain((last * (1 - slip)) / entryFill - 1);
}

const EXITS: Exit[] = [
  { key: "BOT_current", run: (cs, e, liq) => realize(cs[e].c * (1 + slipFor(liq)), cs, e, liq, { scaleAt: 1.0, scaleFrac: 0.5, trailArm: 1.0, trailGive: 0.7, stop: -0.40 }) },
  { key: "TRAIL_early", run: (cs, e, liq) => realize(cs[e].c * (1 + slipFor(liq)), cs, e, liq, { scaleAt: 1.0, scaleFrac: 0.5, trailArm: 0.40, trailGive: 0.7, stop: -0.40 }) },
  { key: "SCALP_40",    run: (cs, e, liq) => realize(cs[e].c * (1 + slipFor(liq)), cs, e, liq, { tpFull: 0.40, stop: -0.25 }) },
  { key: "RIDE_wide",   run: (cs, e, liq) => realize(cs[e].c * (1 + slipFor(liq)), cs, e, liq, { stop: -0.55, rugAtEntryMult: 0.15 }) },
  { key: "RECOVER_ride",run: (cs, e, liq) => realize(cs[e].c * (1 + slipFor(liq)), cs, e, liq, { scaleAt: 0.60, scaleFrac: 0.6, stop: -0.50, rugAtEntryMult: 0.15 }) },
];

function stats(pnls: number[]) {
  if (!pnls.length) return null;
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0).length;
  const sorted = [...pnls].sort((a, b) => a - b);
  const best = sorted[sorted.length - 1], worst = sorted[0];
  const topShare = best > 0 ? best / Math.max(total, 0.01) : 0;
  return { n: pnls.length, total, avg: total / pnls.length, winRate: wins / pnls.length, best, worst, topShare };
}

async function main() {
  console.log("Sampling pump.fun graduate pools…");
  const pools = await samplePools();
  console.log(`sampled ${pools.length} unique pools (created 18h–14d ago)`);

  const paths: { p: Pool; cs: Candle[] }[] = [];
  let firstHrVolFiltered = 0, noData = 0;
  for (let i = 0; i < pools.length; i++) {
    const cs = await fetchPath(pools[i]);
    if (cs.length < H1 + 6) { noData++; continue; }
    // graduation-quality gate (data-driven, mirrors minH1Vol=$8k): real first-hour trading
    const firstHrVol = cs.slice(0, H1).reduce((a, c) => a + (c.v || 0), 0);
    if (firstHrVol < 8000) { firstHrVolFiltered++; continue; }
    paths.push({ p: pools[i], cs });
    if ((i + 1) % 20 === 0) console.log(`  fetched ${i + 1}/${pools.length} · usable ${paths.length}`);
  }
  console.log(`\nUsable paths: ${paths.length}  (dropped ${noData} no-data, ${firstHrVolFiltered} thin-first-hour)\n`);

  const results: any[] = [];
  for (const en of ENTRIES) {
    for (const ex of EXITS) {
      const pnls: number[] = [];
      for (const { p, cs } of paths) {
        const e = en.find(cs);
        if (e < 0 || e >= cs.length - 2) continue;
        const liq = p.liqNow > 0 ? p.liqNow : 10000; // proxy: dead pools → thin-book slip
        pnls.push(ex.run(cs, e, liq));
      }
      const s = stats(pnls);
      if (s) results.push({ entry: en.key, exit: ex.key, ...s });
    }
  }

  results.sort((a, b) => b.total - a.total);
  console.log("ENTRY × EXIT              n    total$    avg$   win%   best$   worst$  top1share");
  console.log("─".repeat(84));
  for (const r of results) {
    console.log(
      `${(r.entry + " × " + r.exit).padEnd(24)} ${String(r.n).padStart(3)}  ${r.total.toFixed(0).padStart(7)}  ${r.avg.toFixed(1).padStart(6)}  ${(r.winRate * 100).toFixed(0).padStart(4)}%  ${r.best.toFixed(0).padStart(6)}  ${r.worst.toFixed(0).padStart(6)}   ${(r.topShare * 100).toFixed(0).padStart(3)}%`,
    );
  }
  console.log("\ntop1share = % of a strategy's total profit that comes from its single best trade (fat-tail dependence).");
  console.log(`Sample: ${paths.length} real graduate price paths. Caveat: no historical liq/holders; delisted rugs under-sampled → real edge ≤ shown.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
