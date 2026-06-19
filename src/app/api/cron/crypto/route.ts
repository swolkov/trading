import { runCryptoAgent } from "@/lib/crypto-agent";
import { prisma } from "@/lib/db";

export const maxDuration = 300;

// Crypto agent cron — runs on schedule to scan and trade crypto 24/7.
// Unlike futures, there's no real-time engine to defer to.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Write heartbeat
    try {
      await prisma.agentConfig.upsert({
        where: { key: "crypto_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "crypto_cron_last_run", value: new Date().toISOString() },
      });
    } catch {}

    // Daily equity snapshot for the $1K paper day-trade test (stocks + crypto share this Alpaca
    // account). Written HERE because the sealed Alpaca keys only resolve server-side. Upsert per-day
    // so it settles to the EOD value — mirrors the futures eod_balance pattern, so the shared pool
    // lands on the scoreboard as clean balance-delta P&L. Best-effort; never breaks the cron.
    try {
      const { getAccount } = await import("@/lib/alpaca");
      const acct = await getAccount("paper");
      const eq = parseFloat(acct.equity);
      if (isFinite(eq) && eq > 0) {
        const today = new Date().toISOString().slice(0, 10);
        await prisma.agentConfig.upsert({
          where: { key: `alpaca_test_eod_${today}` },
          update: { value: String(eq) },
          create: { key: `alpaca_test_eod_${today}`, value: String(eq) },
        });
      }
    } catch {}

    // One-off paper reset: if a flatten was requested (DB flag), do it here where the sealed
    // Alpaca keys resolve. No-op on every normal run.
    let flatten: string | null = null;
    try {
      const { maybeFlattenPaper } = await import("@/lib/paper-reset");
      flatten = await maybeFlattenPaper();
      if (flatten) console.log("[/api/cron/crypto]", flatten);
    } catch {}

    const result = await runCryptoAgent();
    return Response.json({ ...result, flatten });
  } catch (error) {
    console.error("[/api/cron/crypto]", error);
    try {
      const { sendNotification } = await import("@/lib/notifications");
      await sendNotification(`CRON CRASH: /api/cron/crypto — ${String(error).slice(0, 200)}`, "general");
    } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
