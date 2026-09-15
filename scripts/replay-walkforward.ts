// WALK-FORWARD · OOS · SENSITIVITY · MONTE CARLO for the live crypto rule (C6, Sep 15 2026).
//
//   npx tsx scripts/replay-walkforward.ts --all --source swing-pyr --vault
//   flags: --wf (WF1+WF2)  --grid (S1)  --mc (MC1)  --all  --source <sleeve>  --plane (S1 stop×trail only)
//          --data <dir>  --out <file>  --vault (write Performance/margin-research.md)
//
// The four questions are PRE-REGISTERED in docs/KRAKEN-DESK-OPERATING-MODEL.md §4 (committed
// before this script first ran); this file only computes them. Entries are the desk's own
// detector and conviction scorer on Binance 1h bars aggregated to UTC 4h/1d (scripts/lib/bars.ts),
// one open trade per coin decided by the CONTROL profile (swing-lev) exactly as
// backtest-variants.ts does — identical entries for every variant, every cell, every fold.
// Verdict words appear only at |t| ≥ 2. Every table carries n, t and a 95% CI.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exitParams, type ExitProfile } from "../src/lib/margin-shadow";
import type { KrakenBar } from "../src/lib/kraken-margin";
import { DEFAULT_DATA_DIR, loadResearchBars } from "./lib/bars";
import { RISK$, TAKER, entries, money, monteCarlo, nonOverlapping, simulate, simulatePartial, simulatePyramid, tOf, type Entry, type Stat } from "./lib/replay-engine";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const arg = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const ALL = has("all");
const DO_WF = ALL || has("wf"), DO_GRID = ALL || has("grid"), DO_MC = ALL || has("mc");
const SOURCE = arg("source", "swing-pyr");
const DATA_DIR = arg("data", DEFAULT_DATA_DIR);
const VAULT_DIR = process.env.VAULT_DIR ?? "/Users/user/Desktop/Trading/Trading";
const OUT = arg("out", has("vault") ? join(VAULT_DIR, "Performance", "margin-research.md") : join(process.cwd(), "margin-research.md"));
const PLANE_ONLY = has("plane");

// ---- the rule under test ------------------------------------------------------------------------
const CONTROL = exitParams("swing-lev", 5, 1);     // occupancy + the 1R control
const WIDE = exitParams("swing-wide", 5, 1);
type Sim = (coin: string, bars: KrakenBar[], i: number) => { pnl: number; r: number };
function ruleFor(source: string): { sim: Sim; label: string } {
  switch (source) {
    case "swing-lev": return { sim: (c, b, i) => simulate(c, b, i, 4, CONTROL, TAKER), label: "swing-lev: 4% stop, 1R trail, 96h" };
    case "swing-wide": return { sim: (c, b, i) => simulate(c, b, i, 4, WIDE, TAKER), label: "swing-wide: 4% stop, 2R trail, 168h" };
    case "swing-lock": return { sim: (c, b, i) => simulate(c, b, i, 4, exitParams("swing-lock", 5, 1), TAKER), label: "swing-lock: 2R trail, 0.5R lock after +3R" };
    case "swing-partial": return { sim: (c, b, i) => simulatePartial(c, b, i, 4, exitParams("swing-partial", 5, 1), TAKER), label: "swing-partial: 2R trail, 30% banked at +2R" };
    case "swing-pyr": default: return { sim: (c, b, i) => simulatePyramid(c, b, i, 4, WIDE, TAKER, true, 1), label: "swing-pyr: 4% stop, 2R trail, 168h, risk-sized add at +1R (THE LIVE RULE)" };
  }
}

// ---- folds (pre-registered) ---------------------------------------------------------------------
const FOLDS = [
  { name: "F1", isFrom: "2024-01-01", isTo: "2025-01-01", oosFrom: "2025-01-01", oosTo: "2025-07-01" },
  { name: "F2", isFrom: "2024-01-01", isTo: "2025-07-01", oosFrom: "2025-07-01", oosTo: "2026-01-01" },
  { name: "F3", isFrom: "2024-01-01", isTo: "2026-01-01", oosFrom: "2026-01-01", oosTo: "2026-07-01" },
];
const POST = { name: "post", from: "2026-07-01", to: "2099-01-01" };   // after the pre-registered folds — reported, never a fold

