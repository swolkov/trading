import { prisma } from "@/lib/db";
import { getPositions } from "@/lib/alpaca";

// Read-only dashboard view of the long-term DCA pillar (buy-and-hold SPY), plus a simple
// enable/disable toggle. No CRON_SECRET — this mirrors /api/account (a public read for the UI).
// Holdings source of truth = the LIVE Alpaca position; Alpaca calls are wrapped so a missing
// position or absent live keys yields an empty state (holding=null), never a 500.

const DEFAULT_SYMBOL = "SPY";
const DEFAULT_AMOUNT = 50;

interface Holding {
  qty: number;
  avgPrice: number;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPl: number;
  unrealizedPlpc: number;
}

export async function GET() {
  try {
    const rows = await prisma.agentConfig.findMany({
      where: { key: { in: ["dca_enabled", "dca_symbol", "dca_amount_usd", "dca_mode", "dca_cron_last_run"] } },
    });
    const c: Record<string, string> = {};
    for (const r of rows) c[r.key] = r.value;

    const enabled = c.dca_enabled === "true";
    const symbol = (c.dca_symbol || DEFAULT_SYMBOL).toUpperCase();
    const amountUsd = parseFloat(c.dca_amount_usd) || DEFAULT_AMOUNT;
    const lastRun = c.dca_cron_last_run || null;

    // Buy history — STK:<symbol> rows whose action starts with dca_buy.
    const buys = await prisma.autoTradeLog.findMany({
      where: { symbol: `STK:${symbol}`, action: { startsWith: "dca_buy" } },
      orderBy: { createdAt: "desc" },
      select: { reason: true, createdAt: true },
    });
    const buyCount = buys.length;
    const recentBuys = buys.slice(0, 10).map((b) => ({ at: b.createdAt.toISOString(), reason: b.reason }));

    // Holdings — the LIVE Alpaca position. Best-effort: empty state on any failure.
    let holding: Holding | null = null;
    try {
      const positions = await getPositions("live");
      const pos = positions.find((p) => p.symbol.toUpperCase() === symbol);
      if (pos) {
        holding = {
          qty: parseFloat(pos.qty),
          avgPrice: parseFloat(pos.avg_entry_price),
          currentPrice: parseFloat(pos.current_price),
          marketValue: parseFloat(pos.market_value),
          costBasis: parseFloat(pos.cost_basis),
          unrealizedPl: parseFloat(pos.unrealized_pl),
          unrealizedPlpc: parseFloat(pos.unrealized_plpc),
        };
      }
    } catch (e) {
      console.warn("[/api/longterm] live position unavailable:", e instanceof Error ? e.message : String(e));
    }

    return Response.json({
      enabled,
      symbol,
      amountUsd,
      lastRun,
      schedule: "Weekly (Mon, market open)",
      holding,
      totalInvested: holding ? holding.costBasis : 0,
      buyCount,
      recentBuys,
    });
  } catch (error) {
    console.error("[/api/longterm]", error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// Toggle the DCA engine on/off. This controls REAL-MONEY weekly buys, so it's intentionally explicit.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { enabled } = body as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return Response.json({ error: "body must be { enabled: boolean }" }, { status: 400 });
    }
    const value = enabled ? "true" : "false";
    await prisma.agentConfig.upsert({
      where: { key: "dca_enabled" },
      update: { value },
      create: { key: "dca_enabled", value },
    });
    return Response.json({ enabled });
  } catch (error) {
    console.error("[/api/longterm POST]", error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
