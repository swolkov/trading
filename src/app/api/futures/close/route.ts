import { checkTradovateAuth, getTradovatePositions } from "@/lib/tradovate";
import { prisma } from "@/lib/db";

const DEMO_URL = "https://demo.tradovateapi.com/v1";
const MULTIPLIERS: Record<string, number> = { MES: 5, MNQ: 2, MYM: 0.5, M2K: 5 };

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const targetSymbol = body.symbol || "all"; // "MNQ", "MES", or "all"

    const auth = await checkTradovateAuth();
    if (!auth.authenticated) {
      return Response.json({ error: "Tradovate not connected" }, { status: 400 });
    }

    // Get fresh token
    const tokenRes = await fetch(`${DEMO_URL}/auth/accesstokenrequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: process.env.TRADOVATE_USERNAME || "",
        password: process.env.TRADOVATE_PASSWORD || "",
        appId: process.env.TRADOVATE_APP_ID || "",
        appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
        deviceId: "esbueno-manual-close",
        cid: parseInt(process.env.TRADOVATE_CID || "0"),
        sec: process.env.TRADOVATE_SEC || "",
      }),
    });
    if (!tokenRes.ok) return Response.json({ error: "Auth failed" }, { status: 500 });
    const tokenData = await tokenRes.json();
    const token = tokenData.accessToken;

    // Get accounts
    const acctRes = await fetch(`${DEMO_URL}/account/list`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const accounts = await acctRes.json() as { id: number; name: string }[];
    const acct = accounts[0];

    // Get positions
    const positions = await getTradovatePositions();
    const openPos = positions.filter(p => p.netPos !== 0);

    const closed: string[] = [];

    for (const pos of openPos) {
      // Match symbol
      let sym = "";
      for (const s of ["MES", "MNQ", "MYM", "M2K"]) {
        if (pos.contractName.startsWith(s)) { sym = s; break; }
      }
      if (!sym) continue;
      if (targetSymbol !== "all" && sym !== targetSymbol.toUpperCase()) continue;

      const direction = pos.netPos > 0 ? "long" : "short";
      const qty = Math.abs(pos.netPos);
      const closeSide = direction === "long" ? "Sell" : "Buy";
      const mult = MULTIPLIERS[sym] || 5;

      // Get a live quote for P&L calculation
      let closePrice = pos.netPrice;
      try {
        const YF = require("yahoo-finance2").default || require("yahoo-finance2");
        const yf = new YF({ suppressNotices: ["ripHistorical"] });
        const yahooSymbols: Record<string, string> = { MES: "ES=F", MNQ: "NQ=F", MYM: "YM=F", M2K: "RTY=F" };
        const q = await yf.quote(yahooSymbols[sym] || "ES=F");
        if (q?.regularMarketPrice) closePrice = q.regularMarketPrice;
      } catch {}

      // Market close
      const orderRes = await fetch(`${DEMO_URL}/order/placeorder`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          accountSpec: acct.name, accountId: acct.id, action: closeSide,
          symbol: pos.contractId, orderQty: qty, orderType: "Market",
          timeInForce: "Day", isAutomated: true,
        }),
      });
      const orderData = await orderRes.json().catch(() => ({})) as { orderId?: number };

      // Calculate P&L from entry to current price
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
            orderId: orderData.orderId ? String(orderData.orderId) : null,
          },
        });
      } catch {}
    }

    // Cancel working orders ONLY for the closed symbols (not all orders!)
    try {
      const ordersRes = await fetch(`${DEMO_URL}/order/list`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const orders = await ordersRes.json() as { id: number; ordStatus: string; contractId?: number }[];
      const closedContractIds = new Set(openPos
        .filter(p => {
          let sym = "";
          for (const s of ["MES", "MNQ", "MYM", "M2K"]) {
            if (p.contractName.startsWith(s)) { sym = s; break; }
          }
          return targetSymbol === "all" || sym === targetSymbol.toUpperCase();
        })
        .map(p => p.contractId));
      const working = orders.filter(o =>
        (o.ordStatus === "Working" || o.ordStatus === "Accepted") &&
        (targetSymbol === "all" || (o.contractId != null && closedContractIds.has(o.contractId)))
      );
      for (const order of working) {
        try {
          await fetch(`${DEMO_URL}/order/cancelorder`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ orderId: order.id }),
          });
        } catch {}
      }
      if (working.length > 0) closed.push(`Cancelled ${working.length} orders for ${targetSymbol}`);
    } catch {}

    return Response.json({ closed, count: closed.length });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