// ---- the S1 grid --------------------------------------------------------------------------------
const STOPS = [0.03, 0.04, 0.05], TRAILS = [1.5, 2, 2.5], HOLDS = [120, 168, 240], ADDS: (number | null)[] = [null, 0.75, 1, 1.25];
interface Cell { stop: number; trail: number; hold: number; add: number | null; key: string }
function cells(planeOnly: boolean): Cell[] {
  const out: Cell[] = [];
  for (const stop of STOPS) for (const trail of TRAILS) for (const hold of planeOnly ? [168] : HOLDS) for (const add of planeOnly ? [1] : ADDS) out.push({ stop, trail, hold, add, key: `${stop * 100}/${trail}/${hold}/${add ?? "none"}` });
  return out;
}
function cellSim(c: Cell): Sim {
  const p: ExitProfile = { maxHoldH: c.hold, oneR: c.stop, carry: true, trailR: c.trail };
  return c.add == null ? (coin, b, i) => simulate(coin, b, i, 4, p, TAKER) : (coin, b, i) => simulatePyramid(coin, b, i, 4, p, TAKER, true, c.add as number);
}
const LIVE_CELL = "4/2/168/1";

// ---- helpers ------------------------------------------------------------------------------------
const fmtStat = (s: Stat) => `n=${s.n} · avg ${money(s.mean)} · t=${s.t.toFixed(2)} · 95% CI ${money(s.ci[0])} … ${money(s.ci[1])}`;
const verdict = (t: number, pos: string, neg: string) => (Math.abs(t) >= 2 ? (t > 0 ? pos : neg) : "not distinguishable from zero");
const sec = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
interface Sample { e: Entry; bars: KrakenBar[]; t: number }
const within = (xs: Sample[], from: string, to: string) => xs.filter((x) => x.t >= sec(from) && x.t < sec(to));

