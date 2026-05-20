import { prisma } from "@/lib/db";

export async function POST() {
  try {
    // Delete backfilled entries with wrong P&L estimates
    const deleted = await prisma.autoTradeLog.deleteMany({
      where: {
        symbol: { startsWith: "FUT:" },
        reason: { contains: "backfill" },
      },
    });

    // Delete duplicate/bad sync entries from today's chaos
    // (entries where syncPositions estimated P&L from price proximity)
    const badSyncs = await prisma.autoTradeLog.deleteMany({
      where: {
        symbol: { startsWith: "FUT:" },
        reason: { contains: "bracket_close" },
      },
    });

    // Clear saved positions for both demo and live engines
    await prisma.agentConfig.upsert({
      where: { key: "futures_positions_demo" },
      update: { value: "{}" },
      create: { key: "futures_positions_demo", value: "{}" },
    });
    await prisma.agentConfig.upsert({
      where: { key: "futures_positions_live" },
      update: { value: "{}" },
      create: { key: "futures_positions_live", value: "{}" },
    });

    return Response.json({
      backfillDeleted: deleted.count,
      badSyncsDeleted: badSyncs.count,
      positionsCleared: true,
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
