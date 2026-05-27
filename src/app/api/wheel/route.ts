import { prisma } from "@/lib/db";

// Read-only view of the wheel forward paper tracker (state + ledger banked by /api/cron/wheel-track).
// Pure DB read — no Alpaca calls, no advancing the book.
export async function GET() {
  try {
    const [stateRow, ledgerRow, lastRunRow] = await Promise.all([
      prisma.agentConfig.findUnique({ where: { key: "wheel_account_state" } }),
      prisma.agentConfig.findUnique({ where: { key: "wheel_ledger" } }),
      prisma.agentConfig.findUnique({ where: { key: "wheel_cron_last_run" } }),
    ]);
    const state = stateRow?.value ? JSON.parse(stateRow.value) : null;
    const ledger = ledgerRow?.value ? JSON.parse(ledgerRow.value) : [];
    return Response.json({ state, ledger, lastRun: lastRunRow?.value || state?.lastRun || null });
  } catch (error) {
    console.error("[/api/wheel]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
