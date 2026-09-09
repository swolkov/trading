// THE DESK AS IT ACTUALLY RUNS — 3 slots, compounding, margin floor, chronological.
//
//   DATABASE_URL="postgres://x:x@localhost:5432/x" npx tsx scripts/backtest-portfolio.ts
//
// Every other harness replays each coin independently, which silently assumes unlimited
// simultaneous positions. The live desk has THREE slots and a 150% margin floor, and it risks
// a PERCENTAGE of current equity — so wins compound and losses shrink the next bet. This
// merges every coin's signals into one clock and runs the real constraints, which is the only
// way to answer "what does the account do" and "when is a $55k position inside the rules".
import { evaluate, scoreConviction, type ScanSignal, type TfSpec } from "../src/lib/margin-scanner";
import { exitParams, managedStop } from "../src/lib/margin-shadow";
import { SCAN_UNIVERSE, US_MARGIN_MAX_LEVERAGE } from "../src/lib/kraken-pairs";
import type { KrakenBar } from "../src/lib/kraken-margin";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ENTRY_FEE = 0.0025, TAKER = 0.0025, CHASE = 0.001;
const ROLL4: Record<string, number> = { BTC: 0.00015, ETH: 0.0002, SOL: 0.0003 };
const SLIP = Number(process.env.SLIP ?? 0.007);
const START = Number(process.env.START ?? 4578);
const SLOTS = Number(process.env.SLOTS ?? 3);
const BASE = Number(process.env.BASE ?? 0.022);     // high conviction = 2x base
const STOP = 0.04, FLOOR = 150, HEADROOM = 0.9, LEV_CEIL = 9;
const CACHE = "/tmp/claude-501/-Users-user-trading/9d589653-7ac2-433f-a03a-11e6aa69aeb5/scratchpad/bars.json";
const TF: Record<string, TfSpec> = {
  "4h": { interval: 240, label: "4h", movePct: 0.05, realertMs: 0 },
  "1d": { interval: 1440, label: "1d", movePct: 0.07, realertMs: 0 },
};
const RANK: Record<string, number> = { low: 0, med: 1, high: 2 };

interface Sig { coin: string; t: number; px: number; tier: string; idx: number }
interface Open { coin: string; entry: number; stop: number; peak: number; oneR: number; notional: number; margin: number; openedT: number; idx: number }

