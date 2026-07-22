import { prisma } from "@/lib/db";
import { getLiveFuturesStats } from "@/lib/live-pnl";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public proof endpoint — honest, LIVE-ONLY performance of the real-money futures engine.
 *
 * ALL headline numbers (net P&L, current balance, starting capital, win rate, trade count, best/worst)
 * come from the ONE authoritative source, getLiveFuturesStats() — broker balance delta for dollars,
 * clean incident-excluded paired round-trips for every trade stat. This route no longer re-derives
 * P&L from raw EOD-balance keys or sums autoTradeLog.pnl (both drift from the account and commingle
 * warmup/incident rows). It only ADDS the balance-history equity CURVE + per-instrument COUNTS + the
 * honest sample note on top of that authoritative object, so /proof always agrees with the Track
 * Record header and the Futures panel.
 */

export async function GET() {
  try {
    const stats = await getLiveFuturesStats();

    // Balance-history equity curve (visual only) — inception-forward broker EOD balances.
    const incRow = await prisma.agentConfig.findUnique({ where: { key: "strategy_inception" } }).catch(() => null);
    const inception = incRow?.value || "2026-07-10";
    const balRows = await prisma.agentConfig.findMany({ where: { key: { startsWith: "live_eod_balance_" } } });
    const balanceSeries = balRows
      .map((r) => ({ date: r.key.slice("live_eod_balance_".length), balance: parseFloat(r.value) }))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && isFinite(x.balance) && x.date >= inception.slice(0, 10))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (stats.roundTrips === 0 && balanceSeries.length === 0) {
      return Response.json({
        empty: true,
        account: "live",
        startCapital: Math.round(stats.startingCapital),
        message: "No live results recorded yet — the live engine is in cold-start.",
        generatedAt: new Date().toISOString(),
      });
    }

    const equityCurve: { date: string; equity: number }[] =
      balanceSeries.map((b) => ({ date: b.date, equity: Math.round(b.balance * 100) / 100 }));
    // Max drawdown from the inception-forward balance curve (peak-to-trough on real broker equity).
    let peak = balanceSeries[0]?.balance ?? stats.startingCapital;
    let maxDD = 0;
    for (const b of balanceSeries) {
      if (b.balance > peak) peak = b.balance;
      const dd = peak - b.balance;
      if (dd > maxDD) maxDD = dd;
    }
    const movesUp = balanceSeries.filter((b, i) => i > 0 && b.balance - balanceSeries[i - 1].balance > 0.01).length;
    const movesDown = balanceSeries.filter((b, i) => i > 0 && b.balance - balanceSeries[i - 1].balance < -0.01).length;
    const activeDays = movesUp + movesDown;

    // Per-instrument COUNTS only (no dollar P&L — trade-log dollars are unreliable), LIVE engine only.
    const liveCloses = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "FUT:" }, action: { startsWith: "live_" }, pnl: { not: null } },
      select: { symbol: true, pnl: true },
    });
    const bySymbol: Record<string, { trades: number; wins: number }> = {};
    for (const t of liveCloses) {
      const sym = t.symbol.replace(/^FUT:/, "");
      bySymbol[sym] = bySymbol[sym] || { trades: 0, wins: 0 };
      bySymbol[sym].trades++;
      if ((t.pnl ?? 0) > 0) bySymbol[sym].wins++;
    }

    const windowStart = balanceSeries[0]?.date ?? inception.slice(0, 10);
    const windowEnd = balanceSeries[balanceSeries.length - 1]?.date ?? new Date().toISOString().slice(0, 10);
    const sampleNote =
      `LIVE account only (real money). P&L is the clean broker balance delta; every trade stat is from ` +
      `paired round-trips with the Jul 16-17 incident window excluded. Sample is small — ` +
      `${stats.roundTrips} trades (${windowStart} → ${windowEnd}). ` +
      `This is far too short to establish a statistical edge; treat as an early forward-test, not proof.`;

    return Response.json({
      account: "live",
      ok: stats.ok,
      startCapital: Math.round(stats.startingCapital * 100) / 100,
      pnlSource: "broker-balance-delta",
      // Authoritative dollar figures (broker balance delta). null when broker unreachable → page shows "—".
      netPnl: stats.ok ? Math.round(stats.netPnl * 100) / 100 : null,
      returnPct: stats.ok && stats.startingCapital > 0 ? Math.round((stats.netPnl / stats.startingCapital) * 10000) / 10000 : null,
      latestBalance: stats.ok ? Math.round(stats.currentBalance * 100) / 100 : null,
      firstBalance: Math.round(stats.startingCapital * 100) / 100,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      // Authoritative trade stats (clean incident-excluded round-trips).
      totalTrades: stats.roundTrips,
      winCount: stats.wins,
      lossCount: stats.losses,
      winRate: stats.roundTrips > 0 ? Math.round(stats.winRate * 10000) / 10000 : null,
      best: stats.best,
      worst: stats.worst,
      realizedSum: Math.round(stats.realizedSum * 100) / 100,
      // Balance-history extras (visual + concentration read).
      activeDays,
      daysUp: movesUp,
      daysDown: movesDown,
      bySymbol,
      equityCurve: equityCurve.filter(
        (_, i) => i % Math.max(1, Math.floor(equityCurve.length / 100)) === 0 || i === equityCurve.length - 1,
      ),
      windowStart,
      windowEnd,
      sampleNote,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
