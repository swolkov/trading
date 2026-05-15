import { checkTradovateAuth, getTradovatePositions, getTradovateAccountSummary, getOpenOrders, getTradovateFills, TRADOVATE_CONTRACTS, resolveContractSymbol } from "@/lib/tradovate";
import { prisma } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const YF = require("yahoo-finance2").default || require("yahoo-finance2");
const yf = new YF({ suppressNotices: ["ripHistorical"] });

const YAHOO_MAP: Record<string, string> = {
  MES: "ES=F",
  MNQ: "NQ=F",
  MYM: "YM=F",
  M2K: "RTY=F",
  MGC: "GC=F",
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

    // Fetch positions, account, orders, and fills in parallel
    const [positions, accountSummary, openOrders, fills] = await Promise.all([
      getTradovatePositions(),
      getTradovateAccountSummary(),
      getOpenOrders(),
      getTradovateFills(),
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

      // SANITY: Stop must be on correct side of entry (slippage can push fill past calculated stop)
      if (stopLoss && direction === "long" && stopLoss >= pos.netPrice) {
        // Recalculate: use ~1.3% of entry as fallback stop distance
        stopLoss = pos.netPrice * 0.987;
      }
      if (stopLoss && direction === "short" && stopLoss <= pos.netPrice) {
        stopLoss = pos.netPrice * 1.013;
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

    // Map fills with contract names — resolve via positions + Tradovate API
    const contractMap: Record<number, string> = {};
    for (const pos of positions) {
      contractMap[pos.contractId] = pos.contractName;
    }
    // Resolve any fill contractIds not in current positions
    const unmappedIds = [...new Set(fills.map((f) => f.contractId))].filter((id) => !contractMap[id]);
    for (const cid of unmappedIds) {
      const resolved = await resolveContractSymbol(cid);
      if (resolved) contractMap[cid] = resolved;
    }

    const mappedFills = fills.map((f) => {
      const contractName = contractMap[f.contractId] || "";
      const sym = matchSymbol(contractName);
      return {
        id: f.id,
        orderId: f.orderId,
        symbol: sym || contractName,
        action: f.action,
        qty: f.qty,
        price: f.price,
        time: f.timestamp,
        tradeDate: f.tradeDate,
      };
    });

    // Compute round-trip P&L from fills (source of truth)
    const fillsByContract: Record<number, typeof fills> = {};
    for (const f of fills) {
      if (!fillsByContract[f.contractId]) fillsByContract[f.contractId] = [];
      fillsByContract[f.contractId].push(f);
    }

    const roundTrips: { symbol: string; direction: string; qty: number; entryPrice: number; exitPrice: number; pnl: number; entryTime: string; exitTime: string }[] = [];
    for (const [cidStr, cFills] of Object.entries(fillsByContract)) {
      const cid = parseInt(cidStr);
      const contractName = contractMap[cid] || "";
      const sym = matchSymbol(contractName);
      const multiplier = sym ? (TRADOVATE_CONTRACTS[sym]?.multiplier || 5) : 5;
      const sorted = [...cFills].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      let position = 0;
      let entryFills: typeof fills = [];
      for (const fill of sorted) {
        const fillQty = fill.action === "Buy" ? fill.qty : -fill.qty;
        if (position === 0) {
          position = fillQty;
          entryFills = [fill];
        } else if ((position > 0 && fillQty < 0) || (position < 0 && fillQty > 0)) {
          const closeQty = Math.min(Math.abs(position), Math.abs(fillQty));
          const direction = position > 0 ? "long" : "short";
          const entryPrice = entryFills[0].price;
          const exitPrice = fill.price;
          const priceDiff = direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
          roundTrips.push({
            symbol: sym || contractName,
            direction,
            qty: closeQty,
            entryPrice,
            exitPrice,
            pnl: priceDiff * multiplier * closeQty,
            entryTime: entryFills[0].timestamp,
            exitTime: fill.timestamp,
          });
          position += fillQty;
          if (position === 0) entryFills = [];
        } else {
          position += fillQty;
          entryFills.push(fill);
        }
      }
    }

    const fillBasedPnl = {
      totalPnl: roundTrips.reduce((s, rt) => s + rt.pnl, 0),
      tradeCount: roundTrips.length,
      wins: roundTrips.filter((rt) => rt.pnl > 0).length,
      losses: roundTrips.filter((rt) => rt.pnl < 0).length,
      roundTrips,
    };

    // ── Reconciliation: cross-check DB trade P&L against fill-based round trips ──
    // IMPORTANT: Match by closest exit time AND exit price to avoid cross-contamination
    // when multiple trades on the same symbol happen within minutes of each other.
    if (roundTrips.length > 0) {
      try {
        const matchedDbIds = new Set<number>(); // prevent one round-trip from stealing another's match
        for (const rt of roundTrips) {
          const exitTime = new Date(rt.exitTime).getTime();
          // Find the BEST matching DB close entry: same symbol, close action, closest in time + price
          let bestMatch: typeof recentLogs[0] | null = null;
          let bestScore = Infinity;
          for (const log of recentLogs) {
            if (log.symbol !== `FUT:${rt.symbol}`) continue;
            if (log.pnl == null) continue;
            if (log.action === "futures_long" || log.action === "futures_short") continue;
            if (matchedDbIds.has(log.id)) continue; // already matched to a different round-trip
            const logTime = new Date(log.createdAt).getTime();
            const timeDiff = Math.abs(logTime - exitTime);
            if (timeDiff > 2 * 60 * 1000) continue; // tighten window to 2 min (was 5)
            // Score by time proximity + price proximity (lower = better)
            const priceDiff = log.price ? Math.abs(log.price - rt.exitPrice) : 0;
            const score = timeDiff + priceDiff * 60000; // weight price match heavily
            if (score < bestScore) {
              bestScore = score;
              bestMatch = log;
            }
          }

          if (bestMatch && bestMatch.pnl != null) {
            matchedDbIds.add(bestMatch.id);
            const diff = Math.abs(bestMatch.pnl - rt.pnl);
            if (diff > 1) {
              await prisma.autoTradeLog.update({
                where: { id: bestMatch.id },
                data: {
                  pnl: rt.pnl,
                  reason: bestMatch.reason + ` [reconciled: was $${bestMatch.pnl.toFixed(0)}, fills show $${rt.pnl.toFixed(0)}]`,
                },
              });
              const activityMatch = activity.find((a) => a.id === bestMatch.id);
              if (activityMatch) activityMatch.pnl = rt.pnl;
            }
          }
        }
      } catch { /* reconciliation is best-effort */ }
    }

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
      fills: mappedFills,
      fillCount: fills.length,
      fillBasedPnl,
      activity,
      engineStatus,
      startOfDayBalance: await (async () => {
        try {
          const sod = await prisma.agentConfig.findUnique({ where: { key: "start_of_day_balance" } });
          return sod?.value ? parseFloat(sod.value) : null;
        } catch { return null; }
      })(),
      // Historical daily balance snapshots for accurate Daily Breakdown
      balanceHistory: await (async () => {
        try {
          const dailyBalances = await prisma.agentConfig.findMany({
            where: { key: { startsWith: "daily_balance_" } },
          });
          const eodBalances = await prisma.agentConfig.findMany({
            where: { key: { startsWith: "eod_balance_" } },
          });
          const history: Record<string, { sod?: number; eod?: number }> = {};
          for (const b of dailyBalances) {
            const date = b.key.replace("daily_balance_", "");
            if (!history[date]) history[date] = {};
            history[date].sod = parseFloat(b.value);
          }
          for (const b of eodBalances) {
            const date = b.key.replace("eod_balance_", "");
            if (!history[date]) history[date] = {};
            history[date].eod = parseFloat(b.value);
          }
          return Object.entries(history)
            .map(([date, vals]) => ({ date, startBalance: vals.sod ?? null, endBalance: vals.eod ?? null }))
            .sort((a, b) => a.date.localeCompare(b.date));
        } catch { return []; }
      })(),
    });
  } catch (error) {
    console.error("[/api/futures/positions]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch futures positions" },
      { status: 500 }
    );
  }
}
