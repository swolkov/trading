import { prisma } from "@/lib/db";

// Engine decision feed — every setup the realtime engines graded (confirmed AND killed),
// written by recordDecision() in futures-realtime.ts as a 40-entry ring buffer per mode.
export async function GET() {
  try {
    const rows = await prisma.agentConfig.findMany({
      where: { key: { in: ["engine_decisions_demo", "engine_decisions_live"] } },
    });
    const parse = (key: string) => {
      try {
        const v = rows.find((r) => r.key === key)?.value;
        const arr = JSON.parse(v || "[]");
        return Array.isArray(arr) ? arr : [];
      } catch { return []; }
    };
    return Response.json({
      demo: parse("engine_decisions_demo"),
      live: parse("engine_decisions_live"),
    });
  } catch (error) {
    console.error("[/api/futures/decisions]", error);
    return Response.json({ demo: [], live: [] });
  }
}
