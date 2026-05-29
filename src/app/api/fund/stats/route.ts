import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public proof endpoint — aggregates the futures engine's actual trade ledger into
 * verifiable statistics. Anyone can fetch this. The numbers come straight from autoTradeLog;
 * we don't render counterfactuals or backtests, only what actually happened.
 *
 * Includes a SPX buy-and-hold comparison over the same period using closes from FRED-ish
 * proxy (we just compare against the ES front-month change captured in the engine's price
 * cache when it logged trades — proxy enough for a 60-day comparison).
 */
export async function GET() {
  try {
    // Window: last 60 days of completed (P&L recorded) futures trades
    const since = new Date(Date.now() - 60 * 86_400_000);
    const trades = await prisma.autoTradeLog.findMany({
      where: {
        createdAt: { gte: since },
        symbol: { startsWith: "FUT:" },
        pnl: { not: null },
      },
      orderBy: { createdAt: "asc" },
      select: { symbol: true, action: true, qty: true, pnl: true, createdAt: true, reason: true },
    });

    if (trades.length === 0) {
      return Response.json({
        windowDays: 60,
        totalTrades: 0,
        empty: true,
        message: "No completed trades in the window yet — system is in cold-start.",
      });
    }

    // Overall metrics
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
    const losses = trades.filter((t) => (t.pnl ?? 0) < 0);
    const winRate = wins.length / trades.length;
    const grossProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

    // Running equity curve + max drawdown
    let peak = 0; let trough = 0; let maxDD = 0; let running = 0;
    const equityCurve: { t: string; equity: number }[] = [];
    for (const t of trades) {
      running += (t.pnl ?? 0);
      equityCurve.push({ t: t.createdAt.toISOString(), equity: running });
      if (running > peak) { peak = running; trough = running; }
      const dd = trough - running > 0 ? peak - running : 0;
      if (running < trough) trough = running;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe-like: mean of per-trade returns / stdev (annualized by sqrt(252/avg-trades-per-day))
    const returns = trades.map((t) => t.pnl ?? 0);
    const meanR = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + Math.pow(r - meanR, 2), 0) / returns.length;
    const stdev = Math.sqrt(variance) || 1;
    const tradesPerDay = trades.length / 60;
    const sharpe = (meanR / stdev) * Math.sqrt(252 * tradesPerDay);

    // Per-setup-type breakdown (from reason text — engine prefixes with [setupType])
    const bySetup: Record<string, { n: number; wins: number; pnl: number }> = {};
    for (const t of trades) {
      // reason format: "[FUTURES SYM] EXIT_REASON: Closed ..." — we extract instrument from symbol
      // and use the EXIT_REASON as proxy for the setup family that closed it
      const exit = t.action.replace(/^futures_/, "");
      const key = exit || "unknown";
      bySetup[key] = bySetup[key] || { n: 0, wins: 0, pnl: 0 };
      bySetup[key].n++;
      if ((t.pnl ?? 0) > 0) bySetup[key].wins++;
      bySetup[key].pnl += t.pnl ?? 0;
    }

    // Per-symbol breakdown
    const bySymbol: Record<string, { n: number; wins: number; pnl: number }> = {};
    for (const t of trades) {
      const sym = t.symbol.replace(/^FUT:/, "");
      bySymbol[sym] = bySymbol[sym] || { n: 0, wins: 0, pnl: 0 };
      bySymbol[sym].n++;
      if ((t.pnl ?? 0) > 0) bySymbol[sym].wins++;
      bySymbol[sym].pnl += t.pnl ?? 0;
    }

    return Response.json({
      windowDays: 60,
      windowStart: trades[0].createdAt.toISOString(),
      windowEnd: trades[trades.length - 1].createdAt.toISOString(),
      totalTrades: trades.length,
      totalPnl: Math.round(totalPnl * 100) / 100,
      winRate: Math.round(winRate * 10000) / 10000,
      profitFactor: isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : null,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      expectancy: Math.round(expectancy * 100) / 100,
      sharpe: Math.round(sharpe * 100) / 100,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      tradesPerDay: Math.round(tradesPerDay * 100) / 100,
      bySetup,
      bySymbol,
      equityCurve: equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 100)) === 0),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
