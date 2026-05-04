import { prisma } from "@/lib/db";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "50");
    const type = searchParams.get("type"); // runs or trades

    if (type === "runs") {
      const runs = await prisma.agentRun.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return Response.json(runs);
    }

    const trades = await prisma.autoTradeLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return Response.json(trades);
  } catch (error) {
    console.error("[/api/agent/logs]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
