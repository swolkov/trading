import { checkTradovateAuth, getTradovatePositions, getTradovateAccountSummary, getOpenOrders, TRADOVATE_CONTRACTS } from "@/lib/tradovate";
import { prisma } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YF = require("yahoo-finance2").default || require("yahoo-finance2");
const yf = new YF({ suppressNotices: ["ripHistorical"] });

const YAHOO_MAP: Record<string, string> = {
  MES: "ES=F",
  MNQ: "NQ=F",
  MYM: "YM=F",
  M2K: "RTY=F",
};

function matchSymbol(contractName: string): string | null {
  for (const sym of Object.keys(YAHOO_MAP)) {
    if (contractName.startsWith(sym)) return sym;
  }
  return null;
}

export async function GET() {
  try {
    const auth = await checkTradovateAuth();

    // Get recent trade logs from DB regardless of Tradovate connection
    const recentLogs = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "FUT:" } },
      orderBy: { createdAt: "desc" },
      take: 1000,
    });

    const activity = recentLogs.map((log) => ({
      id: log.id,
      symbol: log.symbol.replace("FUT:", ""),
      action: log.action,
      qty: log.qty,
      price: log.price,
      pnl: log.pnl,
      reason: log.reason,
      aiScore: log.aiScore,
      aiSignal: log.aiSignal,
      orderId: log.orderId,
      time: log.createdAt.toISOString(),
    }));

    // Check Railway engine heartbeat
    let engineStatus: { alive: boolean; lastHeartbeat: string | null; ageMinutes: number } = { alive: false, lastHeartbeat: null, ageMinutes: 999 };
    try {
      const heartbeat = await prisma.agentConfig.findUnique({ where: { key: "futures_engine_heartbeat" } });
      if (heartbeat?.value) {
        const age = (Date.now() - new Date(heartbeat.value).getTime()) / 60000;
        engineStatus = { alive: age < 5, lastHeartbeat: heartbeat.value, ageMinutes: Math.round(age) };
      }
    } catch {}

    if (!auth.authenticated) {
      return Response.json({
        connected: false,
        account: null,
        positions: [],
        orders: [],
        activity,
        engineStatus,
      });
    }

    // Fetch positions, account, and orders in parallel
    const [positions, accountSummary, openOrders] = await Promise.all([
      getTradovatePositions(),
      getTradovateAccountSummary(),
      getOpenOrders(),
    ]);

    // Get live quotes for position symbols
    const symbolsNeeded = new Set<string>();
    for (const pos of positions) {
      const sym = matchSymbol(pos.contractName);
      if (sym) symbolsNeeded.add(YAHOO_MAP[sym]);
    }

    let quotes: Record<string, number> = {};
    if (symbolsNeeded.size > 0) {
      try {
        const yahooQuotes = await yf.quote([...symbolsNeeded]);
        const arr = Array.isArray(yahooQuotes) ? yahooQuotes : [yahooQuotes];
        for (const q of arr) {
          if (q?.symbol && q?.regularMarketPrice) {
            quotes[q.symbol] = q.regularMarketPrice;
          }
        }
      } catch { /* fall back to entry price */ }
    }

    // Match positions with trade logs for stop/target info
    const enrichedPositions = positions.map((pos) => {
      const sym = matchSymbol(pos.contractName);
      const yahooSym = sym ? YAHOO_MAP[sym] : null;
      const currentPrice = yahooSym ? quotes[yahooSym] || pos.netPrice : pos.netPrice;
      const contractSpec = sym ? TRADOVATE_CONTRACTS[sym] : null;
      const multiplier = contractSpec?.multiplier || 5;

      // Calculate unrealized P&L
      const direction = pos.netPos > 0 ? "long" : "short";
      const priceDiff = direction === "long"
        ? currentPrice - pos.netPrice
        : pos.netPrice - currentPrice;
      const unrealizedPnl = priceDiff * multiplier * Math.abs(pos.netPos);

      // Find the opening trade log for stop/target
      const tradeLog = recentLogs.find((log) =>
        log.symbol === `FUT:${sym}` &&
        (log.action === "futures_long" || log.action === "futures_short") &&
        log.orderId != null
      );

      // Parse stop/target from reason text
      let stopLoss: number | null = null;
      let target: number | null = null;
      if (tradeLog?.reason) {
        const stopMatch = tradeLog.reason.match(/Stop:\s*\$?([\d,.]+)/);
        const targetMatch = tradeLog.reason.match(/Target:\s*\$?([\d,.]+)/);
        if (stopMatch) stopLoss = parseFloat(stopMatch[1].replace(",", ""));
        if (targetMatch) target = parseFloat(targetMatch[1].replace(",", ""));
      }

      // Calculate % to stop and target
      const pctToStop = stopLoss ? ((currentPrice - stopLoss) / currentPrice * 100) * (direction === "long" ? 1 : -1) : null;
      const pctToTarget = target ? ((target - currentPrice) / currentPrice * 100) * (direction === "long" ? 1 : -1) : null;

      return {
        id: pos.id,
        contractName: pos.contractName,
        symbol: sym || pos.contractName,
        direction,
        quantity: Math.abs(pos.netPos),
        entryPrice: pos.netPrice,
        currentPrice,
        unrealizedPnl,
        stopLoss,
        target,
        pctToStop,
        pctToTarget,
        multiplier,
        setup: tradeLog?.reason?.match(/\[(FUTURES \w+)\]\s*(.+?):/)?.[2] || null,
        aiScore: tradeLog?.aiScore || null,
        openedAt: tradeLog?.createdAt?.toISOString() || pos.timestamp,
      };
    });

    return Response.json({
      connected: true,
      account: {
        balance: accountSummary.balance,
        netLiq: accountSummary.netLiq,
        realizedPnl: accountSummary.realizedPnl,
        unrealizedPnl: accountSummary.unrealizedPnl,
        marginUsed: accountSummary.marginUsed,
      },
      positions: enrichedPositions,
      orders: openOrders.map((o) => ({
        id: o.id,
        action: o.action,
        type: o.orderType,
        qty: o.orderQty,
        status: o.orderStatus,
      })),
      activity,
      engineStatus,
    });
  } catch (error) {
    console.error("[/api/futures/positions]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch futures positions" },
      { status: 500 }
    );
  }
}
