import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { checkTradovateAuth, getTradovatePositions, getCashBalanceLogs, getTradovateAccountSummary } from "@/lib/tradovate";
import { getViewMode } from "@/lib/trading-mode";

const MULTIPLIERS: Record<string, number> = {
  MES: 5, MNQ: 2, MGC: 10, MYM: 0.5, M2K: 5,
  MBT: 0.1, MET: 0.1, BFF: 0.01, MXR: 2500, MSL: 25,
};

export const maxDuration = 60;

// PUT: Auto-pull daily balance history from Tradovate cash balance logs + fill-based reconstruction
// Also accepts manual overrides: { balances: [{ date: "2026-05-14", balance: 51800 }] }
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const results: string[] = [];
    // Use view mode so backfill targets the account the user is viewing
    const mode = body.mode || await getViewMode("futures");
    const isLive = mode === "live";
    // Mode-prefixed keys prevent demo/live balance data from colliding
    const balKeyPrefix = isLive ? "live_daily_balance_" : "daily_balance_";
    const eodKeyPrefix = isLive ? "live_eod_balance_" : "eod_balance_";
    const modeTag = isLive ? "LIVE" : "DEMO";

    // 1. If manual balances provided, seed them
    const manualBalances: { date: string; balance: number }[] = body.balances || [];
    for (const { date, balance } of manualBalances) {
      if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
      await prisma.agentConfig.upsert({
        where: { key: `${balKeyPrefix}${date}` },
        update: { value: String(balance) },
        create: { key: `${balKeyPrefix}${date}`, value: String(balance) },
      });
      results.push(`manual [${modeTag}]: ${date} = $${balance.toLocaleString()}`);
    }

    // 2. Auto-pull from Tradovate cash balance logs
    const auth = await checkTradovateAuth(mode);
    if (!auth.authenticated) {
      return Response.json({ seeded: results.length, details: results, error: "Tradovate not connected — only manual balances seeded" });
    }

    // Get current balance as today's snapshot
    const account = await getTradovateAccountSummary(mode);
    const today = new Date().toISOString().slice(0, 10);
    await prisma.agentConfig.upsert({
      where: { key: `${balKeyPrefix}${today}` },
      update: { value: String(account.balance) },
      create: { key: `${balKeyPrefix}${today}`, value: String(account.balance) },
    });
    results.push(`today [${modeTag}]: ${today} = $${account.balance.toLocaleString()}`);

    // Try cash balance logs for historical daily settlement data
    const cashLogs = await getCashBalanceLogs(mode);
    if (cashLogs.length > 0) {
      for (const log of cashLogs) {
        const date = `${log.tradeDate.year}-${String(log.tradeDate.month).padStart(2, "0")}-${String(log.tradeDate.day).padStart(2, "0")}`;
        await prisma.agentConfig.upsert({
          where: { key: `${balKeyPrefix}${date}` },
          update: { value: String(log.amount) },
          create: { key: `${balKeyPrefix}${date}`, value: String(log.amount) },
        });
        await prisma.agentConfig.upsert({
          where: { key: `${eodKeyPrefix}${date}` },
          update: { value: String(log.amount) },
          create: { key: `${eodKeyPrefix}${date}`, value: String(log.amount) },
        });
        results.push(`tradovate [${modeTag}]: ${date} = $${log.amount.toLocaleString()} (settlement, realized: $${log.realizedPnL})`);
      }
    } else {
      // Fallback: reconstruct from fills + current balance (work backwards)
      // Filter trade logs by mode symbols to avoid cross-contamination
      const modeSymbols = isLive
        ? ["FUT:MES", "FUT:MNQ", "FUT:BFF"]
        : ["FUT:ES", "FUT:NQ", "FUT:GC", "FUT:MBT", "FUT:MET", "FUT:BFF", "FUT:MXR", "FUT:MSL"];
      const tradeLogs = await prisma.autoTradeLog.findMany({
        where: { symbol: { in: modeSymbols }, pnl: { not: null } },
        orderBy: { createdAt: "desc" },
      });

      // Group P&L by date
      const dailyPnls: Record<string, number> = {};
      for (const log of tradeLogs) {
        const d = new Date(log.createdAt);
        const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        dailyPnls[dateKey] = (dailyPnls[dateKey] || 0) + (log.pnl || 0);
      }

      // Work backwards from current balance to reconstruct historical
      const existingKeys = new Set(
        (await prisma.agentConfig.findMany({ where: { key: { startsWith: balKeyPrefix } }, select: { key: true } }))
          .map((r) => r.key)
      );
      const existingEodKeys = new Set(
        (await prisma.agentConfig.findMany({ where: { key: { startsWith: eodKeyPrefix } }, select: { key: true } }))
          .map((r) => r.key)
      );
      const dates = Object.keys(dailyPnls).sort().reverse();
      let runningBalance = account.balance;
      for (const date of dates) {
        if (date === today) continue;
        const eodBalance = runningBalance;
        const sodBalance = eodBalance - dailyPnls[date];
        if (existingKeys.has(`${balKeyPrefix}${date}`)) {
          results.push(`skipped [${modeTag}]: ${date} (already has balance)`);
          const existing = await prisma.agentConfig.findUnique({ where: { key: `${balKeyPrefix}${date}` } });
          if (existing) runningBalance = parseFloat(existing.value);
          continue;
        }
        await prisma.agentConfig.upsert({
          where: { key: `${balKeyPrefix}${date}` },
          update: { value: String(sodBalance) },
          create: { key: `${balKeyPrefix}${date}`, value: String(sodBalance) },
        });
        if (!existingEodKeys.has(`${eodKeyPrefix}${date}`)) {
          await prisma.agentConfig.upsert({
            where: { key: `${eodKeyPrefix}${date}` },
            update: { value: String(eodBalance) },
            create: { key: `${eodKeyPrefix}${date}`, value: String(eodBalance) },
          });
        }
        results.push(`reconstructed [${modeTag}]: ${date} SOD=$${sodBalance.toFixed(0)} EOD=$${eodBalance.toFixed(0)} (day P&L: $${dailyPnls[date].toFixed(0)})`);
        runningBalance = sodBalance;
      }
    }

    return Response.json({ seeded: results.length, details: results });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function POST() {
  try {
    const mode = await getViewMode("futures");
    const isLive = mode === "live";
    const modeSymbols = isLive ? ["FUT:MES", "FUT:MNQ"] : ["FUT:ES", "FUT:NQ", "FUT:GC"];
    const knownSymbols = isLive ? ["MES", "MNQ", "MYM", "M2K", "MGC"] : ["ES", "NQ", "GC", "YM", "RTY"];

    // 1. Get futures trade logs for current mode
    const allLogs = await prisma.autoTradeLog.findMany({
      where: { symbol: { in: modeSymbols } },
      orderBy: { createdAt: "asc" },
    });

    // 2. Get currently open positions from Tradovate
    const auth = await checkTradovateAuth(mode);
    let openSymbols: Set<string> = new Set();
    if (auth.authenticated) {
      const positions = await getTradovatePositions(mode);
      for (const pos of positions) {
        if (pos.netPos !== 0) {
          for (const sym of knownSymbols) {
            if (pos.contractName.startsWith(sym)) openSymbols.add(sym);
          }
        }
      }
    }

    // 3. Find entries without matching closes
    const entries = allLogs.filter(l => l.action === "futures_long" || l.action === "futures_short");
    const closes = allLogs.filter(l =>
      l.action.includes("stop_loss") || l.action.includes("take_profit") ||
      l.action.includes("trail_stop") || l.action.includes("breakeven") ||
      l.action.includes("scale_out") || l.action.includes("bracket_close")
    );

    // Match entries to closes by symbol + time ordering
    // For each symbol, pair entries with closes chronologically
    const symbolEntries: Record<string, typeof entries> = {};
    const symbolCloses: Record<string, typeof closes> = {};

    for (const e of entries) {
      const sym = e.symbol;
      if (!symbolEntries[sym]) symbolEntries[sym] = [];
      symbolEntries[sym].push(e);
    }
    for (const c of closes) {
      const sym = c.symbol;
      if (!symbolCloses[sym]) symbolCloses[sym] = [];
      symbolCloses[sym].push(c);
    }

    let backfilled = 0;
    const details: string[] = [];

    for (const sym of Object.keys(symbolEntries)) {
      const symEntries = symbolEntries[sym] || [];
      const symCloses = symbolCloses[sym] || [];
      const baseSym = sym.replace("FUT:", "");

      // For each entry, check if there's a close after it
      for (let i = 0; i < symEntries.length; i++) {
        const entry = symEntries[i];
        const entryTime = new Date(entry.createdAt).getTime();
        const nextEntry = symEntries[i + 1];
        const nextEntryTime = nextEntry ? new Date(nextEntry.createdAt).getTime() : Date.now();

        // Find a close between this entry and the next entry
        const matchingClose = symCloses.find(c => {
          const closeTime = new Date(c.createdAt).getTime();
          return closeTime > entryTime && closeTime < nextEntryTime;
        });

        if (matchingClose) continue; // Already has a close logged

        // Check if this position is currently open on Tradovate
        if (openSymbols.has(baseSym) && i === symEntries.length - 1) continue; // Latest entry, still open

        // This entry has no close and isn't currently open — it was closed by a bracket order
        // Parse stop and target from the entry's reason text
        const reason = entry.reason || "";
        const stopMatch = reason.match(/Stop:\s*\$?([\d,.]+)/);
        const targetMatch = reason.match(/Target:\s*\$?([\d,.]+)/);
        const stopPrice = stopMatch ? parseFloat(stopMatch[1].replace(",", "")) : null;
        const targetPrice = targetMatch ? parseFloat(targetMatch[1].replace(",", "")) : null;

        if (!stopPrice && !targetPrice) continue; // Can't determine close price

        const entryPrice = entry.price || 0;
        const isLong = entry.action === "futures_long";
        const mult = MULTIPLIERS[baseSym] || 5;
        const qty = entry.qty;

        // Estimate close: if there's a next entry at a worse price, probably stopped out
        // Otherwise check if P&L lines up with target
        // Simple heuristic: assume stop loss (conservative estimate)
        // We could check the next entry's time — if it was soon after, likely stopped out
        let closePrice: number;
        let closeType: string;

        if (nextEntry) {
          const timeDiff = nextEntryTime - entryTime;
          // If re-entered quickly (< 30 min), likely stopped out then re-entered
          if (timeDiff < 30 * 60 * 1000 && stopPrice) {
            closePrice = stopPrice;
            closeType = "stop_loss";
          } else if (targetPrice) {
            closePrice = targetPrice;
            closeType = "take_profit";
          } else {
            closePrice = stopPrice!;
            closeType = "stop_loss";
          }
        } else {
          // Last entry for this symbol, no longer open — assume stop
          closePrice = stopPrice || targetPrice!;
          closeType = stopPrice ? "stop_loss" : "take_profit";
        }

        const diff = isLong ? closePrice - entryPrice : entryPrice - closePrice;
        const pnl = diff * mult * qty;

        // Create close time: midway between entry and next entry (or 5 min after entry)
        const closeTime = nextEntry
          ? new Date(entryTime + Math.min(nextEntryTime - entryTime, 5 * 60 * 1000))
          : new Date(entryTime + 5 * 60 * 1000);

        await prisma.autoTradeLog.create({
          data: {
            symbol: sym,
            action: `futures_${closeType}`,
            qty,
            price: closePrice,
            pnl,
            reason: `[FUTURES ${baseSym}] ${closeType} (backfill): ${qty}x @ $${closePrice.toFixed(2)}. Entry: $${entryPrice.toFixed(2)}. P&L: $${pnl.toFixed(0)}`,
            orderId: null,
            createdAt: closeTime,
          },
        });

        backfilled++;
        details.push(`${baseSym} ${closeType}: ${qty}x @ $${closePrice.toFixed(2)} = ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}`);
      }
    }

    return Response.json({
      backfilled,
      details,
      totalEntries: entries.length,
      totalCloses: closes.length,
      openPositions: [...openSymbols],
    });
  } catch (error) {
    console.error("[/api/futures/backfill]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Backfill failed" },
      { status: 500 }
    );
  }
}
