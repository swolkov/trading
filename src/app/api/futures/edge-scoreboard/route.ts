import { prisma } from "@/lib/db";

// TWO-EDGE LIVE SCOREBOARD for the $5k forward test. Splits every live futures close into the two edges
// we're actually testing and shows REAL $ P&L (from AutoTradeLog, pnl reconciled from fills) so the test
// proves or disproves itself in front of us — no guessing.
//   • Gold RSI-bounce (MGC)        — positive in BOTH backtest periods; the consistent edge.
//   • Index overbought-short (MNQ/MES) — strong in 2026 OOS, lost in 2025; the promising-but-unproven lead.
// Each close is double-logged (a live_* and a futures_* row, identical ts+pnl) → deduped.

const EDGES = [
  { name: "Gold RSI-bounce", symbols: ["FUT:MGC"], blurb: "Gold micro, oversold-bounce / overbought-fade. Positive in both backtest periods — the consistent edge." },
  { name: "Index overbought-short", symbols: ["FUT:MNQ", "FUT:MES"], blurb: "Short Nasdaq/S&P micros at RSI≥80. Strong in 2026, lost in 2025 — the unproven lead we're testing." },
] as const;

export async function GET() {
  try {
    const sinceRow = await prisma.agentConfig.findUnique({ where: { key: "edge_scoreboard_since" } });
    const sinceTs = sinceRow?.value ? new Date(sinceRow.value) : new Date(0);

    const rawCloses = await prisma.autoTradeLog.findMany({
      where: { symbol: { in: ["FUT:MGC", "FUT:MNQ", "FUT:MES"] }, pnl: { not: null }, createdAt: { gte: sinceTs } },
      orderBy: { createdAt: "desc" },
      take: 400,
    });
    // Dedupe the SAME close logged twice: the engine writes a live_* row and the fill reconciler
    // writes a futures_*/shadow_* row for the same fill, seconds-to-minutes apart. The key guard is
    // that a true duplicate comes from a DIFFERENT logging source — two real back-to-back stop-outs
    // share the same source (both live_*) and must NEVER be merged (at 1 micro their P&L can be within
    // $1 of each other). So: same symbol + P&L within $1 + within 5 min + different source = one trade.
    const src = (a: string) => (a.startsWith("live_") ? "live" : a.startsWith("shadow_") ? "shadow" : "futures");
    const kept: typeof rawCloses = [];
    const closes = rawCloses.filter((c) => {
      const dup = kept.some((k) =>
        k.symbol === c.symbol &&
        src(k.action) !== src(c.action) &&
        Math.abs((k.pnl ?? 0) - (c.pnl ?? 0)) <= 1 &&
        Math.abs(k.createdAt.getTime() - c.createdAt.getTime()) < 5 * 60 * 1000
      );
      if (dup) return false;
      kept.push(c);
      return true;
    });

    const edges = EDGES.map((e) => {
      const t = closes.filter((c) => (e.symbols as readonly string[]).includes(c.symbol));
      const net = t.reduce((s, c) => s + (c.pnl ?? 0), 0);
      const wins = t.filter((c) => (c.pnl ?? 0) > 0).length;
      const losses = t.filter((c) => (c.pnl ?? 0) < 0).length;
      return {
        name: e.name,
        blurb: e.blurb,
        net,
        trades: t.length,
        wins,
        losses,
        winRate: t.length ? wins / t.length : 0,
        recent: t.slice(0, 8).map((c) => ({
          ts: c.createdAt,
          sym: c.symbol.replace("FUT:", ""),
          exit: c.action.replace(/^(live_|futures_)/, ""),
          pnl: c.pnl,
        })),
      };
    });

    return Response.json({
      since: sinceTs.toISOString(),
      totalNet: edges.reduce((s, e) => s + e.net, 0),
      totalTrades: edges.reduce((s, e) => s + e.trades, 0),
      edges,
    });
  } catch (error) {
    console.error("[/api/futures/edge-scoreboard]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
