/**
 * EDGE FACTORY — replays candidate rules on the 15-year one-minute archive and judges them with
 * `validateCandidate` (unchanged since Sep 5). Research only: writes no flags, arms nothing.
 *
 * Usage
 *   SET=prompt  npx tsx scripts/edge-factory.ts [ES NQ GC YM SI HG]   the TRADOVATE prompt's families (E10)
 *   SET=legacy  npx tsx scripts/edge-factory.ts [ES NQ GC]            the Sep 5 families (default)
 *   DATA_DIR=data/tf15y (default) · VAULT_DIR=~/Desktop/Trading/Trading (default) · NO_VAULT=1 skips the vault write
 *   The slippage table lives in futures-desk-journal.ts, whose import chain constructs the Prisma
 *   client (it never connects here), so run with the tests' placeholder:
 *   DATABASE_URL='postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder'
 *
 * Pre-registration is enforced: a SET=prompt candidate whose family and key are not in
 * `research/edge-factory-trials.json` → `preRegistered` refuses to run. Every market × bar size ×
 * candidate is appended to the ledger's `hypotheses` before the first replay, and the count of ALL
 * hypotheses ever declared is what the multiple-testing adjustment divides by.
 *
 * Slippage (both sides) comes from the desk's own journal model, `SLIP_PTS_PER_SIDE` — ES/NQ/GC
 * measured, YM/SI/HG assumed and labelled. That is stricter than the Sep 5 run (which charged one
 * tick on the exit), so legacy numbers re-run here come out lower, not higher.
 *
 * Output: the console, and `Performance/futures-research.md` in the local Obsidian vault (the
 * launchd `vault-sync` job pushes it to the DB-backed vault the desk pages read) — n / t / 95% CI on
 * every row; a verdict WORD only where |t| ≥ 2. Runs locally, never on Vercel.
 */
import fs from "node:fs";
import path from "node:path";
import { FIVE_MINUTE_CANDIDATES, HOURLY_CANDIDATES, PROMPT_FAMILY_CANDIDATES } from "../src/lib/edge-factory/candidates";
import { aggregateBars, loadDatabentoCsv } from "../src/lib/edge-factory/data";
import { replayCandidateDetailed } from "../src/lib/edge-factory/replay";
import { edgeStatistics, validateCandidate } from "../src/lib/edge-factory/validation";
import type { EdgeCandidate, EdgeStatistics, MarketSpec, ReplayTrade, ValidationVerdict } from "../src/lib/edge-factory/types";
import { SLIP_PTS_PER_SIDE } from "../src/lib/futures-desk-journal";
import { MICRO_FOR_ROOT } from "../src/lib/futures-desk-rules";

const COMMISSION_ROUND_TURN = 2.02;
const TICK: Record<MarketSpec["symbol"], number> = { ES: 0.25, NQ: 0.25, GC: 0.1, YM: 1, SI: 0.005, HG: 0.0005 };
function market(symbol: MarketSpec["symbol"]): MarketSpec {
  const slip = SLIP_PTS_PER_SIDE[symbol];
  return {
    symbol, tradedSymbol: MICRO_FOR_ROOT[symbol].micro as MarketSpec["tradedSymbol"], pointValue: MICRO_FOR_ROOT[symbol].pointValue,
    tickSize: TICK[symbol], commissionRoundTurn: COMMISSION_ROUND_TURN,
    entrySlippagePoints: slip.pts, exitSlippagePoints: slip.pts, slippageSource: slip.source,
  };
}
const SET = process.env.SET === "prompt" ? "prompt" : "legacy";
const MARKETS: MarketSpec[] = (SET === "prompt" ? ["ES", "NQ", "GC", "YM", "SI", "HG"] as const : ["ES", "NQ", "GC"] as const).map(market);
const DATA_DIR = process.env.DATA_DIR || "data/tf15y";
const VAULT_DIR = process.env.VAULT_DIR || path.join(process.env.HOME || "/Users/user", "Desktop/Trading/Trading");
const VAULT_DOC = "Performance/futures-research.md";
const DONCHIAN_RECORD = "research/trend-portfolio-2026-09-15.txt";

const selected = process.argv.slice(2).map((value) => value.toUpperCase());
const markets = selected.length ? MARKETS.filter((m) => selected.includes(m.symbol)) : MARKETS;
const skipped = MARKETS.filter((m) => !markets.includes(m)).map((m) => m.symbol);

