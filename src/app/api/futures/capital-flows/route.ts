import { getViewMode } from "@/lib/trading-mode";
import { getCapitalFlows, reconcileCapitalFlows, recordManualFlow, netFlowsAfterInception } from "@/lib/capital-flows";
import { prisma } from "@/lib/db";

async function getInception(): Promise<string> {
  const row = await prisma.agentConfig.findUnique({ where: { key: "strategy_inception" } });
  return row?.value || "2026-07-10";
}

// GET /api/futures/capital-flows[?debug=1&force=1]
// Returns the capital-flow ledger for the current view mode + the net post-inception flow.
// debug=1 also returns the raw Tradovate cash-log rows + freshly computed flows, so the
// auto-detector can be validated against a known deposit (e.g. the Jul 11 $4k).
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const debug = searchParams.get("debug") === "1";
    const force = searchParams.get("force") === "1";
    const mode = searchParams.get("mode") === "demo" ? "paper" : searchParams.get("mode") === "live" ? "live" : await getViewMode("futures");

    const result = await reconcileCapitalFlows(mode, { debug, force });
    const inception = await getInception();
    const flows = result.flows.length ? result.flows : await getCapitalFlows(mode);

    return Response.json({
      mode,
      inception,
      flows,
      netDepositsSinceInception: netFlowsAfterInception(flows, inception),
      reconciled: result.ran,
      ...(result.error ? { detectorError: result.error } : {}),
      ...(debug ? { detected: result.detected, rawCashLogs: result.logs } : {}),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

// POST /api/futures/capital-flows  { date: "YYYY-MM-DD", amount: number, note?, mode? }
// Manual override / backstop. amount>0 deposit, <0 withdrawal, 0 removes the manual flow for that date.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const mode = body.mode === "demo" ? "paper" : body.mode === "live" ? "live" : await getViewMode("futures");
    const date: string = body.date;
    const amount = Number(body.amount);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    if (!Number.isFinite(amount)) return Response.json({ error: "amount must be a number" }, { status: 400 });

    const flows = await recordManualFlow(mode, date, amount, body.note);
    const inception = await getInception();
    return Response.json({ ok: true, mode, flows, netDepositsSinceInception: netFlowsAfterInception(flows, inception) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
