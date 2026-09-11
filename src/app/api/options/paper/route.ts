import { prisma } from "@/lib/db";
import { barsStoreFreshness } from "@/lib/options-bars-store";
import { optionsSleeveBreakdown, optionsStructureBreakdown, recentOptionPaperTrades } from "@/lib/options-shadow";
import { pendingChainRequests, quoteStoreFreshness, readAccountSnapshot } from "@/lib/options-quote-store";
import {
  CRYPTO_PROXY_EXCLUDED, MAX_CONCURRENT, MAX_ENTRIES_PER_MONTH, MAX_SPREAD_PCT,
  MAX_DTE, MIN_DTE, MIN_DELTA, MAX_DELTA, OPTIONS_SIM_VERSION, OPTIONS_UNIVERSE, OPTIONS_SYMBOLS,
  scenarioGrid,
} from "@/lib/options-paper-model";

export const dynamic = "force-dynamic";

export async function GET() {
  const [sleeves, trades, lastRun, lastResultRaw, account, quoteStore, chainRequests, structures, barsStore] = await Promise.all([
    optionsSleeveBreakdown().catch(() => []),
    recentOptionPaperTrades(100).catch(() => []),
    prisma.agentConfig.findUnique({ where: { key: "options_scan_last_run" } }).then((r) => r?.value ?? null).catch(() => null),
    prisma.agentConfig.findUnique({ where: { key: "options_scan_last_result" } }).then((r) => r?.value ?? null).catch(() => null),
    // Robinhood cannot be read from the app, so these three describe the PUSH path: what
    // the agent last saw, how fresh the quote inbox is, and what the scanner is still
    // waiting on. Without them a stalled agent looks exactly like a quiet market.
    readAccountSnapshot().catch(() => null),
    quoteStoreFreshness().catch(() => ({ newestQuoteTs: null, rows: 0, ageMinutes: null, stale: true })),
    pendingChainRequests().catch(() => []),
    optionsStructureBreakdown().catch(() => []),
    // The daily bars are pushed too (Robinhood, not Yahoo). Stale bars mean the SIGNAL is
    // blind, which is a different failure from stale quotes and needs its own chip.
    barsStoreFreshness([...OPTIONS_SYMBOLS]).catch(() => ({ symbols: 0, newestDay: null, oldestNewestDay: null, staleSymbols: [], stale: true })),
  ]);
  let lastResult: unknown = null;
  try { lastResult = lastResultRaw ? JSON.parse(lastResultRaw) : null; } catch { lastResult = null; }
  // Payoff at expiry for everything still open — terminal values, computed from the stored
  // legs and the underlying's latest price. Open rows only: a closed position has an answer.
  const scenarios = trades
    .filter((t) => t.status === "open" && t.underlyingLast != null && t.longStrike != null)
    .map((t) => ({
      id: t.id, symbol: t.symbol, spot: t.underlyingLast as number,
      points: scenarioGrid({
        structure: t.structure, longStrike: t.longStrike as number, shortStrike: t.shortStrike,
        widthUsd: t.widthUsd, capitalAtRiskUsd: t.capitalAtRiskUsd, creditUsd: t.creditUsd,
        spot: t.underlyingLast as number,
      }),
    }));

  return Response.json({
    simVersion: OPTIONS_SIM_VERSION,
    rules: {
      maxEntriesPerMonth: MAX_ENTRIES_PER_MONTH, maxConcurrent: MAX_CONCURRENT,
      maxSpreadPct: MAX_SPREAD_PCT, minDte: MIN_DTE, maxDte: MAX_DTE,
      minDelta: MIN_DELTA, maxDelta: MAX_DELTA,
    },
    universe: OPTIONS_UNIVERSE, excluded: CRYPTO_PROXY_EXCLUDED,
    sleeves, trades, lastRun, lastResult,
    account, quoteStore, chainRequests, structures, scenarios, barsStore,
  });
}
