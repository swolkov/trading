import { checkTradovateAuth, getTradovatePositions, getTradovateAccountSummary, getOpenOrders, getTradovateFills, TRADOVATE_CONTRACTS, resolveContractSymbol } from "@/lib/tradovate";
import { getFuturesQuotes } from "@/lib/futures-data";
import { prisma } from "@/lib/db";
import { getViewMode } from "@/lib/trading-mode";

const KNOWN_SYMBOLS = ["MES", "MNQ", "MYM", "M2K", "MGC", "MBT", "MET", "BFF", "MXR", "MSL", "ES", "NQ", "YM", "RTY", "GC"];

function matchSymbol(contractName: string): string | null {
  for (const sym of KNOWN_SYMBOLS) {
    if (contractName.startsWith(sym)) return sym;
  }
  return null;
}

// RESILIENCE: surface the engine's OWN open positions from its persisted record when the Tradovate
// snapshot is unavailable (auth rate-limited after a restart, or a transient API failure). The engine
// writes futures_positions_{live,demo} on every entry, and broker stops protect the trade regardless —
// so the dashboard should never hide a real open position just because the read-side API hiccupped.
async function enginePositionsFallback(viewMode: string) {
  try {
    const blobKey = viewMode === "live" ? "futures_positions_live" : "futures_positions_demo";
    const blobRaw = (await prisma.agentConfig.findUnique({ where: { key: blobKey } }))?.value;
    const blob = blobRaw ? JSON.parse(blobRaw) as Record<string, {
      symbol: string; direction: "long" | "short"; quantity: number; entryPrice: number;
      stopLoss: number; target: number; entryTime: number; entrySetupType?: string; contractId?: number;
    }> : {};
    const enginePos = Object.values(blob);
    if (enginePos.length === 0) return [];
    const syms = [...new Set(enginePos.map((p) => p.symbol))];
    const q = await getFuturesQuotes(syms, viewMode as "live").catch(() => ({} as Record<string, { price: number }>));
    return enginePos.map((p) => {
      const cur = q[p.symbol]?.price || p.entryPrice;
      const mult = TRADOVATE_CONTRACTS[p.symbol]?.multiplier || 5;
      const diff = p.direction === "long" ? cur - p.entryPrice : p.entryPrice - cur;
      return {
        id: p.contractId ?? 0,
        contractName: p.symbol,
        symbol: p.symbol,
        direction: p.direction,
        quantity: p.quantity,
        entryPrice: p.entryPrice,
        currentPrice: cur,
        unrealizedPnl: diff * mult * p.quantity,
        stopLoss: p.stopLoss ?? null,
        target: p.target ?? null,
        pctToStop: p.stopLoss ? ((cur - p.stopLoss) / cur * 100) * (p.direction === "long" ? 1 : -1) : null,
        pctToTarget: p.target ? ((p.target - cur) / cur * 100) * (p.direction === "long" ? 1 : -1) : null,
        multiplier: mult,
        setup: p.entrySetupType || null,
        aiScore: null,
        openedAt: new Date(p.entryTime).toISOString(),
        source: "engine" as const,
      };
    });
  } catch { return []; }
}

