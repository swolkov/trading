import { prisma } from "@/lib/db";
import { pairBase } from "@/lib/kraken-pairs";

// Real order/fill history — every actual Kraken execution from kraken_my_trades (synced from
// TradesHistory), newest first. Replaced the retired trend-bot event log Aug 31 2026. Read-only.
// This is the raw-fills companion to the Margin Cockpit's round-trip Track Record.
export const dynamic = "force-dynamic";

interface Fill {
  symbol: string;
  action: string;       // "buy" | "sell"
  price: number;
  vol: number;          // filled size in the base asset
  notional: number;     // USD value of the fill (Kraken `cost`)
  fee: number;          // fee paid on this fill (USD)
  leveraged: boolean;   // margin fill (margin > 0) vs plain spot
  time: string;
}

export async function GET() {
  try {
    const rows = await prisma.$queryRawUnsafe<{
      time: Date; pair: string; type: string; price: number; vol: number; cost: number; fee: number; margin: number;
    }[]>(
      `SELECT time, pair, type, price, vol, cost, fee, COALESCE(margin, 0) AS margin
       FROM kraken_my_trades ORDER BY time DESC LIMIT 500`,
    );

    const orders: Fill[] = rows.map((r) => ({
      symbol: pairBase(r.pair),
      action: r.type,
      price: r.price,
      vol: r.vol,
      notional: r.cost,
      fee: r.fee,
      leveraged: (r.margin || 0) > 0,
      time: r.time.toISOString(),
    }));

    const totalFees = orders.reduce((s, o) => s + (o.fee || 0), 0);
    const totalNotional = orders.reduce((s, o) => s + (o.notional || 0), 0);

    return Response.json({
      orders,
      summary: { total: orders.length, totalFees, totalNotional },
    });
  } catch (error) {
    // Graceful: a missing/empty table shouldn't 500 the page.
    console.error("[/api/orders/all]", error);
    return Response.json({ orders: [], summary: { total: 0, totalFees: 0, totalNotional: 0 } });
  }
}
