import { prisma } from "@/lib/db";

// ============ TRADING MODE API ============
// Password-protected switching between paper and live trading.
// Modes are stored per trade type: options, futures, stocks.
// Password is stored in TRADING_MODE_PASSWORD env var.

const VALID_TYPES = ["options", "futures", "stocks"] as const;

export async function GET() {
  try {
    const modes: Record<string, string> = {};
    for (const type of VALID_TYPES) {
      const config = await prisma.agentConfig.findUnique({ where: { key: `trading_mode_${type}` } });
      modes[type] = config?.value || "paper";
    }

    return Response.json({
      modes,
      // Never expose which are actually configured — just show what's active
      hasLiveKeys: {
        options: !!(process.env.ALPACA_LIVE_API_KEY && process.env.ALPACA_LIVE_API_SECRET),
        futures: !!process.env.TRADOVATE_USERNAME,
        stocks: !!(process.env.ALPACA_LIVE_API_KEY && process.env.ALPACA_LIVE_API_SECRET),
      },
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type, mode, password } = body;

    // Validate password (switching to DEMO/paper is always allowed — it's the safe direction)
    const correctPassword = process.env.TRADING_MODE_PASSWORD;
    if (mode === "live") {
      if (!correctPassword) {
        return Response.json({ error: "TRADING_MODE_PASSWORD env var not set. Set it in Vercel to enable live mode." }, { status: 403 });
      }
      if (password !== correctPassword) {
        return Response.json({ error: "Incorrect password" }, { status: 403 });
      }
    }

    // Validate type
    if (!VALID_TYPES.includes(type)) {
      return Response.json({ error: `Invalid type: ${type}. Must be: ${VALID_TYPES.join(", ")}` }, { status: 400 });
    }

    // Validate mode
    if (mode !== "paper" && mode !== "live") {
      return Response.json({ error: "Mode must be 'paper' or 'live'" }, { status: 400 });
    }

    // Check if live keys exist before allowing switch to live
    if (mode === "live") {
      if ((type === "options" || type === "stocks") && (!process.env.ALPACA_LIVE_API_KEY || !process.env.ALPACA_LIVE_API_SECRET)) {
        return Response.json({ error: "Cannot switch to live: ALPACA_LIVE_API_KEY and ALPACA_LIVE_API_SECRET env vars not set" }, { status: 400 });
      }
      if (type === "futures" && !process.env.TRADOVATE_USERNAME) {
        return Response.json({ error: "Cannot switch to live: Tradovate credentials not configured" }, { status: 400 });
      }
    }

    // Update the mode
    await prisma.agentConfig.upsert({
      where: { key: `trading_mode_${type}` },
      update: { value: mode },
      create: { key: `trading_mode_${type}`, value: mode },
    });

    return Response.json({ success: true, type, mode, message: `${type} trading switched to ${mode.toUpperCase()}` });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
