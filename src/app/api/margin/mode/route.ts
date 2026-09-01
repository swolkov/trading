import { prisma } from "@/lib/db";

// The margin executor's real-money arm state — the ONLY live-money path now (the spot trend
// bot is retired). Real orders flow only when kraken_margin_auto="true" AND validate-only is
// explicitly off. Everything else (unset/default) is paper/tracked. The sidebar badge reads
// this so it accurately warns when real money is armed, instead of the dead bot's status.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await prisma.agentConfig.findMany({
      where: { key: { in: ["kraken_margin_auto", "kraken_margin_validate_only"] } },
    });
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const auto = m["kraken_margin_auto"] === "true";
    // validate-only defaults ON (safe) unless explicitly "false".
    const validateOnly = m["kraken_margin_validate_only"] !== "false";
    const armed = auto && !validateOnly;
    return Response.json({ armed, auto, validateOnly });
  } catch {
    // Fail SAFE: if we can't read the flags, report NOT armed (never falsely show "live").
    return Response.json({ armed: false, auto: false, validateOnly: true });
  }
}
