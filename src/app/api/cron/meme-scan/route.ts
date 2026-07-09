import { runMemeScan } from "@/lib/meme-scanner";
import { prisma } from "@/lib/db";

export const maxDuration = 300;   // real Solana swaps can take 10-30s each to confirm — give headroom

// Meme Lab observation cron — scans new/trending Solana pools, paper-trades survivors, manages exits.
// PAPER ONLY: no exchange, no keys, no real money. Runs every 10 min (memes move fast but a slow
// retail bot is exactly what we're measuring, so 10-min cadence is the honest achievable reality).
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await prisma.agentConfig.upsert({
      where: { key: "meme_scan_cron_last_run" },
      update: { value: new Date().toISOString() },
      create: { key: "meme_scan_cron_last_run", value: new Date().toISOString() },
    }).catch(() => {});
    const result = await runMemeScan();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/meme-scan]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
