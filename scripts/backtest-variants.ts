// DOES THE CHANGE ACTUALLY MAKE IT BETTER? — paired tests on the same entry signals.
//
//   DATABASE_URL="postgres://x:x@localhost:5432/x" npx tsx scripts/backtest-variants.ts
//
// Four PRE-SPECIFIED questions, not a grid search. Testing many variants on 120 days of one
// asset class will hand you a winner by chance; these are the four already on the desk as
// registered hypotheses, and each is reported with a confidence interval rather than a
// verdict:
//
//   Q1  Should the 1d leg be cut?            (unpaired: different signals)
//   Q2  Is swing-wide's 2R trail better?     (PAIRED: identical entries, different exit)
//   Q3  Would maker entries pay?             (PAIRED: identical trades, different fee)
//   Q4  Is the 4h edge robust to dropping any single month, and to any single coin?
//
// Q2 and Q3 are paired — the same entry signals, one thing changed — so the test is on the
// per-trade DIFFERENCE. That is far more powerful than comparing two independent means, and
// it is the only honest way to attribute a change to the change itself.
import { evaluate, scoreConviction, type ScanSignal, type TfSpec } from "../src/lib/margin-scanner";
import { exitParams, managedStop, type ExitProfile } from "../src/lib/margin-shadow";
import type { KrakenBar } from "../src/lib/kraken-margin";
import { readFileSync } from "node:fs";

const TAKER = 0.0025, MAKER = 0.0016, CHASE = 0.001;   // Kraken US margin: taker ~0.25%, maker ~0.16%
const ROLLOVER_4H: Record<string, number> = { BTC: 0.00015, ETH: 0.0002, SOL: 0.0003 };
const REF_EQUITY = 5335, RISK_PCT = 0.06, RISK$ = REF_EQUITY * RISK_PCT;
const CACHE = "/tmp/claude-501/-Users-user-trading/9d589653-7ac2-433f-a03a-11e6aa69aeb5/scratchpad/bars.json";
const TF: Record<string, TfSpec> = {
  "4h": { interval: 240, label: "4h", movePct: 0.05, realertMs: 0 },
  "1d": { interval: 1440, label: "1d", movePct: 0.07, realertMs: 0 },
};

interface Entry { coin: string; tf: "4h" | "1d"; i: number; month: string }
interface Result { pnl: number; r: number; reason: string }

/** Every high-conviction breakout entry, collected ONCE so variants are compared on identical signals. */
function entries(coin: string, tfLabel: "4h" | "1d", bars: KrakenBar[], ctx: KrakenBar[] | null): Entry[] {
  const tf = TF[tfLabel], out: Entry[] = [];
  for (let i = 25; i < bars.length - 1; i++) {
    const sigs = evaluate({ name: coin, symbol: `${coin}/USD` }, tf, bars.slice(0, i + 1));
    const brk = sigs.find((s) => s.kind === "breakout");
    if (!brk) continue;
    let all: ScanSignal[] = sigs;
    if (ctx) {
      const other = tfLabel === "4h" ? TF["1d"] : TF["4h"];
      const upto = ctx.filter((b) => b.t <= bars[i].t);
      if (upto.length >= 25) all = [...sigs, ...evaluate({ name: coin, symbol: `${coin}/USD` }, other, upto)];
    }
    if (scoreConviction(brk, all).tier !== "high") continue;
    out.push({ coin, tf: tfLabel, i, month: new Date(bars[i].t * 1000).toISOString().slice(2, 7) });
  }
  return out;
}

