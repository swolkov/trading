import { getPositions, getMarketClock } from "@/lib/alpaca";
import { manageOptionsPositions } from "@/lib/options-trader";
import { defendPremiumPosition } from "@/lib/premium-seller";
import { getAccount } from "@/lib/alpaca";
import { sendNotification } from "@/lib/notifications";
import { prisma } from "@/lib/db";

export const maxDuration = 60;

// ============ POSITION MONITOR ============
// Runs every 15 min. Watches positions for stops, profits, premium defense.
// Spread-aware: paired legs are skipped (managed by full agent as units).

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();

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

    // Detect spread legs — skip them (full agent manages spreads as units)
    const spreadLegs = new Set<string>();
    const optPositions = positions.filter((p) => p.symbol.length > 10);
    for (const pos of optPositions) {
      const match = pos.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      if (!match) continue;
      const [, underlying, expDate, optType] = match;
      const qty = parseInt(pos.qty);

      const partner = optPositions.find((p) => {
        if (p.symbol === pos.symbol) return false;
        const m = p.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        if (!m) return false;
        const pQty = parseInt(p.qty);
        return m[1] === underlying && m[2] === expDate && m[3] === optType &&
          ((qty > 0 && pQty < 0) || (qty < 0 && pQty > 0));
      });

      if (partner) {
        spreadLegs.add(pos.symbol);
        spreadLegs.add(partner.symbol);
      }
    }

    for (const pos of positions) {
      const isOptions = pos.symbol.length > 10;
      if (!isOptions) continue;

      // Skip spread legs — managed by full agent
      if (spreadLegs.has(pos.symbol)) continue;

      const qty = parseInt(pos.qty);
      const isShort = qty < 0;

      if (isShort) {
        try {
          const defense = await defendPremiumPosition(pos, equity);
          if (defense.action !== "hold") {
            actions++;
            details.push(`${pos.symbol}: ${defense.action} — ${defense.details}`);
          }
        } catch { /* ignore */ }
      } else {
        const optActions = await manageOptionsPositions([pos]);
        for (const act of optActions) {
          if (act.action !== "hold") {
            actions++;
            details.push(`${act.symbol}: ${act.action} — ${act.reason}`);
          }
        }
      }
    }

    if (actions > 0) {
      await sendNotification(`Position Monitor: ${actions} action(s) taken\n${details.join("\n")}`);
    }

    // Log every run so it shows in activity feed
    await prisma.agentRun.create({
      data: {
        runType: "monitor",
        stocksScanned: 0,
        tradesPlaced: actions,
        positionsManaged: positions.length - spreadLegs.size, // standalone only
        errors: 0,
        summary: `Monitor: ${positions.length} positions (${spreadLegs.size / 2} spreads skipped), ${actions} actions${actions > 0 ? ": " + details.join(", ") : ""}`,
        durationMs: Date.now() - startTime,
      },
    });

    return Response.json({ status: "ok", positions: positions.length, spreadsSkipped: spreadLegs.size / 2, actions, details });
  } catch (error) {
    console.error("[/api/cron/monitor]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