// ---- the ledger: declare before running ------------------------------------------------------------
interface PreRegistration { family: string; registeredAt: string; markets: string[]; barMinutes: number; candidates: string[]; hypothesis: string; expectation: string; slippage: string; gate: string; params: Record<string, unknown> }
interface Ledger { formatVersion: number; hypotheses: string[]; preRegistered?: PreRegistration[] }
const trialLedgerPath = path.resolve("research/edge-factory-trials.json");
const trialLedger = JSON.parse(fs.readFileSync(trialLedgerPath, "utf8")) as Ledger;
const candidates: readonly EdgeCandidate[] = SET === "prompt" ? PROMPT_FAMILY_CANDIDATES : [...FIVE_MINUTE_CANDIDATES, ...HOURLY_CANDIDATES];
const registrations = new Map((trialLedger.preRegistered ?? []).map((r) => [r.family, r]));
if (SET === "prompt") {
  for (const c of candidates) {
    const reg = registrations.get(c.family);
    if (!reg || !reg.candidates.includes(c.key) || reg.barMinutes !== c.barMinutes) throw new Error(`${c.key} is not pre-registered in research/edge-factory-trials.json — declare it (hypothesis, markets, bar size, params, expectation) before running it`);
  }
}
const declaredHypotheses = MARKETS.flatMap((m) => candidates.map((c) => `${m.symbol}|${c.barMinutes === 60 ? "1h" : `${c.barMinutes}m`}|${c.key}|${c.version}`));
trialLedger.hypotheses = [...new Set([...trialLedger.hypotheses, ...declaredHypotheses])].sort();
fs.writeFileSync(trialLedgerPath, `${JSON.stringify(trialLedger, null, 2)}\n`);
const hypothesesTested = trialLedger.hypotheses.length;

// ---- formatting ---------------------------------------------------------------------------------------
const sign = (n: number, d = 3) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
const pf = (s: EdgeStatistics) => (Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : s.trades ? "∞" : "—");
const compact = (s: EdgeStatistics) =>
  `n=${s.trades} net=${s.netPnl >= 0 ? "+" : ""}$${s.netPnl.toFixed(0)} PF=${pf(s)} exp=${sign(s.expectancyR)}R [${sign(s.expectancyCi95[0])}, ${sign(s.expectancyCi95[1])}] t=${s.tStat.toFixed(2)} DD=${s.maxDrawdownR.toFixed(1)}R`;
/** A verdict WORD only where the full sample is significant either way; everything else is "—". */
const verdictWord = (s: EdgeStatistics) => (s.trades >= 30 && s.tStat >= 2 ? "POSITIVE (t ≥ 2, still gated)" : s.trades >= 30 && s.tStat <= -2 ? "NEGATIVE (t ≤ −2)" : "—");

interface Row { market: MarketSpec; candidate: EdgeCandidate; full: EdgeStatistics; verdict: ValidationVerdict; trades: ReplayTrade[]; diagnostics: ReturnType<typeof replayCandidateDetailed>["diagnostics"] }
const rows: Row[] = [];
const timings: { symbol: string; seconds: number; bars: number; from: string; to: string }[] = [];
const started = Date.now();

for (const m of markets) {
  const file = path.resolve(DATA_DIR, `${m.symbol}_1m.csv`);
  if (!fs.existsSync(file)) { console.log(`\n${m.symbol}: ${file} not found — skipped`); skipped.push(m.symbol); continue; }
  const t0 = Date.now();
  const minute = loadDatabentoCsv(file);
  const series = new Map<number, ReturnType<typeof aggregateBars>>();
  for (const width of new Set(candidates.map((c) => c.barMinutes))) series.set(width, aggregateBars(minute, width));
  const from = new Date(minute[0].t).toISOString().slice(0, 10), to = new Date(minute.at(-1)!.t).toISOString().slice(0, 10);
  console.log(`\n${m.tradedSymbol} edge factory (${SET}) | ${minute.length.toLocaleString()} one-minute bars | ${from} to ${to} | slippage ${m.entrySlippagePoints} pts/side (${m.slippageSource})`);
  console.log(`multiple-testing ledger: ${hypothesesTested} unique market/timeframe/parameter hypotheses`);
  for (const candidate of candidates) {
    const bars = series.get(candidate.barMinutes)!;
    const replay = replayCandidateDetailed(bars, candidate, m);
    const verdict = validateCandidate(replay.trades, hypothesesTested, { diagnostics: replay.diagnostics });
    const full = edgeStatistics(replay.trades);
    rows.push({ market: m, candidate, full, verdict, trades: replay.trades, diagnostics: replay.diagnostics });
    console.log(`${verdict.status.padEnd(9)} ${candidate.key.padEnd(34)} FULL ${compact(full)} | DEV ${compact(verdict.development)} | EVAL ${compact(verdict.evaluation)} | p*=${verdict.adjustedPValue.toFixed(4)}`);
    console.log(`  ${verdict.reasons.join("; ") || "historical research gate passed; real-fill evidence is still required"}`);
    if (replay.diagnostics.unpriceableEntries || replay.diagnostics.invalidSignals || replay.diagnostics.rollInterruptedTrades) {
      console.log(`  execution diagnostics: signals=${replay.diagnostics.signals} unpriceable=${replay.diagnostics.unpriceableEntries} invalid=${replay.diagnostics.invalidSignals} roll-crossing=${replay.diagnostics.rollCrossingEntries} roll-interrupted=${replay.diagnostics.rollInterruptedTrades}`);
    }
  }
  timings.push({ symbol: m.symbol, seconds: (Date.now() - t0) / 1000, bars: minute.length, from, to });
}
const wallSeconds = (Date.now() - started) / 1000;