/** Simulate ONE entry under a given exit profile and entry fee. Same engine as paper. */
function simulate(coin: string, bars: KrakenBar[], i: number, barH: number, p: ExitProfile, entryFee: number): Result & { exitBar: number } {
  const stopFrac = p.oneR;                       // exitParams called with entry=1 ⇒ fraction
  const holdBars = Math.ceil(p.maxHoldH / barH);
  const notional = RISK$ / stopFrac;
  const roll = ROLLOVER_4H[coin] ?? 0.0003;
  const entry = bars[i].c * (1 + CHASE);
  const oneR = entry * stopFrac;
  let stop = entry - oneR, peak = entry, exit = entry, reason = "time stop", closedAt = bars[Math.min(i + holdBars, bars.length - 1)].t;
  let exitBar = Math.min(i + holdBars, bars.length - 1);
  for (let j = i + 1; j < bars.length && j <= i + holdBars; j++) {
    const b = bars[j];
    if (b.l <= stop) { exit = stop; reason = stop >= entry ? "trail" : "initial stop"; closedAt = b.t; exitBar = j; break; }
    peak = Math.max(peak, b.h);
    stop = managedStop(1, entry, peak, stop, oneR, p);
    exit = b.c; closedAt = b.t; exitBar = j;
  }
  const heldH = ((closedAt - bars[i].t) / 3600) || barH;
  const gross = (notional * (exit - entry)) / entry;
  const fees = notional * (entryFee + TAKER) + (p.carry ? notional * roll * (heldH / 4) : 0);
  const pnl = gross - fees;
  return { pnl, r: pnl / RISK$, reason, exitBar };
}

/**
 * PYRAMID: the same entry, but when a bar CLOSES at or above +1R a second unit of the same
 * notional is added at that close (chased like the first), and from then on the 1R trail runs
 * on the combined position. At the moment of the add the stop sits at the original entry
 * (peak − 1R), so unit 1 is at breakeven and unit 2 risks 1R: the trade's worst case from
 * that point is the SAME −1R it would have been without the add, with double the upside
 * exposure. Second unit pays its own taker fee and rollover. Spencer's "imagine if we bought
 * 5–15 ETH" — the disciplined version, where the extra size is bought with the trade's own
 * open profit rather than with more initial risk.
 */
function simulatePyramid(coin: string, bars: KrakenBar[], i: number, barH: number, p: ExitProfile, entryFee: number): Result & { exitBar: number; added: boolean } {
  const stopFrac = p.oneR;
  const holdBars = Math.ceil(p.maxHoldH / barH);
  const notional = RISK$ / stopFrac;
  const roll = ROLLOVER_4H[coin] ?? 0.0003;
  const entry = bars[i].c * (1 + CHASE);
  const oneR = entry * stopFrac;
  let stop = entry - oneR, peak = entry, exit = entry, reason = "time stop", closedAt = bars[Math.min(i + holdBars, bars.length - 1)].t;
  let exitBar = Math.min(i + holdBars, bars.length - 1);
  let add: { price: number; t: number } | null = null;
  for (let j = i + 1; j < bars.length && j <= i + holdBars; j++) {
    const b = bars[j];
    if (b.l <= stop) { exit = stop; reason = stop >= entry ? "trail" : "initial stop"; closedAt = b.t; exitBar = j; break; }
    peak = Math.max(peak, b.h);
    stop = managedStop(1, entry, peak, stop, oneR, p);
    exit = b.c; closedAt = b.t; exitBar = j;
    if (!add && b.c >= entry + oneR) add = { price: b.c * (1 + CHASE), t: b.t };
  }
  const heldH = ((closedAt - bars[i].t) / 3600) || barH;
  let gross = (notional * (exit - entry)) / entry;
  let fees = notional * (entryFee + TAKER) + (p.carry ? notional * roll * (heldH / 4) : 0);
  if (add) {
    const heldH2 = ((closedAt - add.t) / 3600) || barH;
    gross += (notional * (exit - add.price)) / add.price;
    fees += notional * (TAKER + TAKER) + (p.carry ? notional * roll * (heldH2 / 4) : 0);
  }
  const pnl = gross - fees;
  return { pnl, r: pnl / RISK$, reason, exitBar, added: !!add };
}

/**
 * ONE OPEN TRADE PER COIN, exactly as paper enforces. Without this, overlapping entries on
 * the same coin are counted as independent observations — they are not (they share the same
 * price move), and the t-stat inflates badly: the unfiltered 4h set is 189 "trades" at t=5.3
 * where the honest, non-overlapping set is 88 at t=2.7.
 *
 * Occupancy is decided by the CONTROL profile for EVERY variant, so all variants are scored
 * on an identical entry list and the comparison stays paired. ⚠️ That is generous to the
 * longer-holding variants: a 2R trail with a 7-day stop really would occupy the slot longer
 * and take FEWER trades than this shows. The exit effect is isolated; the opportunity cost
 * of holding is not modelled.
 */
