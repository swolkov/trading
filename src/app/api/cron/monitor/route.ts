import { getPositions, getMarketClock } from "@/lib/alpaca";
import { manageOptionsPositions } from "@/lib/options-trader";
import { defendPremiumPosition } from "@/lib/premium-seller";
import { getAccount } from "@/lib/alpaca";
import { sendNotification } from "@/lib/notifications";
import { prisma } from "@/lib/db";

export const maxDuration = 60; // lightweight — 1 minute max

// ============ POSITION MONITOR ============
// Runs frequently (every 15 min) to watch positions for:
// - Stop losses being hit
// - Profit targets reached
// - Expiring options
// - Premium positions being tested
// Does NOT scan for new trades — that's the full agent's job.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const clock = await getMarketClock();
    if (!clock.is_open) {
      return Response.json({ status: "market_closed", actions: 0 });
    }

    const positions = await getPositions();
    if (positions.length === 0) {
      return Response.json({ status: "no_positions", actions: 0 });
    }

    const account = await getAccount();
    const equity = parseFloat(account.equity);
    let actions = 0;
    const details: string[] = [];

    for (const pos of positions) {
      const isOptions = pos.symbol.length > 10;
      if (!isOptions) continue; // stock positions managed by full agent

      const qty = parseInt(pos.qty);
      const isShort = qty < 0;

      if (isShort) {
        // Premium position — check if strike is being tested
        try {
          const defense = await defendPremiumPosition(pos, equity);
          if (defense.action !== "hold") {
            actions++;
            details.push(`${pos.symbol}: ${defense.action} — ${defense.details}`);
          }
        } catch { /* ignore */ }
      } else {
        // Long options — check stops and profits
        const optActions = await manageOptionsPositions([pos]);
        for (const act of optActions) {
          if (act.action !== "hold") {
            actions++;
            details.push(`${act.symbol}: ${act.action} — ${act.reason}`);
          }
        }
      }
    }

    // Alert if any actions were taken
    if (actions > 0) {
      await sendNotification(`Position Monitor: ${actions} action(s) taken\n${details.join("\n")}`);
    }

    return Response.json({ status: "ok", positions: positions.length, actions, details });
  } catch (error) {
    console.error("[/api/cron/monitor]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
