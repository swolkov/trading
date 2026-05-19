import { prisma } from "@/lib/db";
import { invalidateViewCache } from "@/lib/trading-mode";

// ============ VIEW MODE API ============
// Controls which account data the dashboard DISPLAYS (demo vs live).
// Freely switchable — no password needed. This does NOT affect agent execution.
// Agent execution mode is controlled separately via /agents config page
// which writes to trading_mode_* keys.

const VALID_TYPES = ["options", "futures", "stocks", "crypto"] as const;

export async function GET() {
  try {
    const modes: Record<string, string> = {};
    for (const type of VALID_TYPES) {
      const config = await prisma.agentConfig.findUnique({ where: { key: `view_mode_${type}` } });
      modes[type] = config?.value || "paper";
    }

    return Response.json({ modes });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

const LIVE_PASSWORD = process.env.LIVE_TRADING_PASSWORD || "golive";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type, mode, password } = body;

    // Validate type
    if (!VALID_TYPES.includes(type)) {
      return Response.json({ error: `Invalid type: ${type}. Must be: ${VALID_TYPES.join(", ")}` }, { status: 400 });
    }

    // Validate mode
    if (mode !== "paper" && mode !== "live") {
      return Response.json({ error: "Mode must be 'paper' or 'live'" }, { status: 400 });
    }

    // If activating live trading, require password and set BOTH view + trading mode
    if (mode === "live" && password) {
      if (password !== LIVE_PASSWORD) {
        return Response.json({ error: "Incorrect password" }, { status: 403 });
      }
      // Set trading mode (engine reads this for live execution)
      await prisma.agentConfig.upsert({
        where: { key: `trading_mode_${type}` },
        update: { value: "live" },
        create: { key: `trading_mode_${type}`, value: "live" },
      });
    } else if (mode === "paper" && password) {
      // Deactivating live — set trading mode back to paper
      await prisma.agentConfig.upsert({
        where: { key: `trading_mode_${type}` },
        update: { value: "paper" },
        create: { key: `trading_mode_${type}`, value: "paper" },
      });
    }

    // Always update view mode
    await prisma.agentConfig.upsert({
      where: { key: `view_mode_${type}` },
      update: { value: mode },
      create: { key: `view_mode_${type}`, value: mode },
    });

    // Invalidate server-side cache so next API call uses new mode immediately
    invalidateViewCache(type);

    const isLiveActivation = mode === "live" && password;
    const message = isLiveActivation
      ? `LIVE TRADING ACTIVATED for ${type} — engine will mirror trades within 5 minutes`
      : `${type} ${mode === "live" ? "view" : "mode"} switched to ${mode.toUpperCase()}`;

    return Response.json({ success: true, type, mode, message });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
