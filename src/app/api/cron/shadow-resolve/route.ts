import { resolveOpenShadowTrades } from "@/lib/shadow-tracker";
import { prisma } from "@/lib/db";

export const maxDuration = 120;

// AI-Veto Shadow Tracker resolver. Marks every vetoed/blocked futures setup to real
// price and scores the counterfactual. Read-only against the market — never trades.
// Scheduled every 10 min (see vercel.json).
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await resolveOpenShadowTrades();
    await prisma.agentConfig
      .upsert({
        where: { key: "shadow_resolve_last_run" },
        update: { value: JSON.stringify({ ts: new Date().toISOString(), ...result }) },
        create: { key: "shadow_resolve_last_run", value: JSON.stringify({ ts: new Date().toISOString(), ...result }) },
      })
      .catch(() => {});
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/shadow-resolve]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
