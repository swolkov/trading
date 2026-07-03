import { prisma } from "@/lib/db";

// Engine decision feed — every setup the realtime engines graded (confirmed AND killed),
// written by recordDecision() in futures-realtime.ts as a 40-entry ring buffer per mode.
// Each BLOCKED decision is enriched with its shadow-tracker outcome (the counterfactual $/R
// that trade would have made) by matching the durable ShadowTrade rows on symbol + setup + time.
export async function GET() {
  try {
    const rows = await prisma.agentConfig.findMany({
      where: { key: { in: ["engine_decisions_demo", "engine_decisions_live"] } },
    });
    // Recent shadow trades to match against. Written at the same instant as the ring-buffer
    // entry, so a symbol+setup+direction match within ~20s is unambiguous.
    const shadows = await prisma.shadowTrade.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const parse = (key: string, mode: "demo" | "live") => {
      let arr: Array<Record<string, unknown>> = [];
      try {
        const v = rows.find((r) => r.key === key)?.value;
        const p = JSON.parse(v || "[]");
        arr = Array.isArray(p) ? p : [];
      } catch { arr = []; }
      const modeShadows = shadows.filter((s) => s.mode === mode);
      return arr.map((d) => {
        // Only blocked verdicts have a shadow counterfactual (confirmed setups actually traded).
        if (d.verdict === "confirmed") return d;
        const dts = new Date(String(d.ts)).getTime();
        const match = modeShadows.find(
          (s) =>
            s.symbol === d.sym &&
            s.setupType === d.setupType &&
            s.direction === d.direction &&
            Math.abs(new Date(s.createdAt).getTime() - dts) < 20_000,
        );
        if (!match) return d;
        return {
          ...d,
          shadow: {
            status: match.status,                 // open | win | loss | expired
            rMultiple: match.rMultiple,
            dollarPnl: match.dollarPnl,
            contracts: match.contracts,
            exitReason: match.exitReason,
          },
        };
      });
    };

    return Response.json({
      demo: parse("engine_decisions_demo", "demo"),
      live: parse("engine_decisions_live", "live"),
    });
  } catch (error) {
    console.error("[/api/futures/decisions]", error);
    return Response.json({ demo: [], live: [] });
  }
}
