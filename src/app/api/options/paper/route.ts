import { prisma } from "@/lib/db";
import { optionsSleeveBreakdown, recentOptionPaperTrades } from "@/lib/options-shadow";
import {
  CRYPTO_PROXY_EXCLUDED, MAX_CONCURRENT, MAX_ENTRIES_PER_MONTH, MAX_SPREAD_PCT,
  MAX_DTE, MIN_DTE, MIN_DELTA, MAX_DELTA, OPTIONS_SIM_VERSION, OPTIONS_UNIVERSE,
} from "@/lib/options-paper-model";

export const dynamic = "force-dynamic";

export async function GET() {
  const [sleeves, trades, lastRun, lastResultRaw] = await Promise.all([
    optionsSleeveBreakdown().catch(() => []),
    recentOptionPaperTrades(100).catch(() => []),
    prisma.agentConfig.findUnique({ where: { key: "options_scan_last_run" } }).then((r) => r?.value ?? null).catch(() => null),
    prisma.agentConfig.findUnique({ where: { key: "options_scan_last_result" } }).then((r) => r?.value ?? null).catch(() => null),
  ]);
  let lastResult: unknown = null;
  try { lastResult = lastResultRaw ? JSON.parse(lastResultRaw) : null; } catch { lastResult = null; }
  return Response.json({
    simVersion: OPTIONS_SIM_VERSION,
    rules: {
      maxEntriesPerMonth: MAX_ENTRIES_PER_MONTH, maxConcurrent: MAX_CONCURRENT,
      maxSpreadPct: MAX_SPREAD_PCT, minDte: MIN_DTE, maxDte: MAX_DTE,
      minDelta: MIN_DELTA, maxDelta: MAX_DELTA,
    },
    universe: OPTIONS_UNIVERSE, excluded: CRYPTO_PROXY_EXCLUDED,
    sleeves, trades, lastRun, lastResult,
  });
}
