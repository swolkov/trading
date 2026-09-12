import { prisma } from "@/lib/db";
import { readAccountSnapshot, readLiveSnapshot } from "@/lib/options-quote-store";
import { OPTIONS_RESEARCH_KEY, isOptionsResearch } from "@/lib/options-desk-model";
import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "@/lib/options-operation";
import { buildOptionsObservation, optionsRiskView, optionsPerformanceCoverage, summarizeOptionsHistory } from "@/lib/options-evidence-model";
import { readOptionsObservationHistory } from "@/lib/options-evidence-store";

export const dynamic = "force-dynamic";
export async function GET() {
  const [rows, account, live, history] = await Promise.all([
    prisma.agentConfig.findMany({ where: { key: { in: [OPTIONS_RESEARCH_KEY, OPTIONS_MAX_LOSS_KEY] } } }),
    readAccountSnapshot(), readLiveSnapshot(),
    readOptionsObservationHistory().catch(() => ({ observations: [], available: false, invalidRecords: 0, windowLimit: 120 })),
  ]);
  const config = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const cap = parseOptionsMaxLoss(config[OPTIONS_MAX_LOSS_KEY]);
  let current = null;
  try {
    const research = JSON.parse(config[OPTIONS_RESEARCH_KEY] ?? "null");
    if (isOptionsResearch(research)) current = buildOptionsObservation(research, cap, account);
  } catch { /* Invalid research remains explicitly unavailable. */ }
  return Response.json({
    current: current ? { ...current, quotes: undefined } : null,
    risk: optionsRiskView(account, cap), performance: optionsPerformanceCoverage(live),
    history: { ...summarizeOptionsHistory(history.observations), available: history.available,
      invalidRecords: history.invalidRecords, windowLimit: history.windowLimit },
  });
}
