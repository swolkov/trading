import { runPortfolioRiskCheck } from "@/lib/portfolio-risk-agent";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";

export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runPortfolioRiskCheck();
    await prisma.agentConfig.upsert({ where: { key: "risk_last_run" }, update: { value: new Date().toISOString() }, create: { key: "risk_last_run", value: new Date().toISOString() } }).catch(() => {});
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/risk]", error);
    try { await sendNotification(`🚨 RISK CRON CRASH: ${error instanceof Error ? error.message : "Unknown"}`, "general"); } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
