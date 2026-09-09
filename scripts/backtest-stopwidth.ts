// HOW BIG CAN A POSITION BE? — stop width is the only lever, so measure what it costs.
//
//   DATABASE_URL="postgres://x:x@localhost:5432/x" npx tsx scripts/backtest-stopwidth.ts
//
// Position size = RISK / STOP. Risk is pinned by the breaker ($206 = 4.4% of equity), so the
// ONLY way to a bigger position is a tighter stop. Leverage does not do it: leverage sets the
// MARGIN posted, not the size. This replays the identical swing-lev 4h signal set at a range
// of stop widths — fixed percentages and ATR multiples — holding risk constant, and charges
// the two costs that scale with NOTIONAL and therefore punish a tight stop twice:
//   fees      0.25% x 2 on a position that is 1/stop as large
//   slippage  Spencer's measured stop slippage is 0.52-1.08% of price; charged on stop exits
// A tighter stop buys size and pays for it in stop-out frequency and in friction per R.
import { evaluate, scoreConviction, type ScanSignal, type TfSpec } from "../src/lib/margin-scanner";
import { exitParams, managedStop } from "../src/lib/margin-shadow";
import { SCAN_UNIVERSE, US_MARGIN_MAX_LEVERAGE } from "../src/lib/kraken-pairs";
import type { KrakenBar } from "../src/lib/kraken-margin";
import { readFileSync, existsSync } from "node:fs";

const ENTRY_FEE = 0.0025, TAKER = 0.0025, CHASE = 0.001;
const ROLL4: Record<string, number> = { BTC: 0.00015, ETH: 0.0002, SOL: 0.0003 };
const RISK_USD = 206, EQUITY = 4578;
const SLIP = Number(process.env.SLIP ?? 0.005);   // fraction of price lost when a stop fires
const CACHE = "/tmp/claude-501/-Users-user-trading/9d589653-7ac2-433f-a03a-11e6aa69aeb5/scratchpad/bars.json";
const TF: Record<string, TfSpec> = {
  "4h": { interval: 240, label: "4h", movePct: 0.05, realertMs: 0 },
  "1d": { interval: 1440, label: "1d", movePct: 0.07, realertMs: 0 },
};
const RANK: Record<string, number> = { low: 0, med: 1, high: 2 };

/** Wilder ATR as a FRACTION of price, over the bars up to and including i. */
function atrFrac(bars: KrakenBar[], i: number, n = 14): number {
  if (i < n) return 0;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const pc = bars[k - 1].c;
    sum += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - pc), Math.abs(bars[k].l - pc));
  }
  return sum / n / bars[i].c;
}

interface Trade { coin: string; pnl: number; notional: number; stopFrac: number; reason: string; holdH: number; lev: number }

type Variant = { label: string; stopOf: (bars: KrakenBar[], i: number) => number };

function replay(coin: string, bars: KrakenBar[], context: KrakenBar[] | null, v: Variant): Trade[] {
  const tf = TF["4h"], barH = 4;
  const p = exitParams("swing-lev", 5, 1);
  const holdBars = Math.ceil(p.maxHoldH / barH);
  const roll = ROLL4[coin] ?? 0.0003;
  const levCap = US_MARGIN_MAX_LEVERAGE[coin] ?? 2;
  const out: Trade[] = [];
  let openUntil = -1;
  for (let i = 25; i < bars.length - 1; i++) {
    if (i <= openUntil) continue;
    const hist = bars.slice(0, i + 1);
    const sigs = evaluate({ name: coin, symbol: `${coin}/USD` }, tf, hist);
    const brk = sigs.find((s) => s.kind === "breakout");
    if (!brk) continue;
    let all: ScanSignal[] = sigs;
    if (context) {
      const upto = context.filter((b) => b.t <= bars[i].t);
      if (upto.length >= 25) all = [...sigs, ...evaluate({ name: coin, symbol: `${coin}/USD` }, TF["1d"], upto)];
    }
    const conv = scoreConviction(brk, all);
    if (RANK[conv.tier] < RANK["med"]) continue;

    const stopFrac = v.stopOf(bars, i);
    if (!(stopFrac > 0.002)) continue;                       // unusable / no ATR yet
    // The desk's own guards, applied honestly: notional is capped by leverage x equity, and
    // the leverage that fits this stop is floor(0.36/stop) bounded by the pair's US cap.
    const lev = Math.max(2, Math.min(levCap, Math.floor(0.36 / stopFrac)));
    const notional = Math.min(RISK_USD / stopFrac, EQUITY * lev);
    const entry = bars[i].c * (1 + CHASE);
    const oneR = entry * stopFrac;
    let stop = entry - oneR, peak = entry, reason = "96h time stop", exit = entry;
    let j = i + 1, closedAt = bars[Math.min(i + holdBars, bars.length - 1)].t;
    for (; j < bars.length && j <= i + holdBars; j++) {
      const b = bars[j];
      if (b.l <= stop) {
        // A stop does not fill AT the stop. Charge the measured slippage.
        exit = stop * (1 - SLIP);
        reason = stop >= entry ? "trail" : "stop"; closedAt = b.t; break;
      }
      peak = Math.max(peak, b.h);
      stop = managedStop(1, entry, peak, stop, oneR, p);
      exit = b.c; closedAt = b.t;
    }
    const heldH = ((closedAt - bars[i].t) / 3600) || barH;
    const gross = notional * (exit - entry) / entry;
    const fees = notional * (ENTRY_FEE + TAKER) + (p.carry ? notional * roll * (heldH / 4) : 0);
    out.push({ coin, pnl: gross - fees, notional, stopFrac, reason, holdH: heldH, lev });
    openUntil = j;
  }
  return out;
}

