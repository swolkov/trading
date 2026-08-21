import { prisma } from "@/lib/db";

// MGC Grader-Off Scorecard — the honest "regrade gold from scratch" view.
// Real $ P&L of every LIVE gold (MGC) trade since the AI veto was turned off, plus a
// by-setup-type breakdown (win rate + net R) so we can see which setups actually earn
// their place. The one OOS-validated edge (extreme_rsi_bounce, backtest PF ~1.24) is flagged.
//
// Both current engines use MGC; action prefixes provide the live/demo discriminator.
const VALIDATED_EDGE = "extreme_rsi_bounce";

export async function GET() {
  try {
    const sinceRow = await prisma.agentConfig.findUnique({ where: { key: "mgc_scorecard_since" } });
    const sinceTs = sinceRow?.value ? new Date(sinceRow.value) : new Date(0);

    // RoundTrip is broker-fill sourced and carries an explicit mode. AutoTradeLog cannot safely
    // distinguish current live/demo MGC by symbol because both engines trade the same micro.
    const closes = await prisma.roundTrip.findMany({
      where: { mode: "live", symbol: "MGC", exitTime: { gte: sinceTs } },
      orderBy: { exitTime: "desc" },
      take: 200,
    });
    const realDollars = closes.reduce((s, c) => s + c.pnl, 0);
    const wins = closes.filter((c) => c.pnl > 0).length;
    const losses = closes.filter((c) => c.pnl < 0).length;

    const groups: Record<string, { n: number; wins: number; r: number; withR: number }> = {};
    for (const trade of closes) {
      const key = trade.setupType || "unknown";
      (groups[key] ??= { n: 0, wins: 0, r: 0, withR: 0 });
      groups[key].n++;
      if (trade.pnl > 0) groups[key].wins++;
      if (trade.rMultiple !== null) {
        groups[key].r += trade.rMultiple;
        groups[key].withR++;
      }
    }
    const bySetup = Object.entries(groups)
      .map(([setupType, value]) => ({
        setupType,
        n: value.n,
        wins: value.wins,
        winRate: value.n > 0 ? value.wins / value.n : 0,
        netR: value.r,
        avgR: value.withR > 0 ? value.r / value.withR : 0,
        validated: setupType === VALIDATED_EDGE,
      }))
      .sort((a, b) => b.netR - a.netR);

    return Response.json({
      since: sinceTs.toISOString(),
      graderOff: true,
      realDollars,
      trades: closes.length,
      wins,
      losses,
      recent: closes.slice(0, 10).map((c) => ({
        ts: c.exitTime,
        exit: c.setupType || "round_trip",
        pnl: c.pnl,
      })),
      bySetup,
      validatedEdge: VALIDATED_EDGE,
    });
  } catch (error) {
    console.error("[/api/futures/mgc-scorecard]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
