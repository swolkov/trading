import { checkTradovateAuth, getTradovatePositions, getTradovateAccountSummary, getOpenOrders, getTradovateFills, TRADOVATE_CONTRACTS, resolveContractSymbol } from "@/lib/tradovate";
import { getFuturesQuotes } from "@/lib/futures-data";
import { prisma } from "@/lib/db";
import { getViewMode } from "@/lib/trading-mode";

const KNOWN_SYMBOLS = ["MES", "MNQ", "MYM", "M2K", "MGC", "ES", "NQ", "YM", "RTY", "GC"];

function matchSymbol(contractName: string): string | null {
  for (const sym of KNOWN_SYMBOLS) {
    if (contractName.startsWith(sym)) return sym;
  }
  return null;
}

export async function GET() {
  try {
    // Dashboard shows data from whichever account the VIEW mode points to.
    // This is independent of the agent execution mode (trading_mode_futures).
    const viewMode = await getViewMode("futures");
    const auth = await checkTradovateAuth(viewMode);

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

    // Fetch positions, account, orders, and fills in parallel — using view mode
    const [positions, accountSummary, openOrders, fills] = await Promise.all([
      getTradovatePositions(viewMode),
      getTradovateAccountSummary(viewMode),
      getOpenOrders(viewMode),
      getTradovateFills(viewMode),
    ]);

    // Get live quotes for position symbols (Tradovate primary, Yahoo fallback)
    const symbolsNeeded: string[] = [];
    for (const pos of positions) {
      const sym = matchSymbol(pos.contractName);
      if (sym && !symbolsNeeded.includes(sym)) symbolsNeeded.push(sym);
    }

    let quotes: Record<string, number> = {};
    if (symbolsNeeded.length > 0) {
      try {
        const futuresQuotes = await getFuturesQuotes(symbolsNeeded);
        for (const [sym, q] of Object.entries(futuresQuotes)) {
          if (q.price > 0) quotes[sym] = q.price;
        }
      } catch { /* fall back to entry price */ }
    }

    // Match positions with trade logs for stop/target info
    const enrichedPositions = positions.map((pos) => {
      const sym = matchSymbol(pos.contractName);
      const currentPrice = sym ? quotes[sym] || pos.netPrice : pos.netPrice;
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

    // P&L reconciliation DISABLED — the agent calculates P&L correctly at trade time
    // (entry × multiplier × qty). Fill-based round-trip matching cross-contaminates when
    // multiple trades on the same symbol happen within minutes. Aggregate P&L uses broker
    // account balance (source of truth), so per-trade reconciliation is not needed.

    return Response.json({
      connected: true,
      viewMode,
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
        // Vault/DB snapshots are from the demo account only.
        // When viewing live, skip them and use broker-derived fallback.
        if (viewMode === "live") {
          if (accountSummary?.balance != null && accountSummary?.realizedPnl != null && accountSummary.realizedPnl !== 0) {
            return accountSummary.balance - accountSummary.realizedPnl;
          }
          return null;
        }

        const todayKey = new Date().toISOString().slice(0, 10);
        // 1. Best source: vault daily-balances.md (Railway engine writes SOD before trading)
        try {
          const vaultDoc = await prisma.vaultDocument.findUnique({
            where: { path: "Performance/daily-balances.md" },
          });
          if (vaultDoc?.content) {
            // Parse today's SOD from the YAML block
            const todayRegex = new RegExp(`${todayKey}:\\s*\\n\\s*sod:\\s*(\\d+(?:\\.\\d+)?)`);
            const match = vaultDoc.content.match(todayRegex);
            if (match) {
              const sodVal = parseFloat(match[1]);
              if (!isNaN(sodVal) && sodVal > 0) return sodVal;
            }
            // Fallback: yesterday's EOD from vault
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const ydKey = yesterday.toISOString().slice(0, 10);
            const ydRegex = new RegExp(`${ydKey}:\\s*\\n\\s*sod:\\s*\\S+[^\\n]*\\n\\s*eod:\\s*(\\d+(?:\\.\\d+)?)`);
            const ydMatch = vaultDoc.content.match(ydRegex);
            if (ydMatch) {
              const eodVal = parseFloat(ydMatch[1]);
              if (!isNaN(eodVal) && eodVal > 0) return eodVal;
            }
          }
        } catch {}
        // 2. Fallback: agentConfig snapshots
        try {
          const sodSnapshot = await prisma.agentConfig.findUnique({
            where: { key: `daily_balance_${todayKey}` },
          });
          if (sodSnapshot?.value) {
            const sodVal = parseFloat(sodSnapshot.value);
            if (!isNaN(sodVal) && sodVal !== accountSummary.balance) return sodVal;
          }
        } catch {}
        // 3. Fallback: balance minus realized P&L (works during active trading only)
        if (accountSummary?.balance != null && accountSummary?.realizedPnl != null && accountSummary.realizedPnl !== 0) {
          return accountSummary.balance - accountSummary.realizedPnl;
        }
        return null;
      })(),
      // Historical daily balance snapshots — vault is source of truth (demo only)
      balanceHistory: await (async () => {
        // Vault/DB balance history is from the demo account only
        if (viewMode === "live") return [];

        try {
          // Primary: parse from vault daily-balances.md
          const vaultDoc = await prisma.vaultDocument.findUnique({
            where: { path: "Performance/daily-balances.md" },
          });
          if (vaultDoc?.content) {
            const vaultHistory: Record<string, { sod?: number; eod?: number }> = {};
            const dayRegex = /(\d{4}-\d{2}-\d{2}):\s*\n\s*sod:\s*(\d+(?:\.\d+)?|null)[^\n]*\n\s*eod:\s*(\d+(?:\.\d+)?|null)/g;
            let m;
            while ((m = dayRegex.exec(vaultDoc.content)) !== null) {
              vaultHistory[m[1]] = {
                sod: m[2] === "null" ? undefined : parseFloat(m[2]),
                eod: m[3] === "null" ? undefined : parseFloat(m[3]),
              };
            }
            if (Object.keys(vaultHistory).length > 0) {
              return Object.entries(vaultHistory)
                .map(([date, vals]) => ({ date, startBalance: vals.sod ?? null, endBalance: vals.eod ?? null }))
                .sort((a, b) => a.date.localeCompare(b.date));
            }
          }
          // Fallback: agentConfig table
          const dailyBalances = await prisma.agentConfig.findMany({
            where: { key: { startsWith: "daily_balance_" } },
          });
          const eodBalances = await prisma.agentConfig.findMany({
            where: { key: { startsWith: "eod_balance_" } },
          });
          const configHistory: Record<string, { sod?: number; eod?: number }> = {};
          for (const b of dailyBalances) {
            const date = b.key.replace("daily_balance_", "");
            if (!configHistory[date]) configHistory[date] = {};
            configHistory[date].sod = parseFloat(b.value);
          }
          for (const b of eodBalances) {
            const date = b.key.replace("eod_balance_", "");
            if (!configHistory[date]) configHistory[date] = {};
            configHistory[date].eod = parseFloat(b.value);
          }
          return Object.entries(configHistory)
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
