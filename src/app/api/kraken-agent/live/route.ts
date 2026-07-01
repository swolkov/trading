import { prisma } from "@/lib/db";

// Password-gated arm/disarm for the Kraken accumulator's REAL-MONEY buying.
// live=true  -> kraken_validate_only=false (real buys on the next cron)
// live=false -> kraken_validate_only=true  (safe: validate only, no spend)
// Uses the same live-trading password as the futures kill switch, so only the owner can flip it.
const LIVE_PASSWORD = process.env.LIVE_TRADING_PASSWORD || "golive";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { password, live } = body as { password?: string; live?: boolean };
    if (!password || password !== LIVE_PASSWORD) {
      return Response.json({ error: "Incorrect password" }, { status: 403 });
    }
    const value = live ? "false" : "true";
    await prisma.agentConfig.upsert({
      where: { key: "kraken_validate_only" },
      update: { value },
      create: { key: "kraken_validate_only", value },
    });
    await prisma.agentConfig
      .upsert({
        where: { key: "kraken_live_last_event" },
        update: { value: JSON.stringify({ at: new Date().toISOString(), live: !!live }) },
        create: { key: "kraken_live_last_event", value: JSON.stringify({ at: new Date().toISOString(), live: !!live }) },
      })
      .catch(() => {});
    return Response.json({ ok: true, live: value === "false", validateOnly: value === "true" });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
