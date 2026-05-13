import { prisma } from "@/lib/db";

export async function GET() {
  try {
    // Get recent trades (last 24 hours)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [trades, runs] = await Promise.all([
      prisma.autoTradeLog.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.agentRun.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    // Build activity feed
    const activity = [
      ...trades.map((t) => ({
        type: t.action.includes("skip") || t.action.includes("veto") ? "info" as const : t.pnl && t.pnl > 0 ? "success" as const : t.pnl && t.pnl < 0 ? "loss" as const : "trade" as const,
        symbol: t.symbol,
        action: t.action,
        qty: t.qty,
        price: t.price,
        pnl: t.pnl,
        reason: t.reason,
        score: t.aiScore,
        signal: t.aiSignal,
        time: t.createdAt,
      })),
      ...runs.map((r) => ({
        type: "run" as const,
        symbol: "",
        action: "agent_run",
        qty: 0,
        price: null,
        pnl: null,
        reason: r.summary,
        score: null,
        signal: null,
        time: r.createdAt,
      })),
    ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

    return Response.json(activity);
  } catch (error) {
    console.error("[/api/agent/activity]", error);
    return Response.json([]);
  }
}
