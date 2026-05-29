import { prisma } from "@/lib/db";

/**
 * Master kill switch — sets trading_mode_futures to "disabled" so the engine stops firing
 * new trades immediately. Existing open positions are NOT closed (would need a separate
 * "panic close all" action). Engines pick up the change on their next config-refresh cycle
 * (~30s).
 *
 * Use case: $1K live account, you see something going wrong and need to stop NEW trades
 * without rushing into the broker app.
 *
 * Auth: requires the live password (same as activating live trading), so this can't be
 * triggered accidentally.
 */

const LIVE_PASSWORD = process.env.LIVE_TRADING_PASSWORD || "golive";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { password, action } = body as { password?: string; action?: "kill" | "restore" };

    if (!password || password !== LIVE_PASSWORD) {
      return Response.json({ error: "Password required" }, { status: 403 });
    }

    if (action === "kill") {
      // Disable futures trading completely
      await prisma.agentConfig.upsert({
        where: { key: "trading_mode_futures" },
        update: { value: "disabled" },
        create: { key: "trading_mode_futures", value: "disabled" },
      });
      // Record the kill event
      await prisma.agentConfig.upsert({
        where: { key: "kill_switch_last_event" },
        update: { value: JSON.stringify({ at: new Date().toISOString(), action: "kill" }) },
        create: { key: "kill_switch_last_event", value: JSON.stringify({ at: new Date().toISOString(), action: "kill" }) },
      });
      return Response.json({ status: "killed", tradingMode: "disabled" });
    }

    if (action === "restore") {
      // Restore to paper (demo) — never auto-restore to live
      await prisma.agentConfig.upsert({
        where: { key: "trading_mode_futures" },
        update: { value: "paper" },
        create: { key: "trading_mode_futures", value: "paper" },
      });
      await prisma.agentConfig.upsert({
        where: { key: "kill_switch_last_event" },
        update: { value: JSON.stringify({ at: new Date().toISOString(), action: "restore" }) },
        create: { key: "kill_switch_last_event", value: JSON.stringify({ at: new Date().toISOString(), action: "restore" }) },
      });
      return Response.json({ status: "restored", tradingMode: "paper" });
    }

    return Response.json({ error: "action must be 'kill' or 'restore'" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
