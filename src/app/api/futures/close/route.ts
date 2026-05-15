import { checkTradovateAuth, getTradovatePositions, placeMarketOrder, getOpenOrders, cancelOrder, getTradovateFills } from "@/lib/tradovate";
import { prisma } from "@/lib/db";
import { logTradeToJournal, logDecision } from "@/lib/vault";

const MULTIPLIERS: Record<string, number> = { MES: 5, MNQ: 2, MGC: 10, MYM: 0.5, M2K: 5 };

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const targetSymbol = body.symbol || "all"; // "MNQ", "MES", or "all"

    const auth = await checkTradovateAuth();
    if (!auth.authenticated) {
      return Response.json({ error: "Tradovate not connected" }, { status: 400 });
    }

    // Get positions via centralized client (with timeout, rate limit, token refresh)
    const positions = await getTradovatePositions();
    const openPos = positions.filter(p => p.netPos !== 0);

    const closed: string[] = [];

    for (const pos of openPos) {
      // Match symbol
      let sym = "";
      for (const s of ["MES", "MNQ", "MGC", "MYM", "M2K"]) {
        if (pos.contractName.startsWith(s)) { sym = s; break; }
      }
      if (!sym) continue;
      if (targetSymbol !== "all" && sym !== targetSymbol.toUpperCase()) continue;

      const direction = pos.netPos > 0 ? "long" : "short";
      const qty = Math.abs(pos.netPos);
      const mult = MULTIPLIERS[sym] || 5;

      // Get a live quote for P&L calculation
      let closePrice = pos.netPrice;
      try {
        const YF = require("yahoo-finance2").default || require("yahoo-finance2");
        const yf = new YF({ suppressNotices: ["ripHistorical"] });
        const yahooSymbols: Record<string, string> = { MES: "ES=F", MNQ: "NQ=F", MGC: "GC=F", MYM: "YM=F", M2K: "RTY=F" };
        const q = await yf.quote(yahooSymbols[sym] || "ES=F");
        if (q?.regularMarketPrice) closePrice = q.regularMarketPrice;
      } catch {}

      // Market close via centralized client (has timeout, rate limit handling)
      let orderId: number | null = null;
      try {
        const result = await placeMarketOrder({
          contractId: pos.contractId,
          action: direction === "long" ? "Sell" : "Buy",
          quantity: qty,
        });
        orderId = result.orderId;
      } catch (err) {
        closed.push(`FAILED to close ${sym} ${direction} ${qty}x: ${err}`);
        continue;
      }

      // Get ACTUAL fill price from Tradovate
      if (orderId) {
        try {
          await new Promise(r => setTimeout(r, 1500));
          const fills = await getTradovateFills();
          const myFills = fills.filter(f => f.orderId === orderId);
          if (myFills.length > 0) {
            const totalQty = myFills.reduce((s, f) => s + f.qty, 0);
            closePrice = myFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty;
          }
        } catch { /* keep Yahoo quote as fallback */ }
      }

      // Calculate P&L from entry to ACTUAL fill price
      const entryPrice = pos.netPrice;
      const priceDiff = direction === "long" ? closePrice - entryPrice : entryPrice - closePrice;
      const pnl = priceDiff * mult * qty;

      closed.push(`Closed ${sym} ${direction} ${qty}x @ $${closePrice.toFixed(2)} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}`);

      // Log to DB with actual P&L
      try {
        await prisma.autoTradeLog.create({
          data: {
            symbol: `FUT:${sym}`,
            action: "futures_manual_close",
            qty,
            price: closePrice,
            pnl: Math.round(pnl * 100) / 100,
            reason: `[FUTURES ${sym}] Manual close: ${qty}x ${direction} @ $${closePrice.toFixed(2)}. Entry: $${entryPrice.toFixed(2)}. P&L: $${pnl.toFixed(0)}`,
            orderId: orderId ? String(orderId) : null,
          },
        });
      } catch {}

      // Log to Obsidian vault
      try {
        await logTradeToJournal({
          tradeId: `${new Date().toISOString().slice(0, 10)}-MANUAL-${sym}`,
          timestamp: new Date().toISOString(),
          instrument: `FUT:${sym}`,
          direction: direction === "long" ? "LONG" : "SHORT",
          strategy: "futures-scalping",
          setupType: "manual_close",
          contracts: qty,
          entryPrice,
          stopPrice: 0,
          targetPrice: 0,
          exitPrice: closePrice,
          pnlDollars: pnl,
          conviction: 3,
          exitReason: "manual_close",
        }, "manual");
        await logDecision("manual", "EXIT", `FUT:${sym}`, `Manual close: ${qty}x ${direction} @ $${closePrice.toFixed(2)}. P&L: $${pnl.toFixed(0)}`, pnl > 0 ? 4 : 2);
      } catch { /* vault optional */ }
    }

    // Cancel working orders for closed symbols via centralized client
    try {
      const orders = await getOpenOrders();
      const closedContractIds = new Set(openPos
        .filter(p => {
          let sym = "";
          for (const s of ["MES", "MNQ", "MGC", "MYM", "M2K"]) {
            if (p.contractName.startsWith(s)) { sym = s; break; }
          }
          return targetSymbol === "all" || sym === targetSymbol.toUpperCase();
        })
        .map(p => p.contractId));
      const working = orders.filter(o =>
        targetSymbol === "all" || (o.contractId != null && closedContractIds.has(o.contractId))
      );
      for (const order of working) {
        try { await cancelOrder(order.id); } catch {}
      }
      if (working.length > 0) closed.push(`Cancelled ${working.length} orders for ${targetSymbol}`);
    } catch {}

    return Response.json({ closed, count: closed.length });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
