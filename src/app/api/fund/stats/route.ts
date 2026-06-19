import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public proof endpoint — honest, LIVE-ONLY performance of the $1K real-money futures engine.
 *
 * P&L source of truth = CLEAN BALANCE-DELTA (broker EOD balances), the same series the internal
 * scoreboard (scripts/scoreboard.ts) trusts. We read the `live_eod_balance_<YYYY-MM-DD>` agentConfig
 * keys (written by the engine each session from the actual Tradovate account equity), sort by date,
 * and take latest − first. We do NOT sum autoTradeLog.pnl for dollars — those rows are double-logged
 * and run ~3x inflated, and they commingle the $50K demo account with the $1K live account.
 *
 * autoTradeLog is used ONLY for COUNTS (number of trades, win/loss counts) filtered to the LIVE
 * engine (action prefix `live_`, which is MNQ/MES only). It is never used as a dollar figure here.
 *
 * The live sample is small (~1 month). The response carries an explicit `sampleNote` so the page
 * cannot imply statistical significance.
 */

const LIVE_START_CAPITAL = 1000;

export async function GET() {
  try {
    // ---- 1. Clean P&L from the LIVE balance-delta series ----
    const balRows = await prisma.agentConfig.findMany({
      where: { key: { startsWith: "live_eod_balance_" } },
    });
    const balanceSeries = balRows
      .map((r) => ({ date: r.key.slice("live_eod_balance_".length), balance: parseFloat(r.value) }))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && isFinite(x.balance))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (balanceSeries.length === 0) {
      return Response.json({
        empty: true,
        account: "live",
        startCapital: LIVE_START_CAPITAL,
        message: "No live end-of-day balances recorded yet — the $1K live engine is in cold-start.",
        generatedAt: new Date().toISOString(),
      });
    }

    // Anchor to the ACTUAL first recorded broker balance (the funded starting capital — the live
    // account was funded with ~$1,025, not a round $1,000). Anchoring to a hardcoded $1,000 would
    // count $25 of deposited capital as "profit" and overstate the return on a public page.
    const firstBalance = balanceSeries[0].balance;
    const latestBalance = balanceSeries[balanceSeries.length - 1].balance;
    const netPnl = latestBalance - firstBalance;
    const returnPct = netPnl / firstBalance;

    // Clean equity curve straight from broker balances (already starts at the funded balance).
    const equityCurve: { date: string; equity: number }[] =
      balanceSeries.map((b) => ({ date: b.date, equity: Math.round(b.balance * 100) / 100 }));

    // Per-day deltas → max drawdown + days-with-a-move (honest concentration read).
    let peak = firstBalance;
    let maxDD = 0;
    for (const pt of equityCurve) {
      if (pt.equity > peak) peak = pt.equity;
      const dd = peak - pt.equity;
      if (dd > maxDD) maxDD = dd;
    }
    const movesUp = balanceSeries.filter((b, i) => i > 0 && b.balance - balanceSeries[i - 1].balance > 0.01).length;
    const movesDown = balanceSeries.filter((b, i) => i > 0 && b.balance - balanceSeries[i - 1].balance < -0.01).length;

    // ---- 2. Trade COUNTS from autoTradeLog (LIVE engine only) — never dollars ----
    // Live trades are tagged with action prefix `live_` (demo uses `futures_`). This is the engine's
    // own mode marker and is MNQ/MES-only by construction.
    const liveCloses = await prisma.autoTradeLog.findMany({
      where: {
        symbol: { startsWith: "FUT:" },
        action: { startsWith: "live_" },
        pnl: { not: null },
      },
      orderBy: { createdAt: "asc" },
      select: { symbol: true, pnl: true, createdAt: true },
    });
    const totalTrades = liveCloses.length;
    const winCount = liveCloses.filter((t) => (t.pnl ?? 0) > 0).length;
    const lossCount = liveCloses.filter((t) => (t.pnl ?? 0) < 0).length;
    const winRate = totalTrades > 0 ? winCount / totalTrades : null;

    // Per-instrument COUNTS only (no dollar P&L — trade-log dollars are unreliable).
    const bySymbol: Record<string, { trades: number; wins: number }> = {};
    for (const t of liveCloses) {
      const sym = t.symbol.replace(/^FUT:/, "");
      bySymbol[sym] = bySymbol[sym] || { trades: 0, wins: 0 };
      bySymbol[sym].trades++;
      if ((t.pnl ?? 0) > 0) bySymbol[sym].wins++;
    }

    // ---- 3. Honest sample note ----
    const tradingDays = movesUp + movesDown;
    const sampleNote =
      `LIVE account only ($1K real money). P&L is clean broker balance-delta. ` +
      `Sample is small — ${totalTrades} trades across ${tradingDays} active days ` +
      `(${balanceSeries[0].date} → ${balanceSeries[balanceSeries.length - 1].date}). ` +
      `This is far too short to establish a statistical edge; treat as an early forward-test, not proof.`;

    return Response.json({
      account: "live",
      startCapital: Math.round(firstBalance * 100) / 100,
      pnlSource: "broker-balance-delta",
      // Clean dollar figures
      netPnl: Math.round(netPnl * 100) / 100,
      returnPct: Math.round(returnPct * 10000) / 10000,
      latestBalance: Math.round(latestBalance * 100) / 100,
      firstBalance: Math.round(firstBalance * 100) / 100,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      // Counts (not dollars)
      totalTrades,
      winCount,
      lossCount,
      winRate: winRate === null ? null : Math.round(winRate * 10000) / 10000,
      activeDays: tradingDays,
      daysUp: movesUp,
      daysDown: movesDown,
      bySymbol,
      // Clean equity curve (balance-based), downsampled to ~100 points
      equityCurve: equityCurve.filter(
        (_, i) => i % Math.max(1, Math.floor(equityCurve.length / 100)) === 0 || i === equityCurve.length - 1,
      ),
      windowStart: balanceSeries[0].date,
      windowEnd: balanceSeries[balanceSeries.length - 1].date,
      sampleNote,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
