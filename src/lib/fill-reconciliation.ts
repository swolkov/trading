// ============ TRADOVATE FILL RECONCILIATION ============
// Fetches actual fills from Tradovate, matches against DB logs,
// and backfills missing trades with correct P&L.
// This is the source of truth — Tradovate > DB estimates.

import { prisma } from "./db";
import { getTradovateFills, checkTradovateAuth, TRADOVATE_CONTRACTS, resolveContractSymbol, type TradovateFill } from "./tradovate";
import { logTradeToJournal, logDecision } from "./vault";

// Contract ID → symbol mapping (populated from fills + known contracts)
async function buildContractMap(fills: TradovateFill[]): Promise<Record<number, string>> {
  const map: Record<number, string> = {};

  // Get contract names from existing DB logs that have orderId
  const knownLogs = await prisma.autoTradeLog.findMany({
    where: { symbol: { startsWith: "FUT:" }, orderId: { not: null } },
    select: { symbol: true, orderId: true },
    distinct: ["symbol"],
  });
  // orderId might contain contract info — but mainly we rely on contract API

  // Try to identify from existing fills
  // Tradovate fills have contractId — we need to map to MES/MNQ/MYM/M2K
  // The simplest approach: fetch contract details for each unique contractId
  const uniqueContractIds = [...new Set(fills.map((f) => f.contractId))];

  for (const cid of uniqueContractIds) {
    // Check if any DB entry already maps this
    const existing = knownLogs.find((l) => l.orderId?.includes(String(cid)));
    if (existing) {
      map[cid] = existing.symbol.replace("FUT:", "");
      continue;
    }
  }

  return map;
}

// Match symbol from contract name string (e.g., "MESM5" -> "MES")
function matchSymbolFromName(name: string): string | null {
  for (const sym of Object.keys(TRADOVATE_CONTRACTS)) {
    if (name.startsWith(sym)) return sym;
  }
  return null;
}

interface RoundTrip {
  symbol: string;
  direction: "long" | "short";
  entryFill: TradovateFill;
  exitFill: TradovateFill;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
}

// Match fills into round-trip trades
function matchFillsToRoundTrips(fills: TradovateFill[], contractMap: Record<number, string>): RoundTrip[] {
  const roundTrips: RoundTrip[] = [];

  // Group fills by contractId
  const byContract: Record<number, TradovateFill[]> = {};
  for (const f of fills) {
    if (!byContract[f.contractId]) byContract[f.contractId] = [];
    byContract[f.contractId].push(f);
  }

  for (const [contractIdStr, contractFills] of Object.entries(byContract)) {
    const contractId = parseInt(contractIdStr);
    const sym = contractMap[contractId] || "UNKNOWN";
    const multiplier = TRADOVATE_CONTRACTS[sym]?.multiplier || 5;

    // Sort by timestamp
    const sorted = [...contractFills].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // FIFO matching: Buy opens, Sell closes (or vice versa for shorts)
    let position = 0; // positive = long, negative = short
    let entryFills: TradovateFill[] = [];

    for (const fill of sorted) {
      const fillQty = fill.action === "Buy" ? fill.qty : -fill.qty;

      if (position === 0) {
        // Opening a new position
        position = fillQty;
        entryFills = [fill];
      } else if ((position > 0 && fillQty < 0) || (position < 0 && fillQty > 0)) {
        // Closing (partially or fully)
        const closeQty = Math.min(Math.abs(position), Math.abs(fillQty));
        const direction = position > 0 ? "long" : "short";
        // Use volume-weighted average entry price across all entry fills
        const totalEntryQty = entryFills.reduce((s, f) => s + Math.abs(f.qty), 0);
        const entryPrice = totalEntryQty > 0
          ? entryFills.reduce((s, f) => s + f.price * Math.abs(f.qty), 0) / totalEntryQty
          : entryFills[0]?.price || 0;
        const exitPrice = fill.price;

        const priceDiff = direction === "long"
          ? exitPrice - entryPrice
          : entryPrice - exitPrice;
        const pnl = priceDiff * multiplier * closeQty;

        roundTrips.push({
          symbol: sym,
          direction,
          entryFill: entryFills[0],
          exitFill: fill,
          entryPrice,
          exitPrice,
          qty: closeQty,
          pnl,
          entryTime: entryFills[0]?.timestamp || fill.timestamp,
          exitTime: fill.timestamp,
        });

        const oldPosition = position;
        position += fillQty;
        if (position === 0) {
          entryFills = [];
        } else if (Math.sign(position) !== Math.sign(oldPosition)) {
          // Flipped direction — new entry with remaining qty
          entryFills = [fill];
        }
      } else {
        // Adding to position
        position += fillQty;
        entryFills.push(fill);
      }
    }
  }

  return roundTrips;
}

