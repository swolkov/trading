import { getShadowScoreboard } from "@/lib/shadow-tracker";
import { prisma } from "@/lib/db";

// AI-Veto Shadow Scoreboard — the counterfactual P&L of setups the engine BLOCKED.
// netR < 0 → the veto is saving money. netR > 0 → the veto is costing money.
export async function GET() {
  try {
    const [live, demo] = await Promise.all([
      getShadowScoreboard("live"),
      getShadowScoreboard("demo"),
    ]);
    // Full resolved history (not just recent) so the UI can show every blocked counterfactual with dates.
    const recent = await prisma.shadowTrade.findMany({
      where: { status: { not: "open" } },
      orderBy: { resolvedAt: "desc" },
      take: 200,
    });
    return Response.json({
      live,
      demo,
      recent: recent.map((r) => ({
        ts: r.resolvedAt,          // when it resolved
        blockedAt: r.createdAt,    // when the setup fired / was blocked
        mode: r.mode,
        symbol: r.symbol,
        direction: r.direction,
        setupType: r.setupType,
        blockReason: r.blockReason,
        status: r.status,
        rMultiple: r.rMultiple,
        dollarPnl: r.dollarPnl,
        contracts: r.contracts,
        exitReason: r.exitReason,
        reason: r.reason,
      })),
    });
  } catch (error) {
    console.error("[/api/futures/shadow-scoreboard]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
