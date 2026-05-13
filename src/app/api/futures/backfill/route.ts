import { prisma } from "@/lib/db";

const DEMO_URL = "https://demo.tradovateapi.com/v1";
const MULTIPLIERS: Record<string, number> = {
  MES: 5, MNQ: 2, MYM: 0.5, M2K: 5,
};

function matchSymbol(name: string): string | null {
  for (const sym of ["MES", "MNQ", "MYM", "M2K"]) {
    if (name.startsWith(sym)) return sym;
  }
  return null;
}

async function tvAuth(): Promise<string> {
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
  if (!res.ok) throw new Error("Tradovate auth failed");
  const data = await res.json();
  return data.accessToken;
}

async function tvGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${DEMO_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tradovate ${path} → ${res.status}`);
  return res.json();
}

interface TvOrder {
  id: number;
  contractId: number;
  action: string;
  orderType: string;
  orderQty: number;
  ordStatus: string;
  avgFillPrice?: number;
  filledQty?: number;
  timestamp: string;
  isAutomated?: boolean;
}

export const maxDuration = 60;

export async function POST() {
  try {
    const token = await tvAuth();

    // Get all orders from Tradovate
    const orders = await tvGet(token, "/order/list") as TvOrder[];

    // Get existing trade logs
    const existingLogs = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "FUT:" } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const entryLogs = existingLogs.filter(l =>
      l.action === "futures_long" || l.action === "futures_short"
    );

    // Build contractId → symbol map from our DB entries matched to Market orders
    const contractIdToSym: Record<number, string> = {};
    for (const eo of orders.filter(o => o.orderType === "Market" && o.isAutomated)) {
      if (contractIdToSym[eo.contractId]) continue;
      // Match by order ID in our DB
      const dbEntry = entryLogs.find(l => l.orderId === String(eo.id));
      if (dbEntry) {
        contractIdToSym[eo.contractId] = dbEntry.symbol.replace("FUT:", "");
        continue;
      }
      // Fallback: resolve contract name from Tradovate
      try {
        const item = await tvGet(token, `/contract/item?id=${eo.contractId}`) as { name: string };
        const sym = matchSymbol(item.name);
        if (sym) contractIdToSym[eo.contractId] = sym;
      } catch {}
    }

    // Set of already-logged order IDs
    const loggedOrderIds = new Set(existingLogs.filter(l => l.orderId).map(l => l.orderId));

    // Find filled bracket orders (Stop/Limit, automated) not yet in our DB
    const filledBrackets = orders.filter(o =>
      o.ordStatus === "Filled" &&
      (o.orderType === "Stop" || o.orderType === "Limit") &&
      o.isAutomated &&
      o.avgFillPrice &&
      o.avgFillPrice > 0 &&
      !loggedOrderIds.has(String(o.id))
    );

    let backfilled = 0;
    const details: string[] = [];

    for (const order of filledBrackets) {
      const sym = contractIdToSym[order.contractId];
      if (!sym) continue;

      const mult = MULTIPLIERS[sym] || 5;
      const fillPrice = order.avgFillPrice!;
      const fillQty = order.filledQty || order.orderQty;
      const fillTime = order.timestamp;

      // Check for approximate duplicate
      const isDup = existingLogs.some(l =>
        l.symbol === `FUT:${sym}` &&
        !l.action.includes("long") && !l.action.includes("short") &&
        l.price && Math.abs(l.price - fillPrice) < 2 &&
        Math.abs(new Date(l.createdAt).getTime() - new Date(fillTime).getTime()) < 300000
      );
      if (isDup) continue;

      // Find matching entry — most recent entry for this symbol before the fill
      const entry = entryLogs.find(l =>
        l.symbol === `FUT:${sym}` &&
        new Date(l.createdAt) < new Date(fillTime)
      );
      if (!entry) continue;

      const entryPrice = entry.price || 0;
      const isLong = entry.action === "futures_long";
      const diff = isLong ? fillPrice - entryPrice : entryPrice - fillPrice;
      const pnl = diff * mult * fillQty;
      const closeType = order.orderType === "Stop" ? "stop_loss" : "take_profit";

      await prisma.autoTradeLog.create({
        data: {
          symbol: `FUT:${sym}`,
          action: `futures_${closeType}`,
          qty: fillQty,
          price: fillPrice,
          pnl,
          reason: `[FUTURES ${sym}] ${closeType} (backfill): ${fillQty}x @ $${fillPrice.toFixed(2)}. Entry: $${entryPrice.toFixed(2)}. P&L: $${pnl.toFixed(0)}`,
          orderId: String(order.id),
          createdAt: new Date(fillTime),
        },
      });

      backfilled++;
      details.push(`${sym} ${closeType}: ${fillQty}x @ $${fillPrice.toFixed(2)} = ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}`);
    }

    return Response.json({
      backfilled,
      details,
      filledBrackets: filledBrackets.length,
      totalOrders: orders.length,
      contractMap: contractIdToSym,
    });
  } catch (error) {
    console.error("[/api/futures/backfill]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Backfill failed" },
      { status: 500 }
    );
  }
}
