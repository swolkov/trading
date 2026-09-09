// REPLAY OF THE ARMED RULE — swing-lev, out of sample.
//
//   DATABASE_URL="postgres://x:x@localhost:5432/x" npx tsx scripts/backtest-swing-lev.ts
//
// WHY. The live rule's evidence base is 28 resolved paper trades spanning SIX DAYS of one
// market regime, t=0.49. Kraken's public OHLC serves 720 candles free. The detector
// (`evaluate`), the conviction scorer (`scoreConviction`) and the exit engine (`exitParams`
// + `managedStop`) are pure functions, so the same code paper runs can be replayed over
// history.
//
// ⚠️ WHAT THIS CAN AND CANNOT PROVE. Kraken hard-caps OHLC at 720 candles per interval and
// IGNORES `since` for older data, so the windows are fixed: 1d = ~2 years, 4h = ~120 days,
// and nothing intraday goes back further. The rule's conviction score needs ≥4, and two of
// its six points come from multi-timeframe agreement — which needs intraday history we do
// not have. So a HIGH-conviction daily signal is essentially unreachable before the 4h
// window opens, and the "2-year test" of the rule as configured cannot be run at all. What
// CAN be run over 2 years is the same daily breakout at a lower conviction bar; that is a
// weaker rule, reported separately and labelled as such, and it answers the different but
// still useful question of whether daily breakouts on these coins pay across regimes.
//
// FIDELITY. Identical to paper: the 20-bar breakout detector (in-progress-bar semantics
// included), the conviction formula, swing-lev's container (4% oneR, 96h hold), the managed
// exit (breakeven at +1R then a 1R trail, ratchet-only), the 0.1% entry chase, 0.25% taker
// fees both sides, the 4-hourly rollover on notional, and one open trade per coin.
// Stricter than live: conviction sees fewer timeframes, so fewer setups clear the bar.
// Conservative on ties: if a bar's low reached the stop we assume it stopped, even when the
// same bar made a new high.
import { evaluate, scoreConviction, type ScanSignal, type TfSpec } from "../src/lib/margin-scanner";
import { exitParams, managedStop } from "../src/lib/margin-shadow";
import { SCAN_UNIVERSE } from "../src/lib/kraken-pairs";
import type { KrakenBar } from "../src/lib/kraken-margin";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ENTRY_FEE = 0.0025, TAKER = 0.0025, CHASE = 0.001;
const ROLLOVER_4H: Record<string, number> = { BTC: 0.00015, ETH: 0.0002, SOL: 0.0003 };
const ROLLOVER_DEFAULT = 0.0003;
const REF_EQUITY = 5335, RISK_PCT = 0.06;
const CACHE = "/tmp/claude-501/-Users-user-trading/9d589653-7ac2-433f-a03a-11e6aa69aeb5/scratchpad/bars.json";
const TF: Record<string, TfSpec> = {
  "4h": { interval: 240, label: "4h", movePct: 0.05, realertMs: 0 },
  "1d": { interval: 1440, label: "1d", movePct: 0.07, realertMs: 0 },
};
type Tier = "high" | "med";
const RANK: Record<string, number> = { low: 0, med: 1, high: 2 };