async function main() {
  const t0 = Date.now();
  const lines: string[] = [];
  const log = (s = "") => { lines.push(s); console.log(s); };
  const { bars, missing } = loadResearchBars(DATA_DIR);
  if (!bars.length) { console.error(`no bars under ${DATA_DIR} — run scripts/crypto-bars-refresh.ts`); process.exit(1); }
  const rule = ruleFor(SOURCE);
  const at = new Date().toISOString();
  const first = Math.min(...bars.map((b) => b.h4[0].t)), last = Math.max(...bars.map((b) => b.h4[b.h4.length - 1].t));
  log("---"); log(`last_updated: "${at.slice(0, 10)}"`); log('updated_by: "replay-walkforward"'); log("tags: [performance, margin, research, walk-forward, monte-carlo]"); log("---"); log();
  log(`# Margin desk — walk-forward, sensitivity and Monte Carlo (${at.slice(0, 10)})`); log();
  log(`> Pre-registered in docs/KRAKEN-DESK-OPERATING-MODEL.md §4 (2026-09-15). Rule under test: **${rule.label}**. Data: Binance 1h → UTC 4h/1d, ${bars.map((b) => b.coin).join(" ")} (${missing.length ? `missing: ${missing.join(" ")}; ` : ""}${new Date(first * 1000).toISOString().slice(0, 10)} → ${new Date(last * 1000).toISOString().slice(0, 10)}). Entries: the desk's own detector + conviction scorer (high tier, 1d context), one open trade per coin by the swing-lev control — identical entries for every line below. Paper's fees and rollover; risk $${RISK$.toFixed(0)} per trade (6% of $${(RISK$ / 0.06).toFixed(0)}). **Verdict words only at |t| ≥ 2.** Sharpe-free by design: the numbers are per-trade expectancy, t and CI.`); log();

  // ---- entries once ----
  const raw: { e: Entry; bars: KrakenBar[] }[] = [];
  for (const b of bars) for (const e of entries(b.coin, "4h", b.h4, b.d.length >= 25 ? b.d : null)) raw.push({ e, bars: b.h4 });
  const kept = nonOverlapping(raw, 4, CONTROL).map((x) => ({ ...x, t: x.bars[x.e.i].t })).sort((a, b) => a.t - b.t);
  log(`Signals: ${raw.length} raw high-conviction 4h breakouts → **${kept.length} after one-open-trade-per-coin** (the overlapping ones are not independent observations).`); log();
  const live = kept.map((x) => rule.sim(x.e.coin, x.bars, x.e.i));
  const livePnl = live.map((r) => r.pnl);
  log(`## The rule on the whole sample (in-sample by construction)`); log();
  log(`- ${fmtStat(tOf(livePnl))} — ${verdict(tOf(livePnl).t, "positive", "negative")}`);
  const byYear = new Map<string, number[]>();
  kept.forEach((x, i) => { const y = new Date(x.t * 1000).toISOString().slice(0, 4); byYear.set(y, [...(byYear.get(y) ?? []), livePnl[i]]); });
  log(`- by year: ${[...byYear.entries()].map(([y, xs]) => `${y} ${fmtStat(tOf(xs))}`).join(" · ")}`);
  const byCoin = new Map<string, number[]>();
  kept.forEach((x, i) => byCoin.set(x.e.coin, [...(byCoin.get(x.e.coin) ?? []), livePnl[i]]));
  log(`- by coin: ${[...byCoin.entries()].map(([c, xs]) => { const s = tOf(xs); return `${c} n=${s.n} ${money(s.mean)} (t ${s.t.toFixed(2)})`; }).join(" · ")}`);
  const jack = [...byCoin.keys()].map((c) => ({ c, s: tOf(livePnl.filter((_, i) => kept[i].e.coin !== c)) })).sort((a, b) => a.s.t - b.s.t);
  log(`- jackknife by coin (drop one): t ranges ${jack[0].s.t.toFixed(2)} (without ${jack[0].c}) … ${jack[jack.length - 1].s.t.toFixed(2)} (without ${jack[jack.length - 1].c})`); log();
  // Paired against the comparators on the same entries — the Q2/Q2f questions on the long sample.
  const ctl = kept.map((x) => simulate(x.e.coin, x.bars, x.e.i, 4, CONTROL, TAKER).pnl);
  const wide = kept.map((x) => simulate(x.e.coin, x.bars, x.e.i, 4, WIDE, TAKER).pnl);
  const partial = kept.map((x) => simulatePartial(x.e.coin, x.bars, x.e.i, 4, exitParams("swing-partial", 5, 1), TAKER).pnl);
  log(`Paired on the same ${kept.length} entries (per-trade DIFFERENCE, rule − comparator):`); log();
  log(`| comparator | comparator alone | rule − comparator | read |`, `|---|---|---|---|`);
  for (const [name, xs] of [["swing-lev (1R trail, 96h)", ctl], ["swing-wide (2R trail, 168h)", wide], ["swing-partial (2R trail, 30% banked at +2R) — the 5a twin, replayed", partial]] as const) {
    const d = tOf(livePnl.map((x, i) => x - xs[i]));
    log(`| ${name} | ${fmtStat(tOf(xs))} | ${fmtStat(d)} | ${verdict(d.t, "rule better", "rule WORSE")} |`);
  }
  log();

  // ---- WF1 ----
  if (DO_WF) {
    log(`## WF1 — anchored 3-fold walk-forward of the live rule`); log();
    log(`> The rule has no fitted parameter, so each fold asks one thing: is the OOS expectancy positive, and is the pooled OOS t ≥ 2? IS is shown for scale only.`); log();
    log(`| fold | IS window | IS n / avg / t | OOS window | OOS n | OOS avg | OOS t | 95% CI | read |`, `|---|---|---|---|---|---|---|---|---|`);
    const oosAll: number[] = [];
    for (const f of FOLDS) {
      const is = within(kept, f.isFrom, f.isTo).map((x) => rule.sim(x.e.coin, x.bars, x.e.i).pnl);
      const oos = within(kept, f.oosFrom, f.oosTo).map((x) => rule.sim(x.e.coin, x.bars, x.e.i).pnl);
      oosAll.push(...oos);
      const a = tOf(is), b = tOf(oos);
      log(`| ${f.name} | ${f.isFrom}→${f.isTo} | ${a.n} / ${money(a.mean)} / ${a.t.toFixed(2)} | ${f.oosFrom}→${f.oosTo} | ${b.n} | ${money(b.mean)} | ${b.t.toFixed(2)} | ${money(b.ci[0])} … ${money(b.ci[1])} | ${b.n < 10 ? "too thin" : verdict(b.t, "positive OOS", "NEGATIVE OOS")} |`);
    }
    const pooled = tOf(oosAll);
    log(`| **pooled OOS** | — | — | 2025-01→2026-07 | **${pooled.n}** | **${money(pooled.mean)}** | **${pooled.t.toFixed(2)}** | ${money(pooled.ci[0])} … ${money(pooled.ci[1])} | **${verdict(pooled.t, "the rule pays out of sample", "the rule LOSES out of sample")}** |`);
    const post = within(kept, POST.from, POST.to).map((x) => rule.sim(x.e.coin, x.bars, x.e.i).pnl);
    const ps = tOf(post);
    log(`| post-folds (not a fold) | — | — | 2026-07→latest | ${ps.n} | ${money(ps.mean)} | ${ps.t.toFixed(2)} | ${money(ps.ci[0])} … ${money(ps.ci[1])} | ${ps.n < 10 ? "too thin" : verdict(ps.t, "positive", "negative")} |`);
    log();
  }

  // ---- S1 + WF2 ----
  if (DO_GRID || DO_WF) {
    const grid = cells(PLANE_ONLY);
    const gt0 = Date.now();
    const cellPnl = new Map<string, number[]>();
    for (const c of grid) { const sim = cellSim(c); cellPnl.set(c.key, kept.map((x) => sim(x.e.coin, x.bars, x.e.i).pnl)); }
    const gridMs = Date.now() - gt0;
    if (DO_GRID) {
      log(`## S1 — sensitivity grid, read for FLATNESS (never to pick a cell)`); log();
      log(`> ${grid.length} cells: stop {3,4,5}% × trail {1.5,2,2.5}R × hold ${PLANE_ONLY ? "168h" : "{120,168,240}h"} × add ${PLANE_ONLY ? "1R" : "{none,0.75,1,1.25}R"} on the same ${kept.length} entries (${(gridMs / 1000).toFixed(1)}s). A **cliff** is a neighbouring cell (one parameter, one step) whose paired per-trade difference exceeds 2 SE. The live cell is ${LIVE_CELL}.${PLANE_ONLY ? " (--plane: stop × trail plane only.)" : ""}`); log();
      // Neighbours and cliffs.
      const idx = (arr: readonly (number | null)[], v: number | null) => arr.findIndex((x) => x === v);
      let edges = 0, cliffs = 0;
      const cliffList: string[] = [];
      const liveNeighbours: string[] = [];
      const neighboursOf = (c: Cell): Cell[] => {
        const out: Cell[] = [];
        const dims: [keyof Cell, readonly (number | null)[]][] = [["stop", STOPS], ["trail", TRAILS], ["hold", PLANE_ONLY ? [168] : HOLDS], ["add", PLANE_ONLY ? [1] : ADDS]];
        for (const [dim, arr] of dims) {
          const k = idx(arr, c[dim] as number | null);
          for (const d of [-1, 1]) { const v = arr[k + d]; if (v === undefined) continue; const n = grid.find((g) => g.stop === (dim === "stop" ? v : c.stop) && g.trail === (dim === "trail" ? v : c.trail) && g.hold === (dim === "hold" ? v : c.hold) && g.add === (dim === "add" ? v : c.add)); if (n) out.push(n); }
        }
        return out;
      };
      for (const c of grid) {
        const a = cellPnl.get(c.key)!;
        for (const n of neighboursOf(c)) {
          if (n.key < c.key) continue;   // each edge once
          edges++;
          const d = tOf(a.map((x, i) => x - cellPnl.get(n.key)![i]));
          const se = d.sd / Math.sqrt(Math.max(1, d.n));
          const cliff = Math.abs(d.mean) > 2 * se && se > 0;
          if (cliff) { cliffs++; if (cliffList.length < 12) cliffList.push(`${c.key} vs ${n.key}: Δ ${money(d.mean)}/trade (t=${d.t.toFixed(2)})`); }
          if (c.key === LIVE_CELL || n.key === LIVE_CELL) liveNeighbours.push(`${c.key === LIVE_CELL ? n.key : c.key}: Δ ${money(c.key === LIVE_CELL ? -d.mean : d.mean)} (t=${(c.key === LIVE_CELL ? -d.t : d.t).toFixed(2)})${cliff ? " **CLIFF**" : ""}`);
        }
      }
      const liveStat = tOf(cellPnl.get(LIVE_CELL) ?? []);
      log(`- Cliffs: **${cliffs} of ${edges} neighbour edges** (${edges ? ((cliffs / edges) * 100).toFixed(0) : "—"}%).${cliffList.length ? ` First: ${cliffList.join("; ")}.` : ""}`);
      log(`- The live cell ${LIVE_CELL}: ${fmtStat(liveStat)}. Neighbours (Δ = neighbour − live, per trade): ${liveNeighbours.join(" · ")}.`);
      const sorted = [...grid].map((c) => ({ c, s: tOf(cellPnl.get(c.key)!) })).sort((a, b) => b.s.mean - a.s.mean);
      log(`- Best cell by expectancy: ${sorted[0].c.key} (${fmtStat(sorted[0].s)}); worst: ${sorted[sorted.length - 1].c.key} (${fmtStat(sorted[sorted.length - 1].s)}). Cells with t ≥ 2: ${sorted.filter((x) => x.s.t >= 2).length}/${grid.length}. The best cell is NOT a recommendation — it is the one most likely to be luck.`); log();
      log(`Stop × trail plane at hold 168h, add 1R (avg $/trade, t):`); log();
      log(`| stop \\ trail | 1.5R | 2R | 2.5R |`, `|---|---|---|---|`);
      for (const stop of STOPS) log(`| ${stop * 100}% | ${TRAILS.map((tr) => { const s = tOf(cellPnl.get(`${stop * 100}/${tr}/168/1`) ?? []); return `${money(s.mean)} (t ${s.t.toFixed(2)})`; }).join(" | ")} |`);
      log();
      if (!PLANE_ONLY) {
        log(`Hold × add plane at stop 4%, trail 2R (avg $/trade, t):`); log();
        log(`| hold \\ add | none | 0.75R | 1R | 1.25R |`, `|---|---|---|---|---|`);
        for (const hold of HOLDS) log(`| ${hold}h | ${ADDS.map((ad) => { const s = tOf(cellPnl.get(`4/2/${hold}/${ad ?? "none"}`) ?? []); return `${money(s.mean)} (t ${s.t.toFixed(2)})`; }).join(" | ")} |`);
        log();
      }
    }
    if (DO_WF) {
      log(`## WF2 — walk-forward efficiency: does picking the IS-best cell beat the live rule OOS?`); log();
      log(`> Per fold: the cell with the best IS expectancy is applied OOS and compared, paired on the same entries, with the live rule OOS. Efficiency = picked cell's OOS ÷ IS expectancy. Sub-0.5 or negative is the expected result and is why the desk does not pick cells.`); log();
      log(`| fold | IS-best cell | IS avg (t) | its OOS avg (t) | efficiency | live rule OOS avg (t) | paired Δ (picked − live) | read |`, `|---|---|---|---|---|---|---|---|`);
      for (const f of FOLDS) {
        const isIdx = kept.map((x, i) => (x.t >= sec(f.isFrom) && x.t < sec(f.isTo) ? i : -1)).filter((i) => i >= 0);
        const oosIdx = kept.map((x, i) => (x.t >= sec(f.oosFrom) && x.t < sec(f.oosTo) ? i : -1)).filter((i) => i >= 0);
        let best: { c: Cell; s: Stat } | null = null;
        for (const c of grid) { const s = tOf(isIdx.map((i) => cellPnl.get(c.key)![i])); if (!best || s.mean > best.s.mean) best = { c, s }; }
        if (!best) continue;
        const oosPicked = tOf(oosIdx.map((i) => cellPnl.get(best!.c.key)![i]));
        const oosLive = tOf(oosIdx.map((i) => livePnl[i]));
        const d = tOf(oosIdx.map((i) => cellPnl.get(best!.c.key)![i] - livePnl[i]));
        const eff = best.s.mean !== 0 ? oosPicked.mean / best.s.mean : NaN;
        log(`| ${f.name} | ${best.c.key} | ${money(best.s.mean)} (${best.s.t.toFixed(2)}) | ${money(oosPicked.mean)} (${oosPicked.t.toFixed(2)}) | ${Number.isFinite(eff) ? eff.toFixed(2) : "—"} | ${money(oosLive.mean)} (${oosLive.t.toFixed(2)}) | ${money(d.mean)} (t ${d.t.toFixed(2)}, n ${d.n}) | ${oosIdx.length < 10 ? "too thin" : verdict(d.t, "picking WON", "picking LOST")} |`);
      }
      log();
    }
  }

  // ---- MC1 ----
  if (DO_MC) {
    log(`## MC1 — block bootstrap of the rule's R-multiples`); log();
    const rs = live.map((r) => r.r);
    const rStat = tOf(rs);
    const bucket = (lo: number, hi: number) => rs.filter((r) => r > lo && r <= hi).length;
    log(`> ${rs.length} R-multiples (fee-inclusive, pnl ÷ $${RISK$.toFixed(0)}): mean ${rStat.mean.toFixed(3)}R, sd ${rStat.sd.toFixed(3)}R, hit ${((rs.filter((r) => r > 0).length / rs.length) * 100).toFixed(0)}% (a 2R trail banks breakeven-minus-fees on every +1R…+2R peak that reverses, so "hit" is low by construction), best ${Math.max(...rs).toFixed(2)}R, worst ${Math.min(...rs).toFixed(2)}R. Distribution: ≤ −0.9R ${rs.filter((r) => r <= -0.9).length} · (−0.9, 0] ${bucket(-0.9, 0)} · (0, 1] ${bucket(0, 1)} · (1, 3] ${bucket(1, 3)} · > 3R ${rs.filter((r) => r > 3).length}. Block length 5 (circular), seeded; 10,000 paths × 100 trades on $5,000, risking the stated % of CURRENT equity per trade; the 15% drawdown breaker halts a path. A variance map, not a size recommendation — read beside the 8% ceiling sweep (cliff at 12%).`); log();
    log(`| risk/trade | P(hit 15% breaker) | median maxDD | 95th maxDD | longest loss streak (median / 95th) | P(−50%) | P(+50%) | median final |`, `|---|---|---|---|---|---|---|---|`);
    for (const m of monteCarlo(rs, { paths: 10_000, trades: 100, block: 5, equity: 5000, riskPcts: [3, 5, 8], seed: 20260915 })) {
      log(`| ${m.riskPct}% | ${(m.pBreaker * 100).toFixed(1)}% | ${(m.medianDD * 100).toFixed(1)}% | ${(m.p95DD * 100).toFixed(1)}% | ${m.longestStreakMedian} / ${m.longestStreakP95} | ${(m.pMinus50 * 100).toFixed(1)}% | ${(m.pPlus50 * 100).toFixed(1)}% | ${(m.medianFinal * 100).toFixed(0)}% |`);
    }
    log();
  }

  log(`## How to read this`); log();
  log(`- WF1 is the honest test of the rule as armed: three OOS windows nobody tuned on. WF2 is the argument against tuning. S1 says whether the live cell sits on a cliff; MC1 says what 100 trades of this distribution do to a $5k account at each risk rung.`);
  log(`- Every entry here is a replay on Binance bars; the FORWARD paper record (Performance/margin-statistics.md) is the evidence that decides arming. Re-run after \`scripts/crypto-bars-refresh.ts\`: \`npx tsx scripts/replay-walkforward.ts --all --source ${SOURCE} --vault\`.`);
  log(`- Wall time: ${((Date.now() - t0) / 1000).toFixed(0)}s.`);

  const md = `${lines.join("\n")}\n`;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, md);
  console.log(`\nwritten → ${OUT}`);
  if (has("vault") && process.env.DATABASE_URL && !/placeholder/.test(process.env.DATABASE_URL)) {
    try { const { vaultWrite } = await import("../src/lib/vault"); await vaultWrite("Performance/margin-research.md", md, "replay-walkforward"); console.log("vault DB document updated"); }
    catch (e) { console.log(`vault DB write skipped: ${String(e).slice(0, 80)}`); }
  } else if (has("vault")) console.log(`vault DB write skipped (no live DATABASE_URL); the Obsidian file ${existsSync(OUT) ? "is written" : "was not written"} — run \`npm run vault:push\` to sync.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
