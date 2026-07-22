import { prisma } from "@/lib/db";

export async function POST(request: Request) {
  // Require the trading mode password for safety
  const body = await request.json().catch(() => ({}));
  const password = body.password;

  if (!process.env.TRADING_MODE_PASSWORD || password !== process.env.TRADING_MODE_PASSWORD) {
    return Response.json({ error: "Incorrect password" }, { status: 403 });
  }

  // SAFETY: never delete LIVE real-money trades — that would wipe the authoritative track record.
  // This reset only clears demo/paper + non-live rows. (Was an unfiltered deleteMany — a footgun.)
  const a = await prisma.autoTradeLog.deleteMany({ where: { NOT: { action: { startsWith: "live_" } } } });
  const b = await prisma.agentRun.deleteMany({});
  const c = await prisma.researchReport.deleteMany({});
  const d = await prisma.tradeIdea.deleteMany({});
  const e = await prisma.chatMessage.deleteMany({});

  return Response.json({
    success: true,
    deleted: {
      trades: a.count,
      runs: b.count,
      reports: c.count,
      ideas: d.count,
      chats: e.count,
    },
  });
}
