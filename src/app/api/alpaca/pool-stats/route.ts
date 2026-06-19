import { getAccount, getPositions } from "@/lib/alpaca";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Pool stats for the $1K Alpaca PAPER day-trade test (stocks + crypto, one shared pool).
//
// Money-truth P&L = paper-account EQUITY DELTA since the test started, NOT a sum of
// autoTradeLog rows (those are double-logged/inflated — see memory feedback_pnl_accuracy).
// The Alpaca paper account is used only by this bot now (options off, futures are Tradovate),
// so its equity change == the bot's P&L, regardless of the ~$90k shell sitting idle behind it.
const CLOSE_ACTIONS = ["take_profit", "stop_loss", "eod_flatten", "time_exit"];

export async function GET() {
  try {
    // ── Pool config ──
    const [sizeCfg, baselineCfg, startCfg] = await Promise.all([
      prisma.agentConfig.findUnique({ where: { key: "alpaca_account_size" } }),
      prisma.agentConfig.findUnique({ where: { key: "alpaca_test_baseline_equity" } }),
      prisma.agentConfig.findUnique({ where: { key: "alpaca_test_start" } }),
    ]);
    const poolSize = sizeCfg ? parseFloat(sizeCfg.value) : 1000;

    // ── Live paper account (the test is paper by definition) ──
    const account = await getAccount("paper");
    const currentEquity = parseFloat(account.equity);

    // ── Baseline: self-initialize on first call so P&L is measured from test start ──
    let baseline = baselineCfg ? parseFloat(baselineCfg.value) : NaN;
    let startISO = startCfg?.value || "";
    if (!baselineCfg || Number.isNaN(baseline)) {
      baseline = currentEquity;
      startISO = new Date().toISOString();
      await prisma.agentConfig.upsert({
        where: { key: "alpaca_test_baseline_equity" },
        update: { value: String(currentEquity) },
        create: { key: "alpaca_test_baseline_equity", value: String(currentEquity) },
      });
      await prisma.agentConfig.upsert({
        where: { key: "alpaca_test_start" },
        update: { value: startISO },
        create: { key: "alpaca_test_start", value: startISO },
      });
    }

    // ── Open positions (whole paper account = bot-only), split stocks vs crypto ──
    const positions = await getPositions("paper");
    const openPositions = positions.map((p) => {
      const isCrypto = p.asset_class === "crypto";
      return {
        symbol: p.symbol,
        kind: isCrypto ? "CRYPTO" : "STOCK",
        side: p.side,
        qty: p.qty,
        entry: parseFloat(p.avg_entry_price),
        current: parseFloat(p.current_price),
        marketValue: parseFloat(p.market_value),
        unrealizedPl: parseFloat(p.unrealized_pl),
        unrealizedPlpc: parseFloat(p.unrealized_plpc) * 100,
      };
    });
    const deployed = openPositions.reduce((s, p) => s + Math.abs(p.marketValue), 0);

    // ── P&L = equity delta (money-truth) ──
    const poolPnl = currentEquity - baseline;
    const poolPnlPct = poolSize > 0 ? (poolPnl / poolSize) * 100 : 0;

    // ── Activity from autoTradeLog (counts + win rate only — NOT $ P&L) ──
    const since = startISO ? new Date(startISO) : new Date(0);
    const closes = await prisma.autoTradeLog.findMany({
      where: {
        createdAt: { gte: since },
        action: { in: CLOSE_ACTIONS },
        OR: [{ symbol: { startsWith: "STK:" } }, { symbol: { startsWith: "CRY:" } }],
      },
      orderBy: { createdAt: "desc" },
    });
    const entries = await prisma.autoTradeLog.count({
      where: {
        createdAt: { gte: since },
        action: { in: ["stock_long", "crypto_long", "crypto_short"] },
        OR: [{ symbol: { startsWith: "STK:" } }, { symbol: { startsWith: "CRY:" } }],
      },
    });

    const wins = closes.filter((c) => (c.pnl ?? 0) > 0).length;
    const losses = closes.filter((c) => (c.pnl ?? 0) < 0).length;
    const decided = wins + losses;
    const stocksClosed = closes.filter((c) => c.symbol.startsWith("STK:")).length;
    const cryptoClosed = closes.filter((c) => c.symbol.startsWith("CRY:")).length;

    const recentTrades = closes.slice(0, 15).map((c) => ({
      symbol: c.symbol.replace(/^STK:|^CRY:/, ""),
      kind: c.symbol.startsWith("CRY:") ? "CRYPTO" : "STOCK",
      action: c.action,
      pnl: c.pnl,
      price: c.price,
      at: c.createdAt,
    }));

    return Response.json({
      mode: "paper",
      poolSize,
      baseline,
      currentEquity,
      shellEquity: currentEquity, // the raw ~$90k paper shell (for transparency)
      poolPnl,
      poolPnlPct,
      startISO,
      deployed,
      idle: Math.max(0, poolSize - deployed),
      openPositions,
      activity: {
        roundTrips: closes.length,
        entries,
        wins,
        losses,
        winRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
        stocksClosed,
        cryptoClosed,
      },
      recentTrades,
    });
  } catch (error) {
    console.error("[/api/alpaca/pool-stats]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
