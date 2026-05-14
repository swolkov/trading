import { prisma } from "@/lib/db";
import { checkTradovateAuth, getTradovatePositions } from "@/lib/tradovate";

const MULTIPLIERS: Record<string, number> = {
  MES: 5, MNQ: 2, MGC: 10, MYM: 0.5, M2K: 5,
};

export const maxDuration = 60;

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
