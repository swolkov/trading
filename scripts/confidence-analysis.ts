// CONFIDENCE ANALYSIS — does "how extreme is the setup" (entry RSI) actually predict outcome?
// If yes, confidence-tiered sizing (bet more on stronger setups) is justified. If flat, it's noise.
// Tests the RSI-bounce edge (the flagship gold edge + the index overbought-short) on years of real
// Databento 5-min data, records entry RSI + realized R per trade, buckets by RSI extremity.
/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = process.env.DATABENTO_API_KEY!;
const START = "2023-07-01", END = "2026-07-15"; // ~3 years for a real sample
const SYMS = [
  { db: "GC.c.0", name: "GOLD", tick: 0.1 },
  { db: "NQ.c.0", name: "INDEX(NQ)", tick: 0.25 },
];
// engine's RSI-bounce geometry: stop 1.5 ATR, target 3.5 ATR (R:R 2.33). win=+2.33R, loss=-1R.
const STOP_ATR = 1.5, TGT_ATR = 3.5;

type Bar = { ms: number; o: number; h: number; l: number; c: number };

async function fetchMonth(sym: string, start: string, end: string): Promise<any[]> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: sym, stype_in: "continuous", schema: "ohlcv-1m", start, end, encoding: "json" });
  const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(KEY + ":").toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) { console.error(`  fetch ${sym} ${start} -> ${r.status}`); return []; }
  const out: any[] = [];
  for (const line of (await r.text()).split("\n")) { if (line.trim()) try { out.push(JSON.parse(line)); } catch {} }
  return out;
}
function monthRanges(s: string, e: string): [string, string][] {
  const res: [string, string][] = []; let d = new Date(s + "T00:00:00Z"); const end = new Date(e + "T00:00:00Z");
  while (d < end) { const nx = new Date(d); nx.setUTCMonth(nx.getUTCMonth() + 1); res.push([d.toISOString().slice(0, 10), (nx < end ? nx : end).toISOString().slice(0, 10)]); d = nx; }
  return res;
}
async function load(sym: string): Promise<Bar[]> {
  const buckets = new Map<number, Bar>();
  for (const [s, e] of monthRanges(START, END)) {
    for (const r of await fetchMonth(sym, s, e)) {
      const ms = Number(r.hd.ts_event) / 1e6, key = Math.floor(ms / 300000);
      const o = +r.open / 1e9, h = +r.high / 1e9, l = +r.low / 1e9, c = +r.close / 1e9;
      const b = buckets.get(key);
      if (!b) buckets.set(key, { ms: key * 300000, o, h, l, c });
      else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); b.c = c; }
    }
    process.stdout.write(".");
  }
  return [...buckets.values()].sort((a, b) => a.ms - b.ms);
}
function rsiAt(c: number[], i: number, p = 14): number { if (i < p) return 50; let g = 0, l = 0; for (let j = i - p + 1; j <= i; j++) { const d = c[j] - c[j - 1]; if (d > 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
function atrAt(b: Bar[], i: number, p = 14): number { if (i < p) return 0; let s = 0; for (let j = i - p + 1; j <= i; j++) s += Math.max(b[j].h - b[j].l, Math.abs(b[j].h - b[j - 1].c), Math.abs(b[j].l - b[j - 1].c)); return s / p; }

type Trade = { dir: "long" | "short"; rsi: number; R: number };

function backtest(bars: Bar[]): Trade[] {
  const c = bars.map(b => b.c), trades: Trade[] = [];
  let cooldownUntil = -1;
  for (let i = 30; i < bars.length - 1; i++) {
    if (i < cooldownUntil) continue;
    const rsi = rsiAt(c, i), atr = atrAt(bars, i);
    if (atr === 0) continue;
    let dir: "long" | "short" | null = null;
    if (rsi < 30) dir = "long"; else if (rsi > 70) dir = "short";
    if (!dir) continue;
    const entry = c[i], stop = dir === "long" ? entry - STOP_ATR * atr : entry + STOP_ATR * atr;
    const tgt = dir === "long" ? entry + TGT_ATR * atr : entry - TGT_ATR * atr;
    // walk forward: stop or target (assume stop-first on adverse bar), 24h time cap
    let R = 0;
    for (let j = i + 1; j < bars.length && j - i <= 288; j++) {
      const stopHit = dir === "long" ? bars[j].l <= stop : bars[j].h >= stop;
      const tgtHit = dir === "long" ? bars[j].h >= tgt : bars[j].l <= tgt;
      if (stopHit) { R = -1; cooldownUntil = j; break; }
      if (tgtHit) { R = TGT_ATR / STOP_ATR; cooldownUntil = j; break; }
      if (j - i === 288) { const px = bars[j].c; R = (dir === "long" ? px - entry : entry - px) / (STOP_ATR * atr); cooldownUntil = j; }
    }
    trades.push({ dir, rsi, R });
  }
  return trades;
}

function bucketStats(ts: Trade[]) {
  if (!ts.length) return "n=0";
  const wins = ts.filter(t => t.R > 0).length, avgR = ts.reduce((s, t) => s + t.R, 0) / ts.length;
  return `n=${String(ts.length).padStart(4)}  win=${(wins / ts.length * 100).toFixed(0)}%  avgR=${avgR >= 0 ? "+" : ""}${avgR.toFixed(3)}`;
}

async function main() {
  for (const sym of SYMS) {
    process.stdout.write(`\nloading ${sym.name} `);
    const bars = await load(sym.db);
    const trades = backtest(bars);
    console.log(` ${bars.length} bars, ${trades.length} RSI-bounce trades\n`);
    // OVERSOLD LONGS — does more-extreme (lower) RSI win more?
    const longs = trades.filter(t => t.dir === "long");
    console.log(`  ${sym.name} OVERSOLD LONGS (more extreme = lower RSI):`);
    for (const [lo, hi] of [[28, 30], [25, 28], [22, 25], [18, 22], [0, 18]]) console.log(`    RSI ${lo}-${hi}: ${bucketStats(longs.filter(t => t.rsi >= lo && t.rsi < hi))}`);
    // OVERBOUGHT SHORTS — does more-extreme (higher) RSI win more?
    const shorts = trades.filter(t => t.dir === "short");
    console.log(`  ${sym.name} OVERBOUGHT SHORTS (more extreme = higher RSI):`);
    for (const [lo, hi] of [[70, 72], [72, 75], [75, 78], [78, 82], [82, 100]]) console.log(`    RSI ${lo}-${hi}: ${bucketStats(shorts.filter(t => t.rsi >= lo && t.rsi < hi))}`);
  }
  console.log("\nVERDICT: if avgR/win% climbs MONOTONICALLY with extremity → confidence signal is REAL → tiered sizing justified.");
  console.log("If flat/noisy across buckets → confidence does NOT predict outcome → sizing on it = betting on noise.");
}
main().catch(e => { console.error(e); process.exit(1); });