// ---- the vault document ----------------------------------------------------------------------------
function markdown(): string {
  const ranAt = new Date().toISOString();
  const families = [...new Set(candidates.map((c) => c.family))];
  const out: string[] = [];
  out.push(`# Futures research — the prompt's strategy families and the Donchian reproduction (E10)`);
  out.push(``);
  out.push(`Run ${ranAt} · set \`${SET}\` · data \`${DATA_DIR}\` (Databento GLBX.MDP3 continuous v.0, 1-minute, 2011→2026) · gate \`validateCandidate\` unchanged · ledger ${hypothesesTested} hypotheses · wall ${wallSeconds.toFixed(0)} s`);
  out.push(``);
  out.push(`**How to read this.** Every row carries n, the mean R with its 95% CI, and t. A verdict word appears ONLY where |t| ≥ 2 on the full sample; the \`gate\` column is \`validateCandidate\`'s status (\`reject\` / \`research\`) with the reasons it gave. \`research\` is not a promotion: a survivor is "candidate for its own Pine + EDGES PR after Fable review" and nothing more. Slippage per side is the desk's own journal model (\`SLIP_PTS_PER_SIDE\`): ${MARKETS.map((m) => `${m.symbol} ${m.entrySlippagePoints} (${m.slippageSource})`).join(" · ")}; commission $${COMMISSION_ROUND_TURN} round turn. Entries at the next bar's open, one position at a time, ambiguous bars resolve to the stop, roll-crossing entries skipped, roll-interrupted trades fail the gate.`);
  out.push(``);
  if (skipped.length) out.push(`**Skipped markets:** ${skipped.join(", ")}.`), out.push(``);
  out.push(`## Pre-registration (research/edge-factory-trials.json)`);
  out.push(``);
  out.push(`| family | registered | bars | candidates | expectation stated before the run |`);
  out.push(`|---|---|---|---|---|`);
  for (const f of families) {
    const r = registrations.get(f);
    out.push(`| \`${f}\` | ${r?.registeredAt ?? "—"} | ${r?.barMinutes ?? candidates.find((c) => c.family === f)?.barMinutes}m | ${r?.candidates.map((k) => `\`${k}\``).join(", ") ?? "—"} | ${r?.expectation ?? "—"} |`);
  }
  out.push(``);
  out.push(`## Results by family × market (full sample)`);
  out.push(``);
  for (const f of families) {
    const r = registrations.get(f);
    out.push(`### \`${f}\``);
    out.push(``);
    if (r) out.push(`${r.hypothesis}`), out.push(``);
    out.push(`| candidate | market | n | net $ | mean R | 95% CI | t | PF | maxDD R | verdict | gate | reasons |`);
    out.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const row of rows.filter((x) => x.candidate.family === f)) {
      const s = row.full;
      out.push(`| \`${row.candidate.key}\` | ${row.market.symbol} | ${s.trades} | ${s.netPnl >= 0 ? "+" : "−"}$${Math.abs(s.netPnl).toFixed(0)} | ${sign(s.expectancyR)} | [${sign(s.expectancyCi95[0])}, ${sign(s.expectancyCi95[1])}] | ${s.tStat.toFixed(2)} | ${pf(s)} | ${s.maxDrawdownR.toFixed(0)} | ${verdictWord(s)} | ${row.verdict.status} | ${row.verdict.reasons.join("; ") || "passed"} |`);
    }
    // Pooled across markets: one trade series per candidate, in time order (R is comparable across markets).
    out.push(``);
    out.push(`| candidate (pooled, all markets run) | n | mean R | 95% CI | t | PF | verdict |`);
    out.push(`|---|---|---|---|---|---|---|`);
    for (const c of candidates.filter((x) => x.family === f)) {
      const pooled = edgeStatistics(rows.filter((x) => x.candidate.key === c.key).flatMap((x) => x.trades).sort((a, b) => a.entryTime - b.entryTime));
      out.push(`| \`${c.key}\` | ${pooled.trades} | ${sign(pooled.expectancyR)} | [${sign(pooled.expectancyCi95[0])}, ${sign(pooled.expectancyCi95[1])}] | ${pooled.tStat.toFixed(2)} | ${pf(pooled)} | ${verdictWord(pooled)} |`);
    }
    out.push(``);
  }
  out.push(`## Gate outcomes`);
  out.push(``);
  const survivors = rows.filter((r) => r.verdict.status === "research");
  out.push(survivors.length
    ? survivors.map((r) => `- \`${r.candidate.key}\` on ${r.market.symbol}: passed the historical gate — candidate for its own Pine + EDGES PR after Fable review. Nothing else follows from this document.`).join("\n")
    : `- No candidate passed \`validateCandidate\` on any market run. Nothing is promoted, no Pine is written, no EDGES entry is added.`);
  out.push(``);
  out.push(`## Execution diagnostics`);
  out.push(``);
  out.push(`| candidate | market | signals | trades | unpriceable entries | invalid | roll-crossing | roll-interrupted |`);
  out.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of rows) out.push(`| \`${r.candidate.key}\` | ${r.market.symbol} | ${r.diagnostics.signals} | ${r.trades.length} | ${r.diagnostics.unpriceableEntries} | ${r.diagnostics.invalidSignals} | ${r.diagnostics.rollCrossingEntries} | ${r.diagnostics.rollInterruptedTrades} |`);
  out.push(``);
  out.push(`## Timing`);
  out.push(``);
  out.push(`| market | one-minute bars | span | seconds |`);
  out.push(`|---|---|---|---|`);
  for (const t of timings) out.push(`| ${t.symbol} | ${t.bars.toLocaleString()} | ${t.from} → ${t.to} | ${t.seconds.toFixed(0)} |`);
  out.push(``);
  const donchian = fs.existsSync(path.resolve(DONCHIAN_RECORD)) ? fs.readFileSync(path.resolve(DONCHIAN_RECORD), "utf8") : null;
  out.push(`## Donchian 100/50 60m — the desk's second edge, reproduced on main`);
  out.push(``);
  if (donchian) {
    out.push(`\`scripts/trend-portfolio.ts\` ported verbatim from \`codex/trading-safety-parity\`; the record below is \`${DONCHIAN_RECORD}\` (n, mean R, PF, t and both halves for every market). Its cost model is 0.05 ATR per round turn with no separate slippage — the families above are charged the desk's per-side slippage instead, so the two are not on the same footing and are not compared here.`);
    out.push(``);
    out.push("```");
    out.push(donchian.trim());
    out.push("```");
  } else {
    out.push(`The record \`${DONCHIAN_RECORD}\` is missing — the reproduction has not been run in this checkout.`);
  }
  out.push(``);
  out.push(`Research only — continuous-contract history, no margin model, no real fills. This document writes no flags and cannot arm demo or promote live.`);
  out.push(``);
  return out.join("\n");
}

const doc = markdown();
if (!process.env.NO_VAULT) {
  const target = path.join(VAULT_DIR, VAULT_DOC);
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, doc); console.log(`\nvault: wrote ${target}`); }
  catch (e) { console.log(`\nvault: could not write ${target} — ${String(e).slice(0, 120)}`); }
}
console.log(`\nwall ${wallSeconds.toFixed(0)} s · markets ${markets.map((m) => m.symbol).join(",") || "none"}${skipped.length ? ` · skipped ${skipped.join(",")}` : ""}`);
console.log("Safety: EVAL is a reusable research slice, not a locked holdout. This command writes no flags and cannot arm demo or promote live. Real fills and the promotion protocol remain mandatory.\n");
