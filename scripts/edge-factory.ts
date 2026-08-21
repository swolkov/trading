import fs from "node:fs";
import path from "node:path";
import { FIVE_MINUTE_CANDIDATES, HOURLY_CANDIDATES } from "../src/lib/edge-factory/candidates";
import { aggregateBars, loadDatabentoCsv } from "../src/lib/edge-factory/data";
import { replayCandidateDetailed } from "../src/lib/edge-factory/replay";
import { validateCandidate } from "../src/lib/edge-factory/validation";
import type { MarketSpec } from "../src/lib/edge-factory/types";

const MARKETS: MarketSpec[] = [
  { symbol: "ES", tradedSymbol: "MES", pointValue: 5, tickSize: 0.25, commissionRoundTurn: 2.02, entrySlippagePoints: 0.89, exitSlippagePoints: 0.25 },
  { symbol: "NQ", tradedSymbol: "MNQ", pointValue: 2, tickSize: 0.25, commissionRoundTurn: 2.02, entrySlippagePoints: 11.74, exitSlippagePoints: 0.25 },
  { symbol: "GC", tradedSymbol: "MGC", pointValue: 10, tickSize: 0.1, commissionRoundTurn: 2.02, entrySlippagePoints: 0.50, exitSlippagePoints: 0.1 },
];

const selected = process.argv.slice(2).map((value) => value.toUpperCase());
const markets = selected.length ? MARKETS.filter((market) => selected.includes(market.symbol)) : MARKETS;
const trialLedgerPath = path.resolve("research/edge-factory-trials.json");
const trialLedger = JSON.parse(fs.readFileSync(trialLedgerPath, "utf8")) as { formatVersion: number; hypotheses: string[] };
const declaredHypotheses = MARKETS.flatMap((market) => [
  ...FIVE_MINUTE_CANDIDATES.map((candidate) => `${market.symbol}|5m|${candidate.key}|${candidate.version}`),
  ...HOURLY_CANDIDATES.map((candidate) => `${market.symbol}|1h|${candidate.key}|${candidate.version}`),
]);
trialLedger.hypotheses = [...new Set([...trialLedger.hypotheses, ...declaredHypotheses])].sort();
fs.writeFileSync(trialLedgerPath, `${JSON.stringify(trialLedger, null, 2)}\n`);
const hypothesesTested = trialLedger.hypotheses.length;
const compact = (s: ReturnType<typeof validateCandidate>["development"]) =>
  `n=${s.trades} net=${s.netPnl >= 0 ? "+" : ""}$${s.netPnl.toFixed(0)} PF=${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "INF"} exp=${s.expectancyR >= 0 ? "+" : ""}${s.expectancyR.toFixed(3)}R t=${s.tStat.toFixed(2)} DD=${s.maxDrawdownR.toFixed(1)}R`;

for (const market of markets) {
  const file = market.symbol === "GC" ? "data/gold3y/GC_1m.csv" : `data/${market.symbol}_1m.csv`;
  const minute = loadDatabentoCsv(path.resolve(file));
  const five = aggregateBars(minute, 5);
  const hourly = aggregateBars(minute, 60);
  console.log(`\n${market.tradedSymbol} edge factory | ${minute.length.toLocaleString()} one-minute bars | ${new Date(minute[0].t).toISOString().slice(0, 10)} to ${new Date(minute.at(-1)!.t).toISOString().slice(0, 10)}`);
  console.log(`multiple-testing ledger: ${hypothesesTested} unique market/timeframe/parameter hypotheses`);
  for (const [bars, candidates] of [[five, FIVE_MINUTE_CANDIDATES], [hourly, HOURLY_CANDIDATES]] as const) {
    for (const candidate of candidates) {
      const replay = replayCandidateDetailed(bars, candidate, market);
      const verdict = validateCandidate(replay.trades, hypothesesTested, { diagnostics: replay.diagnostics });
      console.log(`${verdict.status.padEnd(14)} ${candidate.key.padEnd(34)} DEV ${compact(verdict.development)} | EVAL ${compact(verdict.evaluation)} | p*=${verdict.adjustedPValue.toFixed(4)}`);
      console.log(`  ${verdict.reasons.join("; ") || "historical research gate passed; real-fill evidence is still required"}`);
      if (replay.diagnostics.unpriceableEntries || replay.diagnostics.invalidSignals || replay.diagnostics.rollInterruptedTrades) {
        console.log(`  execution diagnostics: unpriceable=${replay.diagnostics.unpriceableEntries} invalid=${replay.diagnostics.invalidSignals} roll-interrupted=${replay.diagnostics.rollInterruptedTrades}`);
      }
      if (verdict.status === "research") {
        console.log(`  folds: ${verdict.folds.map((fold, index) => `${index + 1}:${fold.expectancyR >= 0 ? "+" : ""}${fold.expectancyR.toFixed(3)}R`).join(" ")}`);
      }
    }
  }
}

console.log("\nSafety: EVAL is a reusable research slice, not a locked holdout. This command writes no flags and cannot arm demo or promote live. Real fills and the promotion protocol remain mandatory.\n");