function med(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }

function report(v: Variant, tr: Trade[]) {
  const n = tr.length;
  if (!n) { console.log(`${v.label.padEnd(16)} NO TRADES`); return; }
  const pnl = tr.map((t) => t.pnl), sum = pnl.reduce((a, b) => a + b, 0), mean = sum / n;
  const sd = Math.sqrt(pnl.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const t = sd > 0 ? (mean / sd) * Math.sqrt(n) : 0;
  const wins = pnl.filter((x) => x > 0).length;
  const stopped = tr.filter((x) => x.reason === "stop").length;
  const majors = tr.filter((x) => ["BTC", "ETH", "SOL"].includes(x.coin));
  const f = (x: number) => (x < 0 ? "−$" : "+$") + Math.abs(Math.round(x)).toLocaleString();
  console.log(
    v.label.padEnd(16) +
    String(n).padStart(4) + " tr " +
    (((wins / n) * 100).toFixed(0) + "%").padStart(5) + " win " +
    (((stopped / n) * 100).toFixed(0) + "%").padStart(5) + " stopped " +
    f(sum).padStart(9) + " net " +
    ("t=" + t.toFixed(2)).padStart(8) + "  " +
    ("$" + Math.round(med(tr.map((x) => x.notional))).toLocaleString()).padStart(9) + " med size " +
    ("$" + Math.round(med(majors.map((x) => x.notional))).toLocaleString()).padStart(9) + " BTC/ETH/SOL",
  );
}

async function main() {
  if (!existsSync(CACHE)) throw new Error("no bar cache — run backtest-swing-lev.ts first");
  const bars: Record<string, { d: KrakenBar[]; h4: KrakenBar[] }> = JSON.parse(readFileSync(CACHE, "utf8"));
  const variants: Variant[] = [
    { label: "fixed 1.5%", stopOf: () => 0.015 },
    { label: "fixed 2%", stopOf: () => 0.02 },
    { label: "fixed 2.5%", stopOf: () => 0.025 },
    { label: "fixed 3%", stopOf: () => 0.03 },
    { label: "fixed 4% (LIVE)", stopOf: () => 0.04 },
    { label: "fixed 5%", stopOf: () => 0.05 },
    { label: "1.0x ATR", stopOf: (b, i) => atrFrac(b, i) },
    { label: "1.5x ATR", stopOf: (b, i) => 1.5 * atrFrac(b, i) },
    { label: "2.0x ATR", stopOf: (b, i) => 2.0 * atrFrac(b, i) },
    { label: "2.5x ATR", stopOf: (b, i) => 2.5 * atrFrac(b, i) },
    { label: "3.0x ATR", stopOf: (b, i) => 3.0 * atrFrac(b, i) },
    { label: "2xATR fl2.5", stopOf: (b, i) => { const a = atrFrac(b, i); return a > 0 ? Math.min(0.08, Math.max(0.025, 2.0 * a)) : 0; } },
    { label: "2xATR fl3", stopOf: (b, i) => { const a = atrFrac(b, i); return a > 0 ? Math.min(0.08, Math.max(0.03, 2.0 * a)) : 0; } },
    { label: "2.5xATR fl3", stopOf: (b, i) => { const a = atrFrac(b, i); return a > 0 ? Math.min(0.08, Math.max(0.03, 2.5 * a)) : 0; } },
    { label: "3xATR fl3", stopOf: (b, i) => { const a = atrFrac(b, i); return a > 0 ? Math.min(0.08, Math.max(0.03, 3.0 * a)) : 0; } },
    { label: "2.5xATR fl3.5", stopOf: (b, i) => { const a = atrFrac(b, i); return a > 0 ? Math.min(0.08, Math.max(0.035, 2.5 * a)) : 0; } },
  ];
  console.log(`swing-lev 4h · med+high conviction · risk pinned at $${RISK_USD} · slippage ${(SLIP * 100).toFixed(2)}% on stop fills`);
  console.log(`equity $${EQUITY} · notional capped at leverage x equity · lev = min(pair cap, floor(0.36/stop))\n`);
  const store: Record<string, Trade[]> = {};
  for (const v of variants) {
    const tr: Trade[] = [];
    for (const coin of SCAN_UNIVERSE) {
      const b = bars[coin]; if (!b?.h4?.length) continue;
      tr.push(...replay(coin, b.h4, b.d ?? null, v));
    }
    store[v.label] = tr;
    report(v, tr);
  }
  // PAIRED: same coin, same entry bar, live 4% vs each variant. A difference that only
  // shows up because a variant took DIFFERENT trades is not a difference in the stop.
  const base = store["fixed 4% (LIVE)"];
  console.log("\nPAIRED vs live 4% (same coin, matched trade order — Welch on the difference):");
  for (const v of variants) {
    if (v.label === "fixed 4% (LIVE)") continue;
    const a: number[] = [], b: number[] = [];
    for (const coin of SCAN_UNIVERSE) {
      const L = base.filter((t) => t.coin === coin), R = store[v.label].filter((t) => t.coin === coin);
      const n = Math.min(L.length, R.length);
      for (let k = 0; k < n; k++) { a.push(L[k].pnl); b.push(R[k].pnl); }
    }
    if (a.length < 5) { console.log(`  ${v.label.padEnd(16)} too few pairs`); continue; }
    const d = a.map((x, k) => b[k] - x), m = d.reduce((x, y) => x + y, 0) / d.length;
    const sd = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, d.length - 1));
    const t = sd > 0 ? (m / sd) * Math.sqrt(d.length) : 0;
    const tot = d.reduce((x, y) => x + y, 0);
    console.log(`  ${v.label.padEnd(16)}${String(d.length).padStart(4)} pairs  ${(tot < 0 ? "−$" : "+$") + Math.abs(Math.round(tot)).toLocaleString()} vs live  t=${t.toFixed(2)}  ${Math.abs(t) >= 2 ? (t > 0 ? "◀ REAL improvement" : "◀ REAL degradation") : "(noise)"}`);
  }

  // What the majors alone did — the coins in the screenshots.
  console.log("\nMAJORS ONLY (BTC/ETH/SOL):");
  for (const v of variants) {
    const tr = store[v.label].filter((x) => ["BTC", "ETH", "SOL"].includes(x.coin));
    if (!tr.length) { console.log(`  ${v.label.padEnd(16)} none`); continue; }
    const sum = tr.reduce((a, b) => a + b.pnl, 0), mean = sum / tr.length;
    const sd = Math.sqrt(tr.reduce((a, b) => a + (b.pnl - mean) ** 2, 0) / Math.max(1, tr.length - 1));
    const t = sd > 0 ? (mean / sd) * Math.sqrt(tr.length) : 0;
    console.log(`  ${v.label.padEnd(16)}${String(tr.length).padStart(3)} tr  ${((tr.filter((x) => x.pnl > 0).length / tr.length) * 100).toFixed(0).padStart(3)}% win  ${(sum < 0 ? "−$" : "+$") + Math.abs(Math.round(sum)).toLocaleString()}  t=${t.toFixed(2)}  med $${Math.round(med(tr.map((x) => x.notional))).toLocaleString()} at ${med(tr.map((x) => x.lev))}x`);
  }
}
main();
