import { runDipScan } from "@/lib/crypto-dip-scanner";
import { prisma } from "@/lib/db";

export const maxDuration = 60;

// Crypto dip scanner cron — refreshes the oversold/pullback signals for the watchlist (XRP, SOL,
// DOGE, BTC, ETH, ...). READ-ONLY detection (no trading). Runs 24/7 (crypto never closes).
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await prisma.agentConfig
      .upsert({
        where: { key: "crypto_dip_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "crypto_dip_cron_last_run", value: new Date().toISOString() },
      })
      .catch(() => {});
    const result = await runDipScan();
    return Response.json({ count: result.rows.length, ts: result.ts });
  } catch (error) {
    console.error("[/api/cron/crypto-dip]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