async function main() {
  if (!existsSync(CACHE)) throw new Error("no bar cache — run backtest-swing-lev.ts first");
  const bars: Record<string, { d: KrakenBar[]; h4: KrakenBar[] }> = JSON.parse(readFileSync(CACHE, "utf8"));
  const p = exitParams("swing-lev", 5, 1);
  const holdBars = Math.ceil(p.maxHoldH / 4);

  // 1. Collect every signal from every coin onto one timeline. Detector output depends only
  // on the bars, so it is cached — otherwise a config sweep re-runs the scanner every time.
  const SIGCACHE = "/tmp/claude-501/-Users-user-trading/9d589653-7ac2-433f-a03a-11e6aa69aeb5/scratchpad/sigs-4h.json";
  let sigs: Sig[] = [];
  if (existsSync(SIGCACHE)) sigs = JSON.parse(readFileSync(SIGCACHE, "utf8"));
  if (!sigs.length) {
  for (const coin of SCAN_UNIVERSE) {
    const b = bars[coin]?.h4; if (!b?.length) continue;
    const ctx = bars[coin]?.d ?? null;
    for (let i = 25; i < b.length - 1; i++) {
      const hist = b.slice(0, i + 1);
      const s = evaluate({ name: coin, symbol: `${coin}/USD` }, TF["4h"], hist);
      const brk = s.find((x) => x.kind === "breakout"); if (!brk) continue;
      let all: ScanSignal[] = s;
      if (ctx) { const u = ctx.filter((x) => x.t <= b[i].t); if (u.length >= 25) all = [...s, ...evaluate({ name: coin, symbol: `${coin}/USD` }, TF["1d"], u)]; }
      const conv = scoreConviction(brk, all);
      if (RANK[conv.tier] < RANK["med"]) continue;
      sigs.push({ coin, t: b[i].t, px: b[i].c, tier: conv.tier, idx: i });
    }
  }
  writeFileSync(SIGCACHE, JSON.stringify(sigs));
  }
  // TIEBREAK. Several coins break out on the same 4h bar; with few slots the CHOICE among
  // them is most of the result, so it must not be an accident of SCAN_UNIVERSE order.
  //   order=seed  a seeded shuffle — run it over many seeds and the spread IS the luck
  //   order=conv  spend the slot on the highest-conviction signal available
  const ORDER = process.env.ORDER ?? "seed";
  const SEED = Number(process.env.SEED ?? 1);
  let rnd = SEED * 2654435761 >>> 0;
  const nextR = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const jitter = new Map<Sig, number>();
  for (const s of sigs) jitter.set(s, nextR());
  sigs.sort((a, b) => a.t - b.t
    || (ORDER === "conv" ? RANK[b.tier] - RANK[a.tier] : 0)
    || (jitter.get(a)! - jitter.get(b)!));

  // 2. Walk the clock. Resolve open trades bar by bar, then consider new entries.
  let eq = START, peakEq = START, maxDD = 0, wins = 0, losses = 0;
  // THE DRAWDOWN BREAKER, as margin-watch actually runs it: halt NEW entries once equity is
  // DD_TRIP below the peak; re-arm only once the drawdown has healed to under half that.
  // Leaving it out is the difference between a backtest and a fantasy — every config here
  // draws down past 15% at some point, so a sim without it is reporting returns the desk
  // would never have been allowed to earn.
  const DD_TRIP = Number(process.env.DD ?? 0.15);
  // REGIME-ADAPTIVE SLOTS. Concentration wins in chop; breadth wins in a strong uptrend
  // (May 2026: 3 slots +57% vs 1 slot +30%; every month since, the reverse). REGIME=1 gates
  // the slot count on BTC's own trend — the same 4h bars the desk already reads — so the desk
  // runs wide when the tape pays for breadth and concentrated when it does not.
  const REGIME = process.env.REGIME === "1";
  const WIDE = Number(process.env.WIDE ?? 3);
  const btc = bars["BTC"]?.h4 ?? [];
  const btcClose = new Map<number, number>();
  for (let i = 0; i < btc.length; i++) btcClose.set(btc[i].t, btc[i].c);
  const btcT = btc.map((b) => b.t);
  const btcUp = (t: number): boolean => {
    // BTC above its 50-bar (~8 day) mean on the 4h chart = risk-on.
    let i = btcT.length - 1;
    while (i > 0 && btcT[i] > t) i--;
    if (i < 50) return false;
    let m = 0; for (let k = i - 49; k <= i; k++) m += btc[k].c;
    return btc[i].c > m / 50;
  };
  let halted = false, haltedBars = 0, trips = 0, haltedSince = 0;
  // A tripped breaker is a ONE-WAY LATCH in practice: halted → no entries → equity cannot
  // move → the "re-arms when recovered" branch can never fire. Live, Spencer clears it by
  // hand (he did on Sep 8). REARM_DAYS models how fast that happens; 0 = never (the latch).
  const REARM_DAYS = Number(process.env.REARM ?? 3);
  const open: Open[] = [];
  const curve: { t: number; eq: number }[] = [];
  const allT = [...new Set(sigs.map((s) => s.t))].sort((a, b) => a - b);
  const step = 4 * 3600;
  const t0 = allT[0], tEnd = allT[allT.length - 1] + holdBars * step;
  const byCoin: Record<string, Sig[]> = {};
  for (const s of sigs) (byCoin[s.coin] ??= []).push(s);
  let si = 0;

  for (let t = t0; t <= tEnd; t += step) {
    // resolve
    for (let k = open.length - 1; k >= 0; k--) {
      const o = open[k];
      const b = bars[o.coin].h4.find((x) => x.t === t);
      if (!b) continue;
      const ageBars = Math.round((t - o.openedT) / step);
      let exit: number | null = null, hit = false;
      if (b.l <= o.stop) { exit = o.stop * (1 - SLIP); hit = true; }
      else if (ageBars >= holdBars) exit = b.c;
      else { o.peak = Math.max(o.peak, b.h); o.stop = managedStop(1, o.entry, o.peak, o.stop, o.oneR, p); }
      if (exit == null) continue;
      const heldH = (t - o.openedT) / 3600;
      const gross = o.notional * (exit - o.entry) / o.entry;
      const fees = o.notional * (ENTRY_FEE + TAKER) + o.notional * (ROLL4[o.coin] ?? 0.0003) * (heldH / 4);
      const pnl = gross - fees;
      eq += pnl; if (pnl > 0) wins++; else losses++;
      peakEq = Math.max(peakEq, eq); maxDD = Math.max(maxDD, (peakEq - eq) / peakEq);
      open.splice(k, 1);
      void hit;
    }
    // breaker, evaluated on the equity mark BEFORE this bar's entries
    const ddNow = peakEq > 0 ? (peakEq - eq) / peakEq : 0;
    if (!halted && ddNow >= DD_TRIP) { halted = true; trips++; haltedSince = t; peakEq = eq; }
    else if (halted && REARM_DAYS > 0 && (t - haltedSince) >= REARM_DAYS * 86400) halted = false;
    if (halted) haltedBars++;

    // enter
    while (si < sigs.length && sigs[si].t === t) {
      const s = sigs[si++];
      if (halted) continue;                        // entries halted; closes still run
      const slotsNow = REGIME ? (btcUp(t) ? WIDE : 1) : SLOTS;
      if (open.length >= slotsNow) continue;
      if (open.some((o) => o.coin === s.coin)) continue;
      if (!(eq > 0)) continue;
      const risk = eq * BASE * (s.tier === "high" ? 2 : 1);
      const marginNow = open.reduce((a, o) => a + o.margin, 0);
      const levCap = Math.min(LEV_CEIL, US_MARGIN_MAX_LEVERAGE[s.coin] ?? 2);
      const lev = Math.max(2, Math.min(levCap, Math.floor(0.36 / STOP)));
      const notional = Math.min(risk / STOP, eq * lev, Math.max(0, eq - marginNow) * HEADROOM * lev);
      const margin = notional / lev;
      if (!(notional > 0)) continue;
      if ((eq / (marginNow + margin)) * 100 < FLOOR) continue;   // the 150% entry floor
      const entry = s.px * (1 + CHASE);
      open.push({ coin: s.coin, entry, stop: entry * (1 - STOP), peak: entry, oneR: entry * STOP, notional, margin, openedT: t, idx: s.idx });
    }
    curve.push({ t, eq });
  }

  const days = (tEnd - t0) / 86400;
  const n = wins + losses;
  const ret = eq / START - 1;
  const monthly = Math.pow(eq / START, 30 / days) - 1;
  const f = (x: number) => "$" + Math.round(x).toLocaleString();
  if (process.env.QUIET) {
    // Honest headline: the whole-window number AND the number with the best month removed,
    // because a curve carried by one month is one regime, not an edge.
    const mo0: Record<string, number[]> = {};
    for (const c of curve) { const k = new Date(c.t * 1000).toISOString().slice(0, 7); (mo0[k] ??= []).push(c.eq); }
    const ks = Object.keys(mo0).sort();
    const rets = ks.map((k) => mo0[k][mo0[k].length - 1] / mo0[k][0] - 1);
    const best = rets.indexOf(Math.max(...rets));
    const exBest = rets.filter((_, i) => i !== best);
    const geoEx = exBest.length ? Math.pow(exBest.reduce((a, b) => a * (1 + b), 1), 1 / exBest.length) - 1 : 0;
    if (process.env.BYMONTH) {
      const mm: Record<string, number[]> = {};
      for (const c of curve) { const k = new Date(c.t * 1000).toISOString().slice(0, 7); (mm[k] ??= []).push(c.eq); }
      console.log(Object.keys(mm).sort().map((k) => `${k}:${((mm[k][mm[k].length - 1] / mm[k][0] - 1) * 100).toFixed(1)}`).join(" "));
      return;
    }
    console.log(
      `  ${String(SLOTS).padStart(2)} slot(s) base ${(BASE * 100).toFixed(1)}% → pos ${f(START * BASE * 2 / STOP).padStart(8)}  ` +
      `${String(n).padStart(3)} tr  ${(n / days * 7).toFixed(1).padStart(4)}/wk  win ${((wins / n) * 100).toFixed(0).padStart(2)}%  ` +
      `final ${f(eq).padStart(9)}  ${(monthly * 100 >= 0 ? "+" : "") + (monthly * 100).toFixed(1)}%/mo  ` +
      `ex-best ${(geoEx * 100 >= 0 ? "+" : "") + (geoEx * 100).toFixed(1)}%/mo  maxDD ${(maxDD * 100).toFixed(0)}%  ` +
      `breaker ${trips}x (${((haltedBars * 4 / 24)).toFixed(0)}d halted)`,
    );
    return;
  }
  console.log(`3-slot desk · start ${f(START)} · base ${(BASE * 100).toFixed(1)}% (${(BASE * 200).toFixed(1)}% high conviction) · ${STOP * 100}% stop · slippage ${(SLIP * 100).toFixed(2)}%`);
  console.log(`window ${new Date(t0 * 1000).toISOString().slice(0, 10)} → ${new Date(tEnd * 1000).toISOString().slice(0, 10)} (${days.toFixed(0)} days)\n`);
  console.log(`  ${n} trades taken (of ${sigs.length} signals — ${sigs.length - n} refused: no slot / margin floor)`);
  console.log(`  ${(n / days * 7).toFixed(1)} trades per week · win rate ${((wins / n) * 100).toFixed(0)}%`);
  console.log(`  equity ${f(START)} → ${f(eq)}   ${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(0)}% over ${(days / 30).toFixed(1)} months`);
  console.log(`  compounded monthly: ${monthly >= 0 ? "+" : ""}${(monthly * 100).toFixed(1)}%`);
  console.log(`  worst drawdown ${(maxDD * 100).toFixed(0)}%  ·  breaker tripped ${trips}x, entries halted ${(haltedBars * 4 / 24).toFixed(0)} of ${days.toFixed(0)} days`);
  // month by month
  const mo: Record<string, number[]> = {};
  for (const c of curve) { const k = new Date(c.t * 1000).toISOString().slice(0, 7); (mo[k] ??= []).push(c.eq); }
  console.log("");
  for (const k of Object.keys(mo).sort()) {
    const v = mo[k], a = v[0], b = v[v.length - 1];
    console.log(`  ${k}  ${f(a).padStart(9)} → ${f(b).padStart(9)}  ${b >= a ? "+" : "−"}${Math.abs((b / a - 1) * 100).toFixed(1)}%`);
  }
  // when does a $55,780 position become legal?
  const needEq = 55780 * STOP / (BASE * 2);
  console.log(`\n  A ${f(55780)} position with a ${STOP * 100}% stop risks ${f(55780 * STOP)}.`);
  console.log(`  That is ${(BASE * 200).toFixed(1)}% of ${f(needEq)} — the equity at which the screenshot is INSIDE the rules.`);
  if (monthly > 0) console.log(`  At ${(monthly * 100).toFixed(1)}%/mo from ${f(START)}: ${(Math.log(needEq / START) / Math.log(1 + monthly)).toFixed(0)} months.`);
}
main();