export async function GET() {
  try {
    // Dashboard shows data from whichever account the VIEW mode points to.
    // This is independent of the agent execution mode (trading_mode_futures).
    const viewMode = await getViewMode("futures");
    const actionPrefix = viewMode === "live" ? "live_" : "futures_";

    // Kick off auth + all DB prefetches in parallel — none depend on each other
    const [auth, recentLogs, demoHB, liveHB] = await Promise.all([
      checkTradovateAuth(viewMode),
      prisma.autoTradeLog.findMany({
        where: { symbol: { startsWith: "FUT:" }, action: { startsWith: actionPrefix } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.agentConfig.findUnique({ where: { key: "futures_engine_heartbeat_demo" } }).catch(() => null),
      prisma.agentConfig.findUnique({ where: { key: "futures_engine_heartbeat_live" } }).catch(() => null),
    ]);

    const activity = recentLogs
      // Hide phantom rows: close attempts that never filled (swept to pnl:0 and tagged SUPERSEDED).
      // These are non-events — showing them as "$0" trades clutters the list and confuses the P&L picture.
      .filter((log) => !(log.reason?.includes("SUPERSEDED")))
      .map((log) => ({
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

    // Parse engine heartbeats
    let engineStatus: { alive: boolean; lastHeartbeat: string | null; ageMinutes: number; demo?: { alive: boolean; ageMinutes: number }; live?: { alive: boolean; ageMinutes: number } } = { alive: false, lastHeartbeat: null, ageMinutes: 999 };
    try {
      const parseAge = (hb: typeof demoHB) => {
        if (!hb?.value) return { alive: false, ageMinutes: 999 };
        try {
          const parsed = JSON.parse(hb.value);
          const age = (Date.now() - new Date(parsed.timestamp).getTime()) / 60000;
          return { alive: age < 5, ageMinutes: Math.round(age) };
        } catch {
          const age = (Date.now() - new Date(hb.value).getTime()) / 60000;
          return { alive: age < 5, ageMinutes: Math.round(age) };
        }
      };
      const demo = parseAge(demoHB);
      const live = parseAge(liveHB);
      const relevantHB = viewMode === "live" ? liveHB : demoHB;
      const relevantAge = viewMode === "live" ? live : demo;
      engineStatus = {
        alive: relevantAge.alive,
        lastHeartbeat: relevantHB?.value || null,
        ageMinutes: relevantAge.ageMinutes,
        demo,
        live,
      };
    } catch {}

    if (!auth.authenticated) {
      // Still return viewMode and balance data even when Tradovate auth fails
      // This prevents the dashboard from flickering to demo view during rate limits
      const scKey = viewMode === "live" ? "starting_capital_live" : "starting_capital_demo";
      const sodKey = viewMode === "live" ? "live_start_of_day_balance" : "start_of_day_balance";
      const [scCfg, sodCfg] = await Promise.all([
        prisma.agentConfig.findUnique({ where: { key: scKey } }).catch(() => null),
        prisma.agentConfig.findUnique({ where: { key: sodKey } }).catch(() => null),
      ]);
      const startingCapital = scCfg?.value ? parseFloat(scCfg.value) : (viewMode === "live" ? 1025 : 50000);
      const startOfDayBalance = sodCfg?.value ? parseFloat(sodCfg.value) : null;

      return Response.json({
        connected: false,
        account: null,
        // Auth failed (usually a transient rate-limit) — still show the engine's own open positions
        // so the dashboard never goes blind on a real trade.
        positions: await enginePositionsFallback(viewMode),
        orders: [],
        activity,
        engineStatus,
        viewMode,
        startingCapital,
        startOfDayBalance,
      });
    }

    // Fetch positions, account, orders, and fills in parallel — using view mode
    // RESILIENT: one failing Tradovate call (e.g. the account snapshot getting rate-limited right
    // after an engine restart) must NOT blank the whole dashboard. Catch each independently so a
    // transient failure on one degrades gracefully instead of hiding real open positions.
    const [positions, accountSummary, openOrders, fills] = await Promise.all([
      getTradovatePositions(viewMode).catch(() => [] as Awaited<ReturnType<typeof getTradovatePositions>>),
      getTradovateAccountSummary(viewMode).catch(() => null),
      getOpenOrders(viewMode).catch(() => [] as Awaited<ReturnType<typeof getOpenOrders>>),
      getTradovateFills(viewMode).catch(() => [] as Awaited<ReturnType<typeof getTradovateFills>>),
    ]);

    // RECONCILE against fills before showing anything. Tradovate's position snapshot can lag for
    // minutes after a close — reporting a flat (closed) position as still OPEN. Marking that stale
    // entry against the live price invents phantom unrealized P&L: a real −$136 closed trade once
    // displayed as "+$140" because the snapshot still showed the short open while the market kept
    // falling. Fills update in real time, so when a contract's fills net to zero it is actually flat.
    const netByContract: Record<number, number> = {};
    for (const f of fills) {
      const delta = f.action === "Buy" ? f.qty : f.action === "Sell" ? -f.qty : 0;
      netByContract[f.contractId] = (netByContract[f.contractId] ?? 0) + delta;
    }
    const livePositions = positions.filter((pos) => {
      if (!(pos.contractId in netByContract)) return true;       // no fill data — can't reconcile, keep
      if (netByContract[pos.contractId] !== 0) return true;      // fills confirm a live net — keep
      // Fills net to flat. Only drop if a fill happened AFTER the snapshot's open time — that's real
      // evidence the position closed since it opened (the lag bug). This guards against dropping a
      // position carried from a prior session that this session's net-zero round-trips never touched.
      // (/fill/list is session-scoped, so net-zero alone isn't proof a cross-session position is flat.)
      const openTs = new Date(pos.timestamp).getTime();
      const closedSinceOpen = fills.some((f) => f.contractId === pos.contractId && new Date(f.timestamp).getTime() > openTs);
      return !closedSinceOpen;
    });
    const droppedPhantoms = positions.length - livePositions.length;
    if (droppedPhantoms > 0) {
      console.warn(`[/api/futures/positions] suppressed ${droppedPhantoms} stale phantom position(s) — fills net to flat`);
    }

    // Get live quotes for position symbols (Tradovate primary, Yahoo fallback)
    const symbolsNeeded: string[] = [];
    for (const pos of livePositions) {
      const sym = matchSymbol(pos.contractName);
      if (sym && !symbolsNeeded.includes(sym)) symbolsNeeded.push(sym);
    }

    const quotes: Record<string, number> = {};
    if (symbolsNeeded.length > 0) {
      try {
        const futuresQuotes = await getFuturesQuotes(symbolsNeeded, viewMode);
        for (const [sym, q] of Object.entries(futuresQuotes)) {
          if (q.price > 0) quotes[sym] = q.price;
        }
      } catch { /* fall back to entry price */ }
    }

    // Match positions with trade logs for stop/target info
    const enrichedPositions = livePositions.map((pos) => {
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
        (log.action === "futures_long" || log.action === "futures_short" ||
         log.action === "live_long" || log.action === "live_short") &&
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

    // RESILIENCE FALLBACK: if Tradovate's snapshot returned no positions (rate-limited / transient),
    // surface the engine's OWN position record so the dashboard never hides a real open trade. The
    // engine writes futures_positions_{live,demo} on every entry; broker stops protect it regardless.
    let displayPositions: Array<(typeof enrichedPositions)[number] & { source?: "engine" }> = enrichedPositions;
    if (displayPositions.length === 0) {
      const fromEngine = await enginePositionsFallback(viewMode);
      if (fromEngine.length > 0) {
        displayPositions = fromEngine;
        console.warn(`[/api/futures/positions] Tradovate snapshot empty — showing ${fromEngine.length} position(s) from engine record (${viewMode})`);
      }
    }

    // Map fills with contract names — resolve via positions + Tradovate API
    const contractMap: Record<number, string> = {};
    for (const pos of positions) {
      contractMap[pos.contractId] = pos.contractName;
    }
    // Resolve any fill contractIds not in current positions
    const unmappedIds = [...new Set(fills.map((f) => f.contractId))].filter((id) => !contractMap[id]);
    for (const cid of unmappedIds) {
      const resolved = await resolveContractSymbol(cid, viewMode);
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

    // Run all response-level DB computations in parallel — none depend on each other
    const isDemoView = viewMode !== "live";
    const kp = isDemoView ? "futures" : "live_futures";
    const todayET = new Date().toISOString().slice(0, 10);
    const todayStart = new Date(todayET + "T00:00:00-04:00");
    const scKey = viewMode === "live" ? "starting_capital_live" : "starting_capital_demo";
    const sodKey = viewMode === "live" ? "live_start_of_day_balance" : "start_of_day_balance";
    const modeActionPrefix = isDemoView ? "futures_" : "live_";

    const [riskMetrics, startingCapital, startOfDayBalance, balanceHistory] = await Promise.all([

      // riskMetrics: dashboard risk gauge (mode-aware)
      (async () => {
        try {
          const rmKeys = [`${kp}_daily_loss_limit_pct`, `${kp}_max_trades_per_day`, `${kp}_risk_per_trade_pct`, `${kp}_simulated_equity`];
          const [configs, todayTrades] = await Promise.all([
            prisma.agentConfig.findMany({ where: { key: { in: rmKeys } } }),
            prisma.autoTradeLog.count({
              where: { symbol: { startsWith: "FUT:" }, action: { startsWith: modeActionPrefix }, pnl: { not: null }, createdAt: { gte: todayStart } },
            }),
          ]);
          const cfg: Record<string, string> = {};
          for (const c of configs) cfg[c.key] = c.value;
          const dailyLossPct = parseFloat(cfg[`${kp}_daily_loss_limit_pct`]) || (isDemoView ? 15 : 8);
          const riskPct = parseFloat(cfg[`${kp}_risk_per_trade_pct`]) || (isDemoView ? 8 : 5);
          const simCfg = parseFloat(cfg[`${kp}_simulated_equity`]) || 0;
          const simEquity = isDemoView
            ? (accountSummary?.netLiq || accountSummary?.balance || 50000)
            : (simCfg > 0 ? simCfg : (accountSummary?.netLiq || accountSummary?.balance || 1000));
          const maxTrades = isDemoView ? 20 : (parseInt(cfg[`${kp}_max_trades_per_day`]) || 1);
          return { dailyLossLimit: simEquity * (dailyLossPct / 100), maxTradesPerDay: maxTrades, riskPerTrade: simEquity * (riskPct / 100), simEquity, todayTradeCount: todayTrades };
        } catch { return null; }
      })(),

      // startingCapital: SC for total P&L calculation
      (async () => {
        try {
          const cfg = await prisma.agentConfig.findUnique({ where: { key: scKey } });
          return cfg?.value ? parseFloat(cfg.value) : (viewMode === "live" ? 1025 : 50000);
        } catch { return viewMode === "live" ? 1025 : 50000; }
      })(),

      // startOfDayBalance: for today P&L = balance - SOD
      (async () => {
        try {
          const sodConfig = await prisma.agentConfig.findUnique({ where: { key: sodKey } });
          if (sodConfig?.value) { const v = parseFloat(sodConfig.value); if (!isNaN(v) && v > 0) return v; }
        } catch {}
        const todayKey = todayET;
        try {
          const vaultDoc = await prisma.vaultDocument.findUnique({ where: { path: "Performance/daily-balances.md" } });
          if (vaultDoc?.content) {
            const todayMatch = vaultDoc.content.match(new RegExp(`${todayKey}:\\s*\\n\\s*sod:\\s*(\\d+(?:\\.\\d+)?)`));
            if (todayMatch) { const v = parseFloat(todayMatch[1]); if (!isNaN(v) && v > 0) return v; }
            const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
            const ydKey = yesterday.toISOString().slice(0, 10);
            const ydMatch = vaultDoc.content.match(new RegExp(`${ydKey}:\\s*\\n\\s*sod:\\s*\\S+[^\\n]*\\n\\s*eod:\\s*(\\d+(?:\\.\\d+)?)`));
            if (ydMatch) { const v = parseFloat(ydMatch[1]); if (!isNaN(v) && v > 0) return v; }
          }
        } catch {}
        try {
          const snap = await prisma.agentConfig.findUnique({ where: { key: `daily_balance_${todayKey}` } });
          if (snap?.value) { const v = parseFloat(snap.value); if (!isNaN(v) && v !== accountSummary?.balance) return v; }
        } catch {}
        if (accountSummary?.balance != null && accountSummary?.realizedPnl != null && accountSummary.realizedPnl !== 0) {
          return accountSummary.balance - accountSummary.realizedPnl;
        }
        return null;
      })(),

      // balanceHistory: 30-day snapshots for period P&L (week/month/total)
      (async () => {
        if (viewMode === "live") {
          try {
            const [liveDailyBalances, liveEodBalances] = await Promise.all([
              prisma.agentConfig.findMany({ where: { key: { startsWith: "live_daily_balance_" } } }),
              prisma.agentConfig.findMany({ where: { key: { startsWith: "live_eod_balance_" } } }),
            ]);
            const liveHistory: Record<string, { sod?: number; eod?: number }> = {};
            for (const b of liveDailyBalances) { const d = b.key.replace("live_daily_balance_", ""); if (!liveHistory[d]) liveHistory[d] = {}; liveHistory[d].sod = parseFloat(b.value); }
            for (const b of liveEodBalances) { const d = b.key.replace("live_eod_balance_", ""); if (!liveHistory[d]) liveHistory[d] = {}; liveHistory[d].eod = parseFloat(b.value); }
            return Object.entries(liveHistory).map(([date, v]) => ({ date, startBalance: v.sod ?? null, endBalance: v.eod ?? null })).sort((a, b) => a.date.localeCompare(b.date));
          } catch { return []; }
        }
        try {
          // SKIP vault document for balance history — it mixes live/demo balances (bug).
          // DB snapshots (daily_balance_* / eod_balance_*) are the reliable source.
          const [dailyBalances, eodBalances] = await Promise.all([
            prisma.agentConfig.findMany({ where: { key: { startsWith: "daily_balance_" } } }),
            prisma.agentConfig.findMany({ where: { key: { startsWith: "eod_balance_" } } }),
          ]);
          const configHistory: Record<string, { sod?: number; eod?: number }> = {};
          for (const b of dailyBalances) { const d = b.key.replace("daily_balance_", ""); if (!configHistory[d]) configHistory[d] = {}; configHistory[d].sod = parseFloat(b.value); }
          for (const b of eodBalances) { const d = b.key.replace("eod_balance_", ""); if (!configHistory[d]) configHistory[d] = {}; configHistory[d].eod = parseFloat(b.value); }
          return Object.entries(configHistory).map(([date, v]) => ({ date, startBalance: v.sod ?? null, endBalance: v.eod ?? null })).sort((a, b) => a.date.localeCompare(b.date));
        } catch { return []; }
      })(),
    ]);

    // LEAK GUARD: the live account is a micro account (switches to full-size only at $25K by design),
    // so a live netLiq wildly above the live starting capital means the account resolution crossed to
    // the demo account on a cold call. Suppress the false balance and fall back to the engine-tracked
    // start-of-day value rather than flash a $64K demo figure on the real $1K live view.
    let safeAccount = accountSummary;
    if (viewMode === "live" && accountSummary && accountSummary.netLiq > (startingCapital || 1025) * 20) {
      console.warn(`[/api/futures/positions] LIVE balance leak suppressed: netLiq ${accountSummary.netLiq} >> live cap; falling back to SOD ${startOfDayBalance}`);
      const sod = startOfDayBalance || accountSummary.balance || 0;
      safeAccount = { ...accountSummary, netLiq: sod, balance: sod };
    }

    return Response.json({
      connected: true,
      viewMode,
      account: safeAccount ? {
        balance: safeAccount.balance,
        netLiq: safeAccount.netLiq,
        realizedPnl: safeAccount.realizedPnl,
        unrealizedPnl: safeAccount.unrealizedPnl,
        marginUsed: safeAccount.marginUsed,
      } : null,
      riskMetrics,
      positions: displayPositions,
      orders: openOrders.map((o) => ({
        id: o.id,
        action: o.action,
        type: o.orderType,
        qty: o.orderQty ?? 0,
        status: o.orderStatus,
      })),
      fills: mappedFills,
      fillCount: fills.length,
      fillBasedPnl,
      activity,
      engineStatus,
      todayTradesPnl: null, // Force balance delta path on frontend (DB sums are double-logged)
      startingCapital,
      startOfDayBalance,
      balanceHistory,
    });
  } catch (error) {
    console.error("[/api/futures/positions]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch futures positions" },
      { status: 500 }
    );
  }
}