function nonOverlapping(list: { e: Entry; bars: KrakenBar[] }[], barH: number, control: ExitProfile): { e: Entry; bars: KrakenBar[] }[] {
  const openUntil: Record<string, number> = {};
  const kept: { e: Entry; bars: KrakenBar[] }[] = [];
  for (const x of list) {
    if (x.e.i <= (openUntil[x.e.coin] ?? -1)) continue;
    kept.push(x);
    openUntil[x.e.coin] = simulate(x.e.coin, x.bars, x.e.i, barH, control, TAKER).exitBar;
  }
  return kept;
}

function tOf(xs: number[]): { n: number; mean: number; sd: number; t: number; ci: [number, number] } {
  const n = xs.length; if (!n) return { n: 0, mean: 0, sd: 0, t: 0, ci: [0, 0] };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const se = sd / Math.sqrt(n);
  return { n, mean, sd, t: se > 0 ? mean / se : 0, ci: [mean - 1.96 * se, mean + 1.96 * se] };
}
const money = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(0)}`;
function report(label: string, xs: number[], unit: "R" | "$" = "$") {
  const s = tOf(xs);
  const fmt = (v: number) => (unit === "$" ? money(v) : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}R`);
  const verdict = Math.abs(s.t) >= 2 ? (s.t > 0 ? "SIGNIFICANT +" : "SIGNIFICANT −") : "not distinguishable from zero";
  console.log(`  ${label.padEnd(34)} n=${String(s.n).padStart(3)}  avg ${fmt(s.mean).padStart(9)}  t=${s.t.toFixed(2).padStart(6)}  95% CI ${fmt(s.ci[0])} … ${fmt(s.ci[1])}   ${verdict}`);
  return s;
}

