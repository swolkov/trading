import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { checkTradovateAuth, getTradovatePositions, getCashBalanceLogs, getTradovateAccountSummary } from "@/lib/tradovate";

const MULTIPLIERS: Record<string, number> = {
  MES: 5, MNQ: 2, MGC: 10, MYM: 0.5, M2K: 5,
};

export const maxDuration = 60;

// PUT: Auto-pull daily balance history from Tradovate cash balance logs + fill-based reconstruction
// Also accepts manual overrides: { balances: [{ date: "2026-05-14", balance: 51800 }] }
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const results: string[] = [];

    // 1. If manual balances provided, seed them
    const manualBalances: { date: string; balance: number }[] = body.balances || [];
    for (const { date, balance } of manualBalances) {
      if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
      await prisma.agentConfig.upsert({
        where: { key: `daily_balance_${date}` },
        update: { value: String(balance) },
        create: { key: `daily_balance_${date}`, value: String(balance) },
      });
      results.push(`manual: ${date} = $${balance.toLocaleString()}`);
    }

    // 2. Auto-pull from Tradovate cash balance logs
    const auth = await checkTradovateAuth();
    if (!auth.authenticated) {
      return Response.json({ seeded: results.length, details: results, error: "Tradovate not connected — only manual balances seeded" });
    }

    // Get current balance as today's snapshot
    const account = await getTradovateAccountSummary();
    const today = new Date().toISOString().slice(0, 10);
    await prisma.agentConfig.upsert({
      where: { key: `daily_balance_${today}` },
      update: { value: String(account.balance) },
      create: { key: `daily_balance_${today}`, value: String(account.balance) },
    });
    results.push(`today: ${today} = $${account.balance.toLocaleString()} (live)`);

    // Try cash balance logs for historical daily settlement data
    const cashLogs = await getCashBalanceLogs();
    if (cashLogs.length > 0) {
      for (const log of cashLogs) {
        const date = `${log.tradeDate.year}-${String(log.tradeDate.month).padStart(2, "0")}-${String(log.tradeDate.day).padStart(2, "0")}`;
        // amount = account balance at that settlement
        await prisma.agentConfig.upsert({
          where: { key: `daily_balance_${date}` },
          update: { value: String(log.amount) },
          create: { key: `daily_balance_${date}`, value: String(log.amount) },
        });
        // Also save as EOD balance
        await prisma.agentConfig.upsert({
          where: { key: `eod_balance_${date}` },
          update: { value: String(log.amount) },
          create: { key: `eod_balance_${date}`, value: String(log.amount) },
        });
        results.push(`tradovate: ${date} = $${log.amount.toLocaleString()} (settlement, realized: $${log.realizedPnL})`);
      }
    } else {
      // Fallback: reconstruct from fills + current balance (work backwards)
      // Get all futures trade logs with P&L and reconstruct daily balances
      const tradeLogs = await prisma.autoTradeLog.findMany({
        where: { symbol: { startsWith: "FUT:" }, pnl: { not: null } },
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
      const dates = Object.keys(dailyPnls).sort().reverse();
      let runningBalance = account.balance;
      for (const date of dates) {
        if (date === today) continue; // already saved
        // Start-of-day balance = end-of-day balance - that day's P&L
        // end-of-day balance = start of next day = runningBalance
        const eodBalance = runningBalance;
        const sodBalance = eodBalance - dailyPnls[date];
        await prisma.agentConfig.upsert({
          where: { key: `daily_balance_${date}` },
          update: { value: String(sodBalance) },
          create: { key: `daily_balance_${date}`, value: String(sodBalance) },
        });
        await prisma.agentConfig.upsert({
          where: { key: `eod_balance_${date}` },
          update: { value: String(eodBalance) },
          create: { key: `eod_balance_${date}`, value: String(eodBalance) },
        });
        results.push(`reconstructed: ${date} SOD=$${sodBalance.toFixed(0)} EOD=$${eodBalance.toFixed(0)} (day P&L: $${dailyPnls[date].toFixed(0)})`);
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
    // 1. Get all futures trade logs
    const allLogs = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "FUT:" } },
      orderBy: { createdAt: "asc" },
    });

    // 2. Get currently open positions from Tradovate
    const auth = await checkTradovateAuth();
    let openSymbols: Set<string> = new Set();
    if (auth.authenticated) {
      const positions = await getTradovatePositions();
      for (const pos of positions) {
        if (pos.netPos !== 0) {
          for (const sym of ["MES", "MNQ", "MYM", "M2K"]) {
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
