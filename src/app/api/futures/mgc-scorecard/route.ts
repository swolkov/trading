import { prisma } from "@/lib/db";

// MGC Grader-Off Scorecard — the honest "regrade gold from scratch" view.
// Real $ P&L of every LIVE gold (MGC) trade since the AI veto was turned off, plus a
// by-setup-type breakdown (win rate + net R) so we can see which setups actually earn
// their place. The one OOS-validated edge (extreme_rsi_bounce, backtest PF ~1.24) is flagged.
//
// Live gold = MGC, demo gold = GC — a clean mode discriminator, so no mode column needed.
const VALIDATED_EDGE = "extreme_rsi_bounce";

export async function GET() {
  try {
    const sinceRow = await prisma.agentConfig.findUnique({ where: { key: "mgc_scorecard_since" } });
    const sinceTs = sinceRow?.value ? new Date(sinceRow.value) : new Date(0);

    // ── Real $ P&L: LIVE gold closes since grader-off (AutoTradeLog, pnl reconciled from fills) ──
    // Each close is double-logged (a live_* and a futures_* row with identical ts+pnl); dedup them.
    const rawCloses = await prisma.autoTradeLog.findMany({
      where: { symbol: "FUT:MGC", pnl: { not: null }, createdAt: { gte: sinceTs } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const seen = new Set<string>();
    const closes = rawCloses.filter((c) => {
      const key = `${new Date(c.createdAt).toISOString().slice(0, 19)}|${(c.pnl ?? 0).toFixed(2)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const realDollars = closes.reduce((s, c) => s + (c.pnl ?? 0), 0);
    const wins = closes.filter((c) => (c.pnl ?? 0) > 0).length;
    const losses = closes.filter((c) => (c.pnl ?? 0) < 0).length;

    // ── By setup type: pattern_memory filtered to MGC (live gold) — WR + net R per setup ──
    let bySetup: Array<{ setupType: string; n: number; wins: number; winRate: number; netR: number; avgR: number; validated: boolean }> = [];
    try {
      const raw = (await prisma.agentConfig.findUnique({ where: { key: "pattern_memory" } }))?.value;
      const pats: Array<{ instrument: string; setupType: string; outcome?: string; pnlR?: number }> = raw ? JSON.parse(raw) : [];
      const mgc = pats.filter((p) => p.instrument === "MGC");
      const groups: Record<string, { n: number; wins: number; r: number }> = {};
      for (const p of mgc) {
        const k = p.setupType || "unknown";
        (groups[k] ??= { n: 0, wins: 0, r: 0 });
        groups[k].n++;
        if (p.outcome === "win") groups[k].wins++;
        groups[k].r += p.pnlR ?? 0;
      }
      bySetup = Object.entries(groups)
        .map(([setupType, v]) => ({
          setupType,
          n: v.n,
          wins: v.wins,
          winRate: v.n > 0 ? v.wins / v.n : 0,
          netR: v.r,
          avgR: v.n > 0 ? v.r / v.n : 0,
          validated: setupType === VALIDATED_EDGE,
        }))
        .sort((a, b) => b.netR - a.netR);
    } catch { /* pattern memory optional */ }

    return Response.json({
      since: sinceTs.toISOString(),
      graderOff: true,
      realDollars,
      trades: closes.length,
      wins,
      losses,
      recent: closes.slice(0, 10).map((c) => ({
        ts: c.createdAt,
        exit: c.action.replace(/^(live_|futures_)/, ""),
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