async function ohlc(coin: string, interval: number): Promise<KrakenBar[]> {
  const pair = (coin === "BTC" ? "XBT" : coin) + "USD";
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`).then((x) => x.json() as Promise<Record<string, unknown>>);
  const res = r.result as Record<string, unknown> | undefined;
  if (!res) return [];
  const key = Object.keys(res).find((k) => k !== "last");
  if (!key) return [];
  return (res[key] as unknown[][]).map((b) => ({
    t: Number(b[0]), o: parseFloat(String(b[1])), h: parseFloat(String(b[2])),
    l: parseFloat(String(b[3])), c: parseFloat(String(b[4])), v: parseFloat(String(b[6])),
  }));
}

interface Trade { coin: string; tf: string; opened: number; holdH: number; pnl: number; reason: string; tier: string }

function replay(coin: string, tfLabel: "4h" | "1d", bars: KrakenBar[], context: KrakenBar[] | null, minTier: Tier): Trade[] {
  const tf = TF[tfLabel];
  const barH = tf.interval / 60;
  const p = exitParams("swing-lev", 5, 1);            // entry=1 ⇒ oneR is a FRACTION
  const stopFrac = p.oneR, holdBars = Math.ceil(p.maxHoldH / barH);
  const roll = ROLLOVER_4H[coin] ?? ROLLOVER_DEFAULT;
  const notional = (RISK_PCT * REF_EQUITY) / stopFrac;
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
      const other = tfLabel === "4h" ? TF["1d"] : TF["4h"];
      const upto = context.filter((b) => b.t <= bars[i].t);
      if (upto.length >= 25) all = [...sigs, ...evaluate({ name: coin, symbol: `${coin}/USD` }, other, upto)];
    }
    const conv = scoreConviction(brk, all);
    if (RANK[conv.tier] < RANK[minTier]) continue;

    const entry = bars[i].c * (1 + CHASE);
    const oneR = entry * stopFrac;
    let stop = entry - oneR, peak = entry, reason = "96h time stop", exit = entry;
    let j = i + 1, closedAt = bars[Math.min(i + holdBars, bars.length - 1)].t;
    for (; j < bars.length && j <= i + holdBars; j++) {
      const b = bars[j];
      if (b.l <= stop) { exit = stop; reason = stop >= entry ? "trailing stop" : "initial stop"; closedAt = b.t; break; }
      peak = Math.max(peak, b.h);
      stop = managedStop(1, entry, peak, stop, oneR, p);
      exit = b.c; closedAt = b.t;
    }
    const heldH = ((closedAt - bars[i].t) / 3600) || barH;
    const gross = notional * (exit - entry) / entry;
    const fees = notional * (ENTRY_FEE + TAKER) + (p.carry ? notional * roll * (heldH / 4) : 0);
    out.push({ coin, tf: tfLabel, opened: bars[i].t, holdH: heldH, pnl: gross - fees, reason, tier: conv.tier });
    openUntil = j;
  }
  return out;
}

function stats(label: string, trades: Trade[], note = "") {
  const n = trades.length;
  if (!n) { console.log(`\n${label}\n  NO TRADES — the rule never fired here. ${note}`); return; }
  const pnl = trades.map((t) => t.pnl), sum = pnl.reduce((a, b) => a + b, 0), mean = sum / n;
  const sd = Math.sqrt(pnl.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const t = sd > 0 ? (mean / sd) * Math.sqrt(n) : 0;
  const wins = pnl.filter((x) => x > 0).length;
  const first = new Date(Math.min(...trades.map((x) => x.opened)) * 1000).toISOString().slice(0, 10);
  const last = new Date(Math.max(...trades.map((x) => x.opened)) * 1000).toISOString().slice(0, 10);
  console.log(`\n${label}${note ? "  " + note : ""}`);
  console.log(`  ${n} trades, ${first} → ${last}`);
  console.log(`  win ${((wins / n) * 100).toFixed(0)}%  net ${sum < 0 ? "−" : "+"}$${Math.abs(sum).toFixed(0)}  avg ${mean < 0 ? "−" : "+"}$${Math.abs(mean).toFixed(0)} (${(mean / (RISK_PCT * REF_EQUITY)).toFixed(3)}R)  t=${t.toFixed(2)} ${Math.abs(t) >= 2 ? (t > 0 ? "◀ t≥2" : "◀ NEGATIVE, t≥2") : ""}`);
  const mo: Record<string, number> = {};
  for (const x of trades) { const k = new Date(x.opened * 1000).toISOString().slice(2, 7); mo[k] = (mo[k] ?? 0) + x.pnl; }
  const keys = Object.keys(mo).sort();
  console.log(`  months: ${keys.map((k) => `${k} ${mo[k] < 0 ? "−" : "+"}${Math.abs(mo[k]).toFixed(0)}`).join("  ")}`);
  console.log(`  ${keys.filter((k) => mo[k] > 0).length}/${keys.length} months positive`);
  // Drop the single best month — a rule carried by one month is one bet, not an edge.
  if (keys.length > 2) {
    const best = keys.reduce((a, b) => (mo[a] > mo[b] ? a : b));
    const rest = trades.filter((x) => new Date(x.opened * 1000).toISOString().slice(2, 7) !== best);
    if (rest.length > 2) {
      const s2 = rest.reduce((a, b) => a + b.pnl, 0), m2 = s2 / rest.length;
      const sd2 = Math.sqrt(rest.reduce((a, b) => a + (b.pnl - m2) ** 2, 0) / Math.max(1, rest.length - 1));
      console.log(`  WITHOUT its best month (${best}): ${rest.length} trades, net ${s2 < 0 ? "−" : "+"}$${Math.abs(s2).toFixed(0)}, t=${(sd2 > 0 ? (m2 / sd2) * Math.sqrt(rest.length) : 0).toFixed(2)}`);
    }
  }
}

async function main() {
  let bars: Record<string, { d: KrakenBar[]; h4: KrakenBar[] }>;
  if (existsSync(CACHE)) {
    bars = JSON.parse(readFileSync(CACHE, "utf8"));
    console.log(`bars from cache (${Object.keys(bars).length} coins)`);
  } else {
    bars = {};
    for (const coin of SCAN_UNIVERSE) {
      try {
        const d = await ohlc(coin, 1440); await new Promise((r) => setTimeout(r, 250));
        const h4 = await ohlc(coin, 240); await new Promise((r) => setTimeout(r, 250));
        bars[coin] = { d, h4 }; process.stdout.write(".");
      } catch { process.stdout.write("x"); }
    }
    writeFileSync(CACHE, JSON.stringify(bars));
    console.log("");
  }

  const dailyHigh: Trade[] = [], dailyMed: Trade[] = [], fourHigh: Trade[] = [];
  for (const [coin, b] of Object.entries(bars)) {
    if (b.d.length >= 60) {
      dailyHigh.push(...replay(coin, "1d", b.d, b.h4.length >= 25 ? b.h4 : null, "high"));
      // 2-year cut: 1d ONLY, no intraday context, lower bar — a different, weaker rule.
      dailyMed.push(...replay(coin, "1d", b.d, null, "med"));
    }
    if (b.h4.length >= 60) fourHigh.push(...replay(coin, "4h", b.h4, b.d.length >= 25 ? b.d : null, "high"));
  }

  console.log("\n════ THE RULE AS ARMED (high conviction) ════");
  stats("── 4h breakouts, the 120 days Kraken gives us ──", fourHigh);
  stats("── 1d breakouts ──", dailyHigh, "(only fires once 4h history exists to score agreement)");
  stats("── 4h + 1d combined = what the live sleeve actually trades ──", [...fourHigh, ...dailyHigh]);

  console.log("\n════ THE 2-YEAR QUESTION (weaker rule: daily breakouts, med+ conviction, no intraday) ════");
  stats("── 1d breakouts, med+ conviction, ~2 years ──", dailyMed);

  const all = [...fourHigh, ...dailyHigh];
  const byCoin: Record<string, { n: number; net: number }> = {};
  for (const x of all) { (byCoin[x.coin] ??= { n: 0, net: 0 }); byCoin[x.coin].n++; byCoin[x.coin].net += x.pnl; }
  const ranked = Object.entries(byCoin).sort((a, b) => b[1].net - a[1].net);
  console.log("\ntop coins: " + ranked.slice(0, 5).map(([c, v]) => `${c} +$${v.net.toFixed(0)}(${v.n})`).join(", "));
  console.log("worst coins: " + ranked.slice(-5).map(([c, v]) => `${c} ${v.net < 0 ? "−" : "+"}$${Math.abs(v.net).toFixed(0)}(${v.n})`).join(", "));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
