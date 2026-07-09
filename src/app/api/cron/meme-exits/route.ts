import { manageMemeExits } from "@/lib/meme-scanner";
import { prisma } from "@/lib/db";

export const maxDuration = 120;   // real Solana sells can take 10-30s each

// Fast exit-manager — runs EVERY MINUTE. Meme coins move in seconds, so stop-loss / trail / rug
// exits can't wait for the 10-min entry scan. This only manages OPEN positions (checks prices, sells
// on trigger) — no new-pool scanning, no AI calls, so it's cheap. Entries stay on /api/cron/meme-scan.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await prisma.agentConfig.upsert({
      where: { key: "meme_exits_cron_last_run" },
      update: { value: new Date().toISOString() },
      create: { key: "meme_exits_cron_last_run", value: new Date().toISOString() },
    }).catch(() => {});
    const result = await manageMemeExits();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/cron/meme-exits]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