async function main() {
  const bars: Record<string, { d: KrakenBar[]; h4: KrakenBar[] }> = JSON.parse(readFileSync(CACHE, "utf8"));
  const CONTROL = exitParams("swing-lev", 5, 1);
  const WIDE = exitParams("swing-wide", 5, 1);
  const TIGHT: ExitProfile = { ...exitParams("swing-lev", 5, 1), tightAfterR: 1, tightTrailR: 0.5 };   // the retired swing-tight
  // "When we're up a lot, don't give it back": the NORMAL 1R trail until +2R, then 0.5R.
  // Leaves the modal ~1R winner alone; only protects the big runs.
  const LOCK2: ExitProfile = { ...exitParams("swing-lev", 5, 1), tightAfterR: 2, tightTrailR: 0.5 };
  const LOCK3: ExitProfile = { ...exitParams("swing-lev", 5, 1), tightAfterR: 3, tightTrailR: 0.5 };
  // The combination: let it run on a 2R trail, but once it is genuinely big (+3R) lock 0.5R.
  const WIDE_LOCK = exitParams("swing-lock", 5, 1);   // registered as the swing-lock twin

  // ---- collect entries once ----
  const raw4h: { e: Entry; bars: KrakenBar[] }[] = [], raw1d: { e: Entry; bars: KrakenBar[] }[] = [];
  for (const [coin, b] of Object.entries(bars)) {
    if (b.h4.length >= 60) for (const e of entries(coin, "4h", b.h4, b.d.length >= 25 ? b.d : null)) raw4h.push({ e, bars: b.h4 });
    if (b.d.length >= 60) for (const e of entries(coin, "1d", b.d, b.h4.length >= 25 ? b.h4 : null)) raw1d.push({ e, bars: b.d });
  }
  const all4h = nonOverlapping(raw4h, 4, CONTROL);
  const all1d = nonOverlapping(raw1d, 24, CONTROL);
  console.log(`Signals: 4h ${raw4h.length} raw → ${all4h.length} after one-open-trade-per-coin; 1d ${raw1d.length} → ${all1d.length}.`);
  console.log("The overlapping ones are NOT independent observations — counting them inflates every t below.\n");
  const run = (set: typeof all4h, barH: number, p: ExitProfile, fee: number) => set.map((x) => simulate(x.e.coin, x.bars, x.e.i, barH, p, fee));

  const c4 = run(all4h, 4, CONTROL, TAKER);
  const c1 = run(all1d, 24, CONTROL, TAKER);

  console.log("Each line: the rule's own per-trade P&L, its t-stat, and the 95% confidence interval.");
  console.log("Anything whose CI straddles zero is NOT established, however good the average looks.\n");
  console.log("── the record as it stands ──");
  const s4 = report("4h leg (as armed)", c4.map((x) => x.pnl));
  const s1 = report("1d leg (as armed)", c1.map((x) => x.pnl));
  report("both, i.e. live today", [...c4, ...c1].map((x) => x.pnl));

  // ---- Q1: cut the 1d leg? UNPAIRED — different signals, so Welch's t on the difference of means.
  console.log("\n── Q1  is the 4h leg genuinely better than the 1d leg, or is that noise? ──");
  const a = tOf(c4.map((x) => x.pnl)), b = tOf(c1.map((x) => x.pnl));
  const se = Math.sqrt(a.sd ** 2 / a.n + b.sd ** 2 / b.n);
  const diff = a.mean - b.mean, wt = se > 0 ? diff / se : 0;
  console.log(`  4h avg ${money(a.mean)} vs 1d avg ${money(b.mean)} → difference ${money(diff)}/trade, Welch t=${wt.toFixed(2)}`);
  console.log(`  95% CI on the difference: ${money(diff - 1.96 * se)} … ${money(diff + 1.96 * se)}`);
  console.log(`  ⇒ ${Math.abs(wt) >= 2 ? "the two legs ARE different — cutting 1d is supported" : "NOT established: the legs are within noise of each other"}`);
  console.log(`  (1d on its own: t=${s1.t.toFixed(2)} — negative, but ${Math.abs(s1.t) >= 2 ? "significantly so" : "NOT significantly so"})`);

  // ---- Q2: swing-wide's 2R trail. PAIRED — identical entries, only the exit differs.
  console.log("\n── Q2  does swing-wide's 2R trail beat the 1R trail? (paired, same entries) ──");
  const w4 = run(all4h, 4, WIDE, TAKER);
  const d2 = w4.map((x, i) => x.pnl - c4[i].pnl);
  report("2R trail (4h)", w4.map((x) => x.pnl));
  report("per-trade DIFFERENCE vs control", d2);
  const s2 = tOf(d2);
  console.log(`  ⇒ ${Math.abs(s2.t) >= 2 ? (s2.t > 0 ? "the wider trail IS better" : "the wider trail is WORSE") : "NOT established either way — keep collecting"}`);

  // ---- Q2b: swing-tight's 0.5R trail once +1R. PAIRED — the other half of Q2's question.
  // Registered Sep 11 2026 after ETH ran +1.24R to a $459 peak and the 1R trail kept $62.
  console.log("\n── Q2b does swing-tight's 0.5R trail (once +1R) beat the 1R trail? (paired, same entries) ──");
  const t4 = run(all4h, 4, TIGHT, TAKER);
  const dt = t4.map((x, i) => x.pnl - c4[i].pnl);
  report("0.5R trail once +1R (4h)", t4.map((x) => x.pnl));
  report("per-trade DIFFERENCE vs control", dt);
  const st = tOf(dt);
  const helped = dt.filter((d) => d > 0.005).length, hurt = dt.filter((d) => d < -0.005).length, same = dt.length - helped - hurt;
  console.log(`  trades where it kept MORE: ${helped}  ·  kept LESS: ${hurt}  ·  identical: ${same}`);
  console.log(`  ⇒ ${Math.abs(st.t) >= 2 ? (st.t > 0 ? "the tighter trail IS better" : "the tighter trail is WORSE") : "NOT established either way — keep collecting"}`);

  // ---- Q2c: lock in only the BIG winners. PAIRED. 1R trail as live, then 0.5R once +2R (and once +3R).
  console.log("\n── Q2c lock the big ones: 1R trail until +2R / +3R, then 0.5R? (paired, same entries) ──");
  for (const [label, prof] of [["lock after +2R", LOCK2], ["lock after +3R", LOCK3], ["2R trail + lock after +3R", WIDE_LOCK]] as const) {
    const l4 = run(all4h, 4, prof, TAKER);
    const dl = l4.map((x, i) => x.pnl - c4[i].pnl);
    report(`${label} (4h)`, l4.map((x) => x.pnl));
    report("per-trade DIFFERENCE vs control", dl);
    const sl = tOf(dl);
    const helped = dl.filter((d) => d > 0.005).length, hurt = dl.filter((d) => d < -0.005).length;
    console.log(`  kept MORE: ${helped} · kept LESS: ${hurt} · identical: ${dl.length - helped - hurt}`);
    console.log(`  ⇒ ${Math.abs(sl.t) >= 2 ? (sl.t > 0 ? "locking IS better" : "locking is WORSE") : "NOT established either way"}`);
  }

  // ---- Q2d: pyramid — add a second unit once +1R, 1R trail on the combined. PAIRED.
  console.log("\n── Q2d pyramid: add a 2nd unit at +1R (stop already at breakeven), trail 1R on both? (paired) ──");
  {
    const py = all4h.map((x) => simulatePyramid(x.e.coin, x.bars, x.e.i, 4, CONTROL, TAKER));
    const dp = py.map((x, i) => x.pnl - c4[i].pnl);
    const nAdded = py.filter((x) => x.added).length;
    report("pyramid (4h)", py.map((x) => x.pnl));
    report("per-trade DIFFERENCE vs control", dp);
    const sp = tOf(dp);
    const helped = dp.filter((d) => d > 0.005).length, hurt = dp.filter((d) => d < -0.005).length;
    console.log(`  added on ${nAdded}/${py.length} trades · kept MORE: ${helped} · kept LESS: ${hurt} · identical: ${dp.length - helped - hurt}`);
    const onlyAdded = py.map((x, i) => [x, c4[i]] as const).filter(([x]) => x.added);
    report("  on the trades that DID add — pyramid", onlyAdded.map(([x]) => x.pnl));
    report("  on the trades that DID add — control", onlyAdded.map(([, c]) => c.pnl));
    const worstP = Math.min(...py.map((x) => x.pnl)), worstC = Math.min(...c4.map((x) => x.pnl));
    console.log(`  worst single trade: pyramid ${worstP.toFixed(0)} · control ${worstC.toFixed(0)}`);
    console.log(`  ⇒ ${Math.abs(sp.t) >= 2 ? (sp.t > 0 ? "pyramiding IS better" : "pyramiding is WORSE") : "NOT established either way"}`);
  }

  // ---- Q3: maker entries. PAIRED — identical trades, only the entry fee differs.
  console.log("\n── Q3  would maker entries pay? (paired, same trades, entry fee 0.25% → 0.16%) ──");
  const m4 = run(all4h, 4, CONTROL, MAKER);
  const d3 = m4.map((x, i) => x.pnl - c4[i].pnl);
  report("maker entry (4h)", m4.map((x) => x.pnl));
  // No t-test here: the saving is a CONSTANT per trade, so the standard deviation is zero
  // and a t-stat is meaningless (it printed as 1.8e15 before this note existed).
  const dm = tOf(d3);
  console.log(`  per-trade DIFFERENCE vs taker      n=${d3.length}  every trade improves by exactly ${money(dm.mean)} (sd ${dm.sd.toFixed(4)} — a constant, so no t-test applies)`);
  console.log(`  ⇒ total over the sample: ${money(dm.mean * d3.length)}, i.e. ${((dm.mean / Math.abs(tOf(c4.map((x) => x.pnl)).mean)) * 100).toFixed(0)}% of the average trade's P&L.`);
  console.log(`     BUT this assumes the post-only entry FILLS. It does not model the breakouts that run away unfilled.`);

  // ---- Q4: is the 4h result robust, or is it one month / one coin?
  console.log("\n── Q4  is the 4h edge robust to dropping any single month, or any single coin? ──");
  const months = [...new Set(all4h.map((x) => x.e.month))].sort();
  for (const m of months) {
    const keep = c4.filter((_, i) => all4h[i].e.month !== m);
    const s = tOf(keep.map((x) => x.pnl));
    console.log(`  without ${m}: n=${String(s.n).padStart(3)}  net ${money(s.mean * s.n).padStart(8)}  t=${s.t.toFixed(2).padStart(5)}${s.t < 2 ? "   ← falls below t=2" : ""}`);
  }
  const coins = [...new Set(all4h.map((x) => x.e.coin))];
  let worst = { coin: "", t: 99 };
  for (const c of coins) {
    const s = tOf(c4.filter((_, i) => all4h[i].e.coin !== c).map((x) => x.pnl));
    if (s.t < worst.t) worst = { coin: c, t: s.t };
  }
  console.log(`  worst single-coin removal: without ${worst.coin}, t=${worst.t.toFixed(2)}${worst.t < 2 ? "   ← falls below t=2" : "   (survives)"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
