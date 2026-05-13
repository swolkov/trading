import { prisma } from "@/lib/db";
import { checkTradovateAuth } from "@/lib/tradovate";

// Tradovate contract symbol → our symbol mapping
const CONTRACT_MAP: Record<string, string> = {
  MES: "MES", MNQ: "MNQ", MYM: "MYM", M2K: "M2K",
};
const MULTIPLIERS: Record<string, number> = {
  MES: 5, MNQ: 2, MYM: 0.5, M2K: 5,
};

function matchSymbol(contractName: string): string | null {
  for (const sym of Object.keys(CONTRACT_MAP)) {
    if (contractName.startsWith(sym)) return sym;
  }
  return null;
}

// Tradovate API fetch using auth from the lib
async function tvApiFetch(path: string): Promise<unknown> {
  const auth = await checkTradovateAuth();
  if (!auth.authenticated) throw new Error("Tradovate not connected");

  // We need a token — re-authenticate to get it
  const DEMO_URL = "https://demo.tradovateapi.com/v1";
  const res = await fetch(`${DEMO_URL}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: process.env.TRADOVATE_USERNAME || "",
      password: process.env.TRADOVATE_PASSWORD || "",
      appId: process.env.TRADOVATE_APP_ID || "",
      appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
      deviceId: "esbueno-backfill",
      cid: parseInt(process.env.TRADOVATE_CID || "0"),
      sec: process.env.TRADOVATE_SEC || "",
    }),
  });
  if (!res.ok) throw new Error("Auth failed");
  const data = await res.json();

  const apiRes = await fetch(`${DEMO_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.accessToken}`,
    },
  });
  if (!apiRes.ok) throw new Error(`API ${apiRes.status}`);
  return apiRes.json();
}

interface TvOrder {
  id: number;
  action: string; // "Buy" | "Sell"
  orderType: string; // "Market" | "Stop" | "Limit"
  orderQty: number;
  ordStatus: string; // "Filled" | "Working" | "Cancelled"
  contractId: number;
  fillPrice?: number;
  timestamp: string;
  isAutomated?: boolean;
}

interface TvFill {
  id: number;
  orderId: number;
  contractId: number;
  action: string;
  qty: number;
  price: number;
  timestamp: string;
}

interface TvContract {
  id: number;
  name: string;
}

export async function POST() {
  try {
    // Get all fills and orders from Tradovate
    const [fills, orders, contracts] = await Promise.all([
      tvApiFetch("/fill/list") as Promise<TvFill[]>,
      tvApiFetch("/order/list") as Promise<TvOrder[]>,
      tvApiFetch("/contract/list") as Promise<TvContract[]>,
    ]);

    // Build contract ID → symbol map
    const contractIdToSym: Record<number, string> = {};
    for (const c of contracts) {
      const sym = matchSymbol(c.name);
      if (sym) contractIdToSym[c.id] = sym;
    }

    // Get existing trade logs to avoid duplicates
    const existingLogs = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "FUT:" } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    // Find entry order IDs we already logged
    const loggedOrderIds = new Set(
      existingLogs.filter(l => l.orderId).map(l => l.orderId)
    );

    // Find close actions we already logged
    const loggedCloseActions = new Set(
      existingLogs
        .filter(l => l.action.includes("stop_loss") || l.action.includes("take_profit") ||
                     l.action.includes("trail_stop") || l.action.includes("breakeven") ||
                     l.action.includes("scale_out") || l.action.includes("bracket_close"))
        .map(l => `${l.symbol}:${l.price}:${l.createdAt.toISOString().slice(0, 16)}`)
    );

    // Group fills by order
    const fillsByOrder: Record<number, TvFill[]> = {};
    for (const fill of fills) {
      if (!fillsByOrder[fill.orderId]) fillsByOrder[fill.orderId] = [];
      fillsByOrder[fill.orderId].push(fill);
    }

    // Find filled orders that are our automated closes (Stop or Limit type, automated)
    const filledOrders = orders.filter(o =>
      o.ordStatus === "Filled" &&
      (o.orderType === "Stop" || o.orderType === "Limit") &&
      o.isAutomated
    );

    let backfilled = 0;
    const details: string[] = [];

    for (const order of filledOrders) {
      const sym = contractIdToSym[order.contractId];
      if (!sym) continue;

      const mult = MULTIPLIERS[sym] || 5;
      const orderFills = fillsByOrder[order.id] || [];
      if (orderFills.length === 0) continue;

      // Get fill price (average if multiple fills)
      const totalQty = orderFills.reduce((s, f) => s + f.qty, 0);
      const avgPrice = orderFills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty;
      const fillTime = orderFills[0].timestamp;

      // Check if we already logged this close
      const closeKey = `FUT:${sym}:${avgPrice.toFixed(2)}:${fillTime.slice(0, 16)}`;
      if (loggedCloseActions.has(closeKey)) continue;

      // Find the matching entry in our database
      const entry = existingLogs.find(l =>
        l.symbol === `FUT:${sym}` &&
        (l.action === "futures_long" || l.action === "futures_short") &&
        l.orderId &&
        new Date(l.createdAt) < new Date(fillTime)
      );

      if (!entry) continue;

      // Calculate P&L
      const entryPrice = entry.price || 0;
      const isLong = entry.action === "futures_long";
      const diff = isLong ? avgPrice - entryPrice : entryPrice - avgPrice;
      const pnl = diff * mult * totalQty;

      // Determine close type
      const closeType = order.orderType === "Stop" ? "stop_loss" : "take_profit";

      // Check for approximate duplicate (same symbol, similar price, similar time)
      const isDuplicate = existingLogs.some(l =>
        l.symbol === `FUT:${sym}` &&
        (l.action.includes("stop_loss") || l.action.includes("take_profit") || l.action.includes("bracket_close")) &&
        l.price && Math.abs(l.price - avgPrice) < 1 &&
        Math.abs(new Date(l.createdAt).getTime() - new Date(fillTime).getTime()) < 120000
      );
      if (isDuplicate) continue;

      // Create the missing close log
      await prisma.autoTradeLog.create({
        data: {
          symbol: `FUT:${sym}`,
          action: `futures_${closeType}`,
          qty: totalQty,
          price: avgPrice,
          pnl,
          reason: `[FUTURES ${sym}] ${closeType} (backfill): Closed ${totalQty}x @ $${avgPrice.toFixed(2)}. Entry: $${entryPrice.toFixed(2)}. P&L: $${pnl.toFixed(0)}`,
          orderId: String(order.id),
          createdAt: new Date(fillTime),
        },
      });

      backfilled++;
      details.push(`${sym} ${closeType}: ${totalQty}x @ $${avgPrice.toFixed(2)} = ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}`);
    }

    return Response.json({
      backfilled,
      details,
      totalFills: fills.length,
      totalOrders: filledOrders.length,
    });
  } catch (error) {
    console.error("[/api/futures/backfill]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Backfill failed" },
      { status: 500 }
    );
  }
}