export interface ReconciliationResult {
  totalFills: number;
  roundTrips: number;
  alreadyLogged: number;
  backfilled: number;
  pnlCorrections: number;
  tradovatePnl: number;
  dbPnl: number;
  pnlGap: number;
  details: string[];
}

export async function reconcileFills(modeOverride?: "paper" | "live"): Promise<ReconciliationResult> {
  const details: string[] = [];
  const result: ReconciliationResult = {
    totalFills: 0,
    roundTrips: 0,
    alreadyLogged: 0,
    backfilled: 0,
    pnlCorrections: 0,
    tradovatePnl: 0,
    dbPnl: 0,
    pnlGap: 0,
    details,
  };

  try {
    // 1. Check auth
    const auth = await checkTradovateAuth(modeOverride);
    if (!auth.authenticated) {
      details.push("Tradovate not connected — skipping reconciliation");
      return result;
    }

    // 2. Fetch all fills from Tradovate
    const fills = await getTradovateFills(modeOverride);
    result.totalFills = fills.length;
    details.push(`Fetched ${fills.length} fills from Tradovate`);

    if (fills.length === 0) {
      details.push("No fills to reconcile");
      return result;
    }

    // 3. Build contract map — try to resolve contract IDs to symbols
    // First, try fetching contract details from Tradovate for each unique contractId
    const contractMap: Record<number, string> = {};
    const uniqueContractIds = [...new Set(fills.map((f) => f.contractId))];

    // Try to get contract names from Tradovate API (via positions or direct lookup)
    // For now, use the fills themselves — if we can't resolve, mark as UNKNOWN
    // We'll also check DB for any existing mappings
    const dbLogs = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "FUT:" } },
      orderBy: { createdAt: "desc" },
    });

    // Try to match fills to DB logs by orderId to learn contract mappings
    for (const log of dbLogs) {
      if (log.orderId) {
        const matchingFill = fills.find((f) => String(f.orderId) === log.orderId);
        if (matchingFill) {
          const sym = log.symbol.replace("FUT:", "");
          contractMap[matchingFill.contractId] = sym;
        }
      }
    }

    // Resolve unmapped contracts via Tradovate API
    for (const cid of uniqueContractIds) {
      if (!contractMap[cid]) {
        const resolved = await resolveContractSymbol(cid, modeOverride);
        contractMap[cid] = resolved || "UNKNOWN";
      }
    }

    details.push(`Contract map: ${JSON.stringify(contractMap)}`);

    // 4. Match fills into round-trip trades
    const roundTrips = matchFillsToRoundTrips(fills, contractMap);
    result.roundTrips = roundTrips.length;
    result.tradovatePnl = roundTrips.reduce((s, rt) => s + rt.pnl, 0);
    details.push(`Matched ${roundTrips.length} round-trip trades, total P&L: $${result.tradovatePnl.toFixed(2)}`);

    // 5. Get existing DB exit trades for comparison (including pnl: null from deferred logging)
    const exitActions = ["futures_stop_loss", "futures_take_profit", "futures_trail_stop", "futures_breakeven",
      "futures_emergency", "futures_bracket_close", "futures_manual_close", "futures_scale_out",
      "live_stop_loss", "live_take_profit", "live_trail_stop", "live_breakeven",
      "live_emergency", "live_bracket_close", "live_manual_close", "live_scale_out"];
    const existingExits = dbLogs.filter((l) => exitActions.includes(l.action) || l.pnl != null);
    result.dbPnl = existingExits.filter(l => l.pnl != null).reduce((s, l) => s + (l.pnl || 0), 0);
    result.pnlGap = result.tradovatePnl - result.dbPnl;
    details.push(`DB logged P&L: $${result.dbPnl.toFixed(2)}, gap: $${result.pnlGap.toFixed(2)}`);

    // 6. For each round trip, check if we have a matching exit in the DB
    for (const rt of roundTrips) {
      // Try to find a matching DB exit log
      const exitTime = new Date(rt.exitTime);
      const timeWindow = 5 * 60 * 1000; // 5 minute window

      // Match by orderId (exact) first, then by time window + symbol (fuzzy)
      const matchingExit = existingExits.find((log) => {
        // Exact match: same orderId from Tradovate fill
        if (log.orderId && log.orderId === String(rt.exitFill.orderId)) return true;
        // Fuzzy match: symbol + time window
        const logTime = log.createdAt.getTime();
        const sym = log.symbol.replace("FUT:", "");
        return (
          sym === rt.symbol &&
          Math.abs(logTime - exitTime.getTime()) < timeWindow
        );
      });

      if (matchingExit) {
        result.alreadyLogged++;

        // Skip if already reconciled with fill data
        if (matchingExit.reconciledAt) continue;

        // CORRECT P&L if: null (deferred), or materially wrong (>$5 AND >10%)
        const dbPnl = matchingExit.pnl;
        const fillPnl = rt.pnl;
        const needsCorrection = dbPnl == null || (() => {
          const diff = Math.abs((dbPnl || 0) - fillPnl);
          const magnitude = Math.max(Math.abs(fillPnl), Math.abs(dbPnl || 0), 1);
          return diff > 5 && diff / magnitude > 0.10;
        })();

        if (needsCorrection) {
          try {
            await prisma.autoTradeLog.update({
              where: { id: matchingExit.id },
              data: {
                pnl: fillPnl,
                price: rt.exitPrice,
                fillPrice: rt.exitPrice,
                reconciledAt: new Date(),
                originalPnl: dbPnl ?? matchingExit.originalPnl, // preserve first estimate
                reason: matchingExit.reason + ` [CORRECTED: ${dbPnl != null ? `was $${dbPnl.toFixed(0)}` : "was pending"}, actual $${fillPnl.toFixed(0)} from fill #${rt.exitFill.id}]`,
              },
            });
            result.pnlCorrections++;
            details.push(
              `CORRECTED: ${rt.symbol} #${matchingExit.id} P&L ${dbPnl != null ? `$${dbPnl.toFixed(0)}` : "null"} → $${fillPnl.toFixed(0)} (fill #${rt.exitFill.id})`
            );

            // Correct pattern memory if win/loss classification changed
            const oldOutcome = dbPnl != null ? (dbPnl > 0 ? "win" : "loss") : null;
            const newOutcome: "win" | "loss" = fillPnl > 0 ? "win" : "loss";
            if (oldOutcome && oldOutcome !== newOutcome) {
              try {
                const { correctPattern } = await import("./pattern-memory");
                const sym = matchingExit.symbol.replace("FUT:", "");
                const direction = matchingExit.action.includes("long") || matchingExit.action.includes("buy") ? "long" : "short";
                const stopDist = rt.entryPrice > 0 ? Math.abs(rt.exitPrice - rt.entryPrice) : 1;
                await correctPattern(sym, direction as "long" | "short", oldOutcome as "win" | "loss", newOutcome, fillPnl / (stopDist * (TRADOVATE_CONTRACTS[sym]?.multiplier || 5)));
                details.push(`  → Pattern corrected: ${oldOutcome} → ${newOutcome}`);
              } catch { /* pattern correction optional */ }
            }
          } catch (err) {
            details.push(`CORRECTION FAILED: ${rt.symbol} #${matchingExit.id}: ${err}`);
          }
        }
      } else {
        // Missing exit — backfill it
        const exitAction = rt.pnl >= 0 ? "take_profit" : "stop_loss";
        const newLog = await prisma.autoTradeLog.create({
          data: {
            symbol: `FUT:${rt.symbol}`,
            action: `futures_${exitAction}`,
            qty: rt.qty,
            price: rt.exitPrice,
            pnl: rt.pnl,
            reason: `[RECONCILED] ${rt.direction.toUpperCase()} ${rt.qty}x ${rt.symbol} @ $${rt.entryPrice.toFixed(2)} → $${rt.exitPrice.toFixed(2)}. Fill ID: ${rt.exitFill.id}`,
            orderId: String(rt.exitFill.orderId),
            createdAt: exitTime,
          },
        });
        result.backfilled++;
        details.push(
          `Backfilled: ${rt.symbol} ${exitAction} ${rt.qty}x @ $${rt.exitPrice.toFixed(2)}, P&L: $${rt.pnl.toFixed(0)} (fill ${rt.exitFill.id})`
        );

        // Also log to vault journal
        try {
          await logTradeToJournal({
            tradeId: `RECON-${rt.exitFill.id}`,
            timestamp: rt.exitTime,
            instrument: rt.symbol,
            direction: rt.direction === "long" ? "LONG" : "SHORT",
            strategy: "futures-scalping",
            setupType: exitAction,
            contracts: rt.qty,
            entryPrice: rt.entryPrice,
            stopPrice: 0,
            targetPrice: 0,
            exitPrice: rt.exitPrice,
            pnlDollars: rt.pnl,
            conviction: 0,
            exitReason: `Reconciled from Tradovate fill #${rt.exitFill.id}`,
          }, "reconciliation-agent");
        } catch { /* vault write is best-effort */ }
      }
    }

    // 7. Also check for entries that are in Tradovate but not in DB
    const entryFillIds = new Set(roundTrips.map((rt) => rt.entryFill.id));
    for (const rt of roundTrips) {
      const entryTime = new Date(rt.entryTime);
      const timeWindow = 5 * 60 * 1000;

      const matchingEntry = dbLogs.find((log) => {
        const logTime = log.createdAt.getTime();
        const sym = log.symbol.replace("FUT:", "");
        return (
          sym === rt.symbol &&
          Math.abs(logTime - entryTime.getTime()) < timeWindow &&
          (log.action === "futures_long" || log.action === "futures_short") &&
          log.pnl == null
        );
      });

      if (!matchingEntry) {
        // Missing entry — backfill
        await prisma.autoTradeLog.create({
          data: {
            symbol: `FUT:${rt.symbol}`,
            action: rt.direction === "long" ? "futures_long" : "futures_short",
            qty: rt.qty,
            price: rt.entryPrice,
            pnl: null,
            reason: `[RECONCILED] Entry ${rt.direction.toUpperCase()} ${rt.qty}x @ $${rt.entryPrice.toFixed(2)}. Fill ID: ${rt.entryFill.id}`,
            orderId: String(rt.entryFill.orderId),
            createdAt: entryTime,
          },
        });
        details.push(`Backfilled entry: ${rt.symbol} ${rt.direction} ${rt.qty}x @ $${rt.entryPrice.toFixed(2)}`);
      }
    }

    details.push(`\nReconciliation complete: ${result.backfilled} backfilled, ${result.pnlCorrections} corrected, ${result.alreadyLogged} already accurate`);

    return result;
  } catch (error) {
    details.push(`Reconciliation error: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
}
